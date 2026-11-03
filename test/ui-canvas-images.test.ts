import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-canvas-images");

test("Canvas2D transforms, image source rectangles and readbacks lower to native calls", () => {
    const { cpp } = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        await createEngine({});
        const icon = new Image();
        icon.src = "frame.png";
        function paint(canvas: HTMLCanvasElement, size: number): void {
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.clearRect(0, 0, size, size);
            ctx.imageSmoothingQuality = "high";
            ctx.save();
            ctx.translate(size, 0);
            ctx.scale(-1, 1);
            ctx.rotate(0.5);
            ctx.transform(1, 0, 0, 1, 2, 3);
            ctx.drawImage(icon, 1, 1, 2, 2, 0, 0, size / 2, size / 2);
            ctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.resetTransform();
            ctx.setTransform();
            ctx.drawImage(icon, 0, 0);
            ctx.drawImage(canvas, 0, 0, size, size);
            const pixels = ctx.getImageData(0, 0, size, size).data;
            canvas.dataset.alpha = String(pixels[3]);
        }
        const canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        paint(canvas, 48);
    `);
    for (const call of [
        "ui_canvas_save",
        "ui_canvas_translate",
        "ui_canvas_rotate",
        "ui_canvas_transform",
        "ui_canvas_restore",
        "ui_canvas_set_transform",
        "ui_canvas_reset_transform",
        "ui_canvas_clear_rect",
        "ui_canvas_get_image_data",
        "ui_canvas_set_image_smoothing_quality",
    ])
        assert.match(cpp, new RegExp(`bbl::${call}\\(`), call);
    assert.equal(cpp.match(/bbl::ui_canvas_reset_transform\(/g)?.length, 2);
    // drawImage's three forms keep their arities.
    assert.match(
        cpp,
        /ui_canvas_draw_image\(v_\w+, v_\w+, v_icon, 1\.0, 1\.0, 2\.0, 2\.0, 0\.0, 0\.0, \(v_\w+ \/ 2\.0\), \(v_\w+ \/ 2\.0\)\);/,
    );
    assert.match(
        cpp,
        /ui_canvas_draw_image\(v_\w+, v_\w+, v_icon, 0\.0, 0\.0\);/,
    );
    assert.match(
        cpp,
        /ui_canvas_draw_image\(v_\w+, v_\w+, v_canvas, 0\.0, 0\.0, v_\w+, v_\w+\);/,
    );
    for (const attributes of ["{ alpha: false }", "{ colorSpace: 'srgb' }"])
        assert.throws(
            () =>
                compileSource(
                    `const c = document.createElement("canvas"); c.getContext("2d", ${attributes});`,
                ),
            /willReadFrequently canvas context attribute/,
        );
    assert.throws(
        () =>
            compileSource(`
                const c = document.createElement("canvas");
                const v = document.createElement("video");
                c.getContext("2d")!.drawImage(v, 0, 0);
            `),
        /draws an img or canvas source, not <video>/,
    );
});

test("a promise's resolving functions are image listeners with their own identity", () => {
    const { cpp } = compileSource(`
        function load(url: string): Promise<HTMLImageElement> {
            return new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.addEventListener("error", reject);
                img.removeEventListener("error", reject);
                img.src = url;
            });
        }
        void load("frame.png").then((img) => document.body.appendChild(img), () => undefined);
    `);
    // The error event rejects opaquely: reading the reason refuses natively.
    assert.match(
        cpp,
        /\.reject\(std::make_exception_ptr\(bbl::js::UnrepresentedThrownValue\("Event"\)\)\)/,
    );
    assert.equal(
        cpp.match(/\.resolving_function_identity\(true\)/g)?.length,
        2,
    );
});

test("an image URL's query and fragment package the file its path names", () => {
    const fileName = resolve(directory, "entry.ts");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "frame.png"),
        PNG.sync.write(new PNG({ width: 1, height: 1 })),
    );
    const result = compileSource(
        `const img = new Image(); img.src = "frame.png?v=2"; document.body.appendChild(img);`,
        { fileName },
    );
    assert.ok(
        result.manifest.assets.some((asset) => asset.output === "frame.png"),
    );
    assert.ok(
        !result.manifest.assets.some((asset) => asset.output.includes("?")),
    );
    assert.match(result.cpp, /"frame\.png\?v=2"/);
});

test("native Canvas2D draws images through transforms, clears exactly and reads back", (t) => {
    mkdirSync(directory, { recursive: true });
    const raster = new PNG({ width: 4, height: 4 });
    for (let y = 0; y < 4; ++y)
        for (let x = 0; x < 4; ++x)
            raster.data.set(
                x === 3 && y === 3
                    ? [200, 100, 50, 128]
                    : [60 * x, 60 * y, 100, 255],
                (y * 4 + x) * 4,
            );
    writeFileSync(resolve(directory, "frame.png"), PNG.sync.write(raster));
    runRmlUiFixture(t, "ui-canvas-images", {
        macros: { BBLITE_WORKERS: 1 },
        imageDecoder: true,
    });
});
