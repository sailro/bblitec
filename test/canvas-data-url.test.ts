import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { reachedImageCodecs } from "../src/image-codecs.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * `canvas.toDataURL(type, quality)` over a retained canvas's composed pixels:
 * the call, the codecs it links, and the encoder's types, quality and
 * data: URL as the browser gives them.
 */

const canvasProgram = (
    call: string,
): string => `import { createEngine, createBox } from "@babylonjs/lite";
    async function main(): Promise<void> {
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const pixels = new Uint8ClampedArray(8);
        context.putImageData(new ImageData(pixels, 2, 1), 0, 0);
        const quality = Math.random();
        console.log(${call});
        createBox(engine);
    }
    void main();
`;

test("toDataURL encodes a retained canvas through the PNG and JPEG codecs it links", () => {
    const jpeg = compileSource(
        canvasProgram(`canvas.toDataURL("image/jpeg", quality)`),
    );
    assert.ok(jpeg.manifest.features.includes("image:canvas-encode"));
    assert.match(
        jpeg.cpp,
        /bbl::ui_canvas_to_data_url\([^;]*, std::optional<std::string>\{"image\/jpeg"\}, std::optional<double>\{v_\w*quality\}\)/,
    );
    const png = compileSource(canvasProgram("canvas.toDataURL()"));
    assert.match(
        png.cpp,
        /bbl::ui_canvas_to_data_url\([^;]*, std::nullopt, std::nullopt\)/,
    );
    assert.deepEqual(
        reachedImageCodecs(
            resolve("artifacts/test-canvas-data-url"),
            [],
            ["image:canvas-encode"],
        ),
        ["png", "jpeg"],
    );
    assert.throws(
        () => compileSource(canvasProgram(`canvas.toDataURL("image/webp")`)),
        /canvas\.toDataURL\('image\/webp'\) is not encoded natively\./,
    );
    assert.throws(
        () =>
            compileSource(
                canvasProgram(`canvas.toDataURL("image/jpeg", "high")`),
            ),
        /canvas\.toDataURL quality must be a number\./,
    );
});

test("the canvas encoder gives the browser's data: URLs, types and JPEG quality", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-canvas-data-url");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/canvas-data-url-check.cpp"),
        resolve("native/src/pal_image.cpp"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
    ]);
    const lines = new Map(
        runFixtureExecutable(executable, {
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        })
            .trim()
            .split(/\r?\n/)
            .map((line) => [
                line.slice(0, line.indexOf(" ")),
                line.slice(line.indexOf(" ") + 1),
            ]),
    );
    const pixels = (label: string): number[] =>
        lines.get(label)!.split(" ").slice(2, -1).map(Number);
    // PNG keeps straight alpha exactly; an unknown type is PNG.
    assert.match(lines.get("png")!, /^data:image\/png;base64, 3x2 /);
    assert.deepEqual(
        pixels("png"),
        [
            255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255, 0,
            0, 0, 255, 128, 128, 128, 255,
        ],
    );
    assert.match(lines.get("unknown")!, /^data:image\/png;base64, /);
    // JPEG (any case) composites onto black and is opaque.
    assert.match(lines.get("jpeg")!, /^data:image\/jpeg;base64, 3x2 /);
    const jpeg = pixels("jpeg");
    assert.ok(
        jpeg
            .filter((_, index) => index % 4 === 3)
            .every((alpha) => alpha === 255),
    );
    assert.ok(
        jpeg[8]! + jpeg[9]! + jpeg[10]! < 40,
        `transparent blue on black: ${jpeg.slice(8, 11).join(" ")}`,
    );
    // Out of range and absent qualities take the default 0.92; a lower one encodes less.
    assert.equal(lines.get("default"), lines.get("explicit"));
    assert.equal(lines.get("outside"), lines.get("explicit"));
    assert.notEqual(lines.get("low"), lines.get("explicit"));
    assert.equal(lines.get("empty"), "data:,");
});
