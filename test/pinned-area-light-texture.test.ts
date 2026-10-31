import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import {
    areaLightTextureObservedGlobal,
    bakeAreaLightTexture,
    runAreaLightTexturePage,
} from "../src/pinned-area-light-texture.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

type Color = readonly [number, number, number, number];

/** Image quadrants, image row 0 at the top: [red, green, blue, alpha]. */
const topLeft: Color = [255, 0, 0, 255];
const topRight: Color = [0, 255, 0, 200];
const bottomLeft: Color = [0, 0, 255, 160];
const bottomRight: Color = [255, 255, 255, 96];

/** An 8x8 RGBA PNG whose four quadrants differ in every channel. */
function quadrantPng(
    quadrants: readonly [Color, Color, Color, Color],
): Uint8Array {
    const size = 8;
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const quadrant = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1);
            png.data.set(quadrants[quadrant]!, (y * size + x) * 4);
        }
    }
    return new Uint8Array(PNG.sync.write(png));
}

function texel(
    level: Uint8Array,
    width: number,
    x: number,
    y: number,
): number[] {
    const index = (y * width + x) * 4;
    return [...level.subarray(index, index + 4)];
}

function assertSameBytes(
    actual: Uint8Array,
    expected: Uint8Array,
    what: string,
): void {
    assert.equal(actual.byteLength, expected.byteLength, `${what}: length`);
    const at = actual.findIndex((value, index) => value !== expected[index]);
    assert.equal(
        at,
        -1,
        `${what}: first difference at byte ${at} (${actual[at]} vs ${expected[at]}).`,
    );
}

/** Page code beside the driver: the pin's scaled read-back and its blurred
 *  level-zero upload, as the processor's own labels name them. */
const observer = `
{
    const observed = {};
    window.${areaLightTextureObservedGlobal} = observed;
    const getMappedRange = GPUBuffer.prototype.getMappedRange;
    const writeTexture = GPUQueue.prototype.writeTexture;
    GPUBuffer.prototype.getMappedRange = function (...args) {
        const range = getMappedRange.apply(this, args);
        if (this.label === "texture-pixels-readback") observed.scaled = bblBase64(new Uint8Array(range));
        return range;
    };
    GPUQueue.prototype.writeTexture = function (destination, data, layout, size) {
        if (destination.texture.label === "rect-area-emission") {
            observed.uploaded = bblBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        return writeTexture.call(this, destination, data, layout, size);
    };
}
`;

function decodeObserved(
    value: unknown,
): Record<"scaled" | "uploaded", Uint8Array> {
    assert.ok(
        typeof value === "object" &&
            value !== null &&
            "scaled" in value &&
            "uploaded" in value,
        "The observer saw no scaled read-back or upload.",
    );
    const { scaled, uploaded } = value;
    assert.ok(typeof scaled === "string" && typeof uploaded === "string");
    const bytes = (text: string): Uint8Array =>
        new Uint8Array(Buffer.from(text, "base64"));
    return { scaled: bytes(scaled), uploaded: bytes(uploaded) };
}

test("executes the pinned processAreaLightTexture and reads back its full chain", async () => {
    const source = quadrantPng([topLeft, topRight, bottomLeft, bottomRight]);
    const loaderOptions = { srgb: false };
    const processed = await bakeAreaLightTexture(source, loaderOptions);
    assert.equal(processed.width, 1024);
    assert.equal(processed.height, 1024);
    assert.equal(processed.levels.length, 11);
    processed.levels.forEach((level, mip) =>
        assert.equal(level.byteLength, (1024 >> mip) ** 2 * 4, `level ${mip}`),
    );

    // Storage row 0 samples Y-up source V=0: the upload flipped the image,
    // so low rows hold its bottom half. Quadrant centers sit where the
    // (uv-0.125)/0.75 scale puts source UV 0.25 and 0.75: texels 320 and 704.
    const [level0, level1] = processed.levels;
    assert.ok(level0 && level1);
    assert.deepEqual(texel(level0, 1024, 320, 320), bottomLeft);
    assert.deepEqual(texel(level0, 1024, 704, 320), bottomRight);
    assert.deepEqual(texel(level0, 1024, 320, 704), topLeft);
    assert.deepEqual(texel(level0, 1024, 704, 704), topRight);
    // The mip blitter keeps the orientation.
    assert.deepEqual(texel(level1, 512, 160, 160), bottomLeft);
    assert.deepEqual(texel(level1, 512, 352, 352), topRight);

    // The pin's own CPU blur over the pin's own scaled image, in Node,
    // reproduces level zero exactly: the blur is the only step between the
    // two, and it leaves alpha alone.
    const run = await runAreaLightTexturePage(source, loaderOptions, observer);
    const observed = decodeObserved(run.observed);
    const [observedLevel0] = run.processed.levels;
    assert.ok(observedLevel0);
    assert.equal(observed.scaled.byteLength, 1024 * 1024 * 4);
    assert.notEqual(
        Buffer.compare(observed.scaled, observed.uploaded),
        0,
        "The blur changed the scaled image.",
    );
    const { blurAreaLightPixels } = await importPinnedModule<{
        blurAreaLightPixels: (input: Uint8Array) => Uint8Array;
    }>("light/area-light-blur.js");
    assertSameBytes(
        blurAreaLightPixels(observed.scaled),
        observed.uploaded,
        "Node blur vs the page's upload",
    );
    assertSameBytes(observedLevel0, observed.uploaded, "level 0 vs upload");
    run.processed.levels.forEach((level, mip) =>
        assertSameBytes(
            level,
            processed.levels[mip]!,
            `level ${mip} across runs`,
        ),
    );
    const alpha = (pixels: Uint8Array): Uint8Array =>
        pixels.filter((_, index) => index % 4 === 3);
    assertSameBytes(alpha(level0), alpha(observed.scaled), "alpha");
});

test("processes concurrently requested images in one page, each as it would alone", async () => {
    const loaderOptions = { srgb: false };
    const first = quadrantPng([topLeft, topRight, bottomLeft, bottomRight]);
    const second = quadrantPng([bottomRight, bottomLeft, topRight, topLeft]);
    const [alone] = (await bakeAreaLightTexture(second, loaderOptions)).levels;
    const [together, secondTogether] = await Promise.all([
        bakeAreaLightTexture(first, loaderOptions),
        bakeAreaLightTexture(second, loaderOptions),
    ]);
    assert.ok(alone && together && secondTogether);
    const [secondLevel0] = secondTogether.levels;
    const [firstLevel0] = together.levels;
    assert.ok(secondLevel0 && firstLevel0);
    assertSameBytes(
        secondLevel0,
        alone,
        "a batched image vs the same image alone",
    );
    // The second image is the first turned half a turn.
    assert.deepEqual(texel(firstLevel0, 1024, 320, 320), bottomLeft);
    assert.deepEqual(texel(secondLevel0, 1024, 320, 320), topRight);
    assert.deepEqual(texel(secondLevel0, 1024, 704, 704), bottomLeft);
});
