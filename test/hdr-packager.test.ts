import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    packageHdrEnvironment,
    parseRgbe,
    preScalePolynomial,
} from "../src/hdr-packager.js";
import {
    getHdrGgxPrefilterProvenance,
    prefilterCubemapGgx,
} from "../src/hdr-prefilter-gpu.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { readUpstreamPin } from "../src/upstream-source.js";

function smallHdr(): Uint8Array {
    const header = new TextEncoder().encode(
        "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n",
    );
    const pixels = new Uint8Array([
        64, 32, 16, 136,
        32, 64, 16, 136,
        16, 32, 64, 136,
        64, 64, 64, 136,
    ]);
    const result = new Uint8Array(header.length + pixels.length);
    result.set(header);
    result.set(pixels, header.length);
    return result;
}

function hdrBytes(
    width: number,
    height: number,
    pixels: readonly number[],
): Uint8Array {
    const header = new TextEncoder().encode(
        `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
    );
    const result = new Uint8Array(
        header.length + pixels.length,
    );
    result.set(header);
    result.set(pixels, header.length);
    return result;
}

function rleHdr(): Uint8Array {
    return hdrBytes(
        8,
        1,
        [
            2, 2, 0, 8,
            136, 64,
            136, 32,
            136, 16,
            136, 136,
        ],
    );
}

test("packages a deterministic HDR cubemap representation", async () => {
    const image = parseRgbe(smallHdr());
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual([...image.data.slice(0, 3)], [64, 32, 16]);

    const packaged = await packageHdrEnvironment(smallHdr(), 2);
    assert.deepEqual(
        [...packaged.slice(0, 8)],
        [0x42, 0x42, 0x4c, 0x48, 0x44, 0x52, 0x31, 0],
    );
    const view = new DataView(
        packaged.buffer,
        packaged.byteOffset,
        packaged.byteLength,
    );
    assert.equal(view.getUint32(8, true), 2);
    assert.equal(view.getUint32(12, true), 2);
    assert.equal(packaged.byteLength, 364);
    // The package is the pin executed (parseRGBE, computeSHFromEquirect, the
    // equirect-to-cube compute's own mip zero), so this golden is a drift
    // detector: a pin bump that changes any of it goes red here.
    assert.equal(
        createHash("sha256").update(packaged).digest("hex"),
        "3dda74b3d98e111a9ef0391ec917a5d4525ac354f20a016d548729dbe08d7e43",
    );
});

test("decodes valid HDR scanline RLE", () => {
    const image = parseRgbe(rleHdr());
    assert.equal(image.width, 8);
    assert.equal(image.height, 1);
    for (let pixel = 0; pixel < 8; pixel += 1) {
        assert.deepEqual(
            [...image.data.slice(pixel * 3, pixel * 3 + 3)],
            [64, 32, 16],
        );
    }
});

test("preScalePolynomial is the pinned pre-scale repacked to Color3 slots", async () => {
    // The pin executes `polynomialToPreScaledHarmonics` at stride four; the
    // package stores nine Color3 slots at stride three. Every lane must be
    // the pin's own store, moved and not recomputed.
    const { polynomialToPreScaledHarmonics } =
        await importPinnedModuleWithExports<{
            polynomialToPreScaledHarmonics: (
                polynomial: Float32Array,
            ) => Float32Array;
        }>("loader-gltf/ibl-env-assembly.js", [
            "polynomialToPreScaledHarmonics",
        ]);
    const polynomial = Float32Array.from(
        { length: 27 },
        (_, lane) => Math.sin(lane + 1) * (lane % 2 === 0 ? 1 : -0.5),
    );
    const pinned = polynomialToPreScaledHarmonics(polynomial);
    const repacked = preScalePolynomial(polynomial);
    assert.equal(pinned.length, 36);
    assert.equal(repacked.length, 27);
    for (let slot = 0; slot < 9; slot += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
            assert.equal(
                repacked[slot * 3 + channel],
                pinned[slot * 4 + channel],
                `harmonic ${slot} channel ${channel}`,
            );
        }
    }
});

test("rejects unsupported HDR cubemap dimensions", async () => {
    await assert.rejects(
        packageHdrEnvironment(smallHdr(), 3),
        /power of two/,
    );
});

test("preserves mip zero and deterministically applies pinned GGX semantics", async () => {
    const faceSize = 4;
    const faces = Array.from({ length: 6 }, (_, face) => {
        const pixels = new Uint16Array(faceSize * faceSize * 4);
        for (let pixel = 0; pixel < faceSize * faceSize; pixel += 1) {
            pixels[pixel * 4] = 0x3c00 + face * 16 + pixel;
            pixels[pixel * 4 + 1] = 0x3800 + pixel;
            pixels[pixel * 4 + 2] = 0x3400 + face;
            pixels[pixel * 4 + 3] = 0x3c00;
        }
        return pixels;
    });
    const first = await prefilterCubemapGgx(faceSize, 3, { faces });
    const second = await prefilterCubemapGgx(faceSize, 3, { faces });
    // Level zero round-trips through the GPU source texture now, so the
    // content is preserved while the arrays are fresh.
    assert.deepEqual(first[0], faces);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first[1]![0], faces[0]!.slice(0, first[1]![0]!.length));

    const digest = createHash("sha256");
    for (const mip of first) {
        for (const face of mip) digest.update(new Uint8Array(face.buffer));
    }
    assert.equal(
        digest.digest("hex"),
        "1c33fe95c972aea59fb51fd9bfacae79ed084b9523cbc3270b4f468fd22c4755",
    );
    const pin = readUpstreamPin();
    assert.deepEqual(getHdrGgxPrefilterProvenance(), {
        package: `${pin.package}@${pin.version}`,
        sourceCommit: pin.sourceVersion,
        module: "src/loader-hdr/hdr-ibl-pipeline.ts",
        shader: "shaders/hdr-prefilter-cube.compute.wgsl",
        sampleCount: 1024,
    });
});
