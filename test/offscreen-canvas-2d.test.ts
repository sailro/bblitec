import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * `createImageBitmap` over `new ImageData(rgba, width, height)` with a
 * source rectangle and resize options, an OffscreenCanvas's 2D context
 * drawing the bitmap, and `convertToBlob` encoding the canvas: the calls,
 * their refusals, the PAL's pixels and settlements, and a program running
 * the three in a realm.
 */

const realm = (body: string): string => `async function run(): Promise<void> {
        queueMicrotask(() => {});
        const rgba = new Uint8ClampedArray(4 * 3 * 4);
        ${body}
    }
    run();
`;

const capture = `
        const bitmap = await createImageBitmap(new ImageData(rgba, 4, 3), 1, 0, 2, 2, { resizeWidth: 4, resizeHeight: 4, resizeQuality: "high" });
        try {
            const out = new OffscreenCanvas(4, 4);
            const ctx = out.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(bitmap, 0, 0);
            const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.8 });
            if (blob.size === 0) throw new Error("empty");
        } finally {
            bitmap.close();
        }`;

test("an ImageData's bitmap, an OffscreenCanvas 2D context and convertToBlob lower to native calls", () => {
    const { cpp, manifest } = compileSource(realm(capture));
    assert.ok(manifest.features.includes("image:canvas-encode"));
    assert.match(
        cpp,
        /bbl::pal::create_image_bitmap\(v_\w*rgba, v_\w+, v_\w+, bbl::pal::ImageBitmapSourceRect\{v_\w+, v_\w+, v_\w+, v_\w+\}, bbl::pal::ImageBitmapOptionsInit\{std::nullopt, std::nullopt, std::nullopt\}, bbl::pal::ImageBitmapResizeInit\{v_\w+, v_\w+, std::string\("high"\)\}\)/,
    );
    // The context is null while a WebGPU context owns the canvas: its test stays a run-time one.
    assert.match(
        cpp,
        /bbl::js::Nullable<std::shared_ptr<bbl::pal::OffscreenCanvas>> v_\w*ctx = bbl::pal::offscreen_canvas_context_2d\(v_\w*out\);/,
    );
    assert.match(cpp, /if \(!\(v_\w*ctx\.has_value\(\)\)\)/);
    assert.match(
        cpp,
        /bbl::pal::offscreen_canvas_draw_image\(\(\*v_\w*ctx\), v_\w*bitmap, 0\.0, 0\.0\)/,
    );
    assert.match(
        cpp,
        /co_await bbl::pal::offscreen_canvas_convert_to_blob\(v_\w+, std::optional<std::string>\{"image\/jpeg"\}, std::optional<double>\{0\.8\}\)/,
    );
    for (const [body, message] of [
        [
            `const ctx = new OffscreenCanvas(1, 1).getContext("webgpu");`,
            /OffscreenCanvas\.getContext lowers the '2d' context/,
        ],
        [
            `const ctx = new OffscreenCanvas(1, 1).getContext("2d", { alpha: false });`,
            /OffscreenCanvas\.getContext context attributes are not lowered/,
        ],
        [
            `const ctx = new OffscreenCanvas(1, 1).getContext("2d"); ctx?.fillRect(0, 0, 1, 1);`,
            /OffscreenCanvasRenderingContext2D\.fillRect is not lowered/,
        ],
        [
            `const ctx = new OffscreenCanvas(1, 1).getContext("2d"); ctx?.drawImage(new OffscreenCanvas(1, 1), 0, 0);`,
            /An OffscreenCanvas 2D context draws an ImageBitmap source/,
        ],
        [
            `await new OffscreenCanvas(1, 1).convertToBlob({ type: "image/webp" });`,
            /OffscreenCanvas\.convertToBlob\('image\/webp'\) is not encoded natively/,
        ],
        [
            `await createImageBitmap(new ImageData(rgba, 4, 3), 0, 0);`,
            /createImageBitmap takes an image, an optional source rectangle/,
        ],
        [
            `const quality = "high" as ResizeQuality; await createImageBitmap(new ImageData(rgba, 4, 3), { resizeQuality: quality });`,
            /createImageBitmap resizeQuality requires a static string/,
        ],
    ] as const)
        assert.throws(() => compileSource(realm(body)), message);
});

test("an ImageData's bitmap crops, scales and settles as the browser's; a 2D OffscreenCanvas draws and encodes it", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-offscreen-canvas-2d");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        resolve("test/fixtures/offscreen-canvas-2d-check.cpp"),
        resolve("native/src/pal_image.cpp"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
    ]);
    assert.equal(
        runFixtureExecutable(executable, {
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        }).trim(),
        "ok",
    );
});

test("a realm crops an ImageData, draws it on an OffscreenCanvas and decodes the Blob it encodes", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-offscreen-canvas-2d/program");
    mkdirSync(directory, { recursive: true });
    const source = `
        async function square(rgba: Uint8ClampedArray, side: number): Promise<Blob | null> {
            const bitmap = await createImageBitmap(new ImageData(rgba, 4, 3), 1, 0, side, side, { resizeWidth: 6, resizeHeight: 6, resizeQuality: "high" });
            try {
                const out = new OffscreenCanvas(6, 6);
                const ctx = out.getContext("2d");
                if (!ctx) return null;
                ctx.drawImage(bitmap, 0, 0);
                return await out.convertToBlob({ type: "image/png" });
            } finally {
                bitmap.close();
            }
        }
        async function run(): Promise<void> {
            const rgba = new Uint8ClampedArray(4 * 3 * 4);
            for (let index = 0; index < rgba.length; ++index) rgba[index] = index % 4 === 3 ? 255 : index * 5;
            const blob = await square(rgba, 3);
            if (!blob || blob.type !== "image/png" || !(blob instanceof Blob)) throw new Error("blob");
            const decoded = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
            if (decoded.width !== 6 || decoded.height !== 6) throw new Error("decoded " + decoded.width);
            const jpeg = await new OffscreenCanvas(3, 2).convertToBlob({ type: "image/jpeg", quality: 0.5 });
            if (jpeg.type !== "image/jpeg" || jpeg.size === 0) throw new Error("jpeg " + jpeg.type);
            let rejected = false;
            try { await square(rgba, 0); } catch (error) { rejected = error instanceof RangeError; }
            if (!rejected) throw new Error("zero crop");
            globalThis.close();
        }
        run();
    `;
    const entry = resolve(directory, "entry.ts");
    writeFileSync(entry, source);
    const compiled = compileSource(source, { fileName: entry });
    const cpp = resolve(directory, "main.cpp");
    const application = resolve(directory, "check.exe");
    writeFileSync(cpp, compiled.cpp);
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_IMAGE_DECODER=1",
        "/DBBLITE_HAS_WEBP_DECODER=1",
        cpp,
        "native/src/pal_image.cpp",
        `/Fo${directory}/`,
        `/Fe${application}`,
        join(nativeFixtureVcpkgRoot, "lib/libwebp.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"),
    ]);
    const output = await promisify(execFile)(application, [], {
        timeout: 30000,
        env: {
            ...process.env,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
        },
    });
    assert.equal(output.stdout + output.stderr, "");
});
