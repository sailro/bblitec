import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGltfOrmComposition } from "../src/lowering/gltf/orm-composition.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const module = "src/loader-gltf/gltf-ext-orm.ts";
type Bitmap = { width: number; height: number; data: Uint8ClampedArray };

class Canvas {
    private data: Uint8ClampedArray;
    constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
    getContext(kind: string): this { assert.equal(kind, "2d"); return this; }
    drawImage(image: Bitmap, x: number, y: number, width: number, height: number): void {
        assert.deepEqual([x, y, width, height], [0, 0, this.width, this.height]);
        this.data.set(image.data);
    }
    getImageData(x: number, y: number, width: number, height: number): Bitmap {
        assert.deepEqual([x, y, width, height], [0, 0, this.width, this.height]);
        return { width, height, data: this.data.slice() };
    }
    putImageData(image: Bitmap, x: number, y: number): void {
        assert.deepEqual([x, y], [0, 0]); this.data.set(image.data);
    }
}

test("ORM pixel output follows the pinned body and changed source stores", async t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "d1.data[j] = d2.data[j]!;", "d1.data[j + 1] = d2.data[j + 2]!;"),
        ...[-4, 0.5, 1.5, 2.5, 254.5, 300].map(value => doctoredContext(module, "d1.data[j] = d2.data[j]!;", `d1.data[j] = ${value};`)),
    ];
    const mr = { width: 3, height: 2, data: new Uint8ClampedArray([12,40,60,255, 14,44,66,255, 20,71,5,255, 45,32,8,255, 62,40,15,255, 53,81,9,255]) };
    const occ = { width: 3, height: 2, data: new Uint8ClampedArray([20,19,5,255, 35,23,8,255, 87,34,80,255, 144,64,4,255, 9,74,68,255, 11,66,91,255]) };
    const expected: Bitmap[] = [];
    for (const context of contexts) {
        const declaration = context.functionDeclaration(module, "compositeOrm").declaration;
        const execute = new Function("OffscreenCanvas", "createImageBitmap",
            transpileCommonJs(declaration.getText(), module) + "\nreturn compositeOrm;")(Canvas,
                (canvas: Canvas) => canvas.getImageData(0, 0, canvas.width, canvas.height)) as (mr: Bitmap, occ: Bitmap) => Promise<Bitmap>;
        expected.push(await execute(mr, occ));
    }
    const output = resolve("artifacts/gltf-orm-composition"); mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/pal_image_canvas.hpp>
        #include <cassert>
        namespace bbl {
            ${contexts.map((context, index) => `namespace variant${index} { ${lowerGltfOrmComposition(context)} }`).join("\n")}
        }
        int main() {
            using namespace bbl;
            const pal::DecodedImage mr{${mr.width}, ${mr.height}, {${[...mr.data]}}}, occ{${occ.width}, ${occ.height}, {${[...occ.data]}}};
            ${expected.map((value, index) => `{
                const auto result = variant${index}::gltf_composite_orm(mr, occ);
                assert(result.width == ${value.width} && result.height == ${value.height});
                assert((result.rgba == std::vector<std::uint8_t>{${[...value.data]}}));
            }`).join("\n")}
            assert((mr.rgba == std::vector<std::uint8_t>{${[...mr.data]}}));
            assert((occ.rgba == std::vector<std::uint8_t>{${[...occ.data]}}));
            const auto refuses = [](auto action) { bool failed = false; try { action(); } catch (const std::runtime_error&) { failed = true; } assert(failed); };
            auto alpha = occ; alpha.rgba[3] = 128;
            refuses([&] { variant0::gltf_composite_orm(mr, alpha); });
            auto scaled = occ; scaled.width = 2;
            refuses([&] { variant0::gltf_composite_orm(mr, scaled); });
            pal::ImageCanvas canvas(3, 2);
            refuses([&] { canvas.context("webgpu"); });
            refuses([&] { canvas.get_image_data(1, 0, 2, 2); });
            refuses([&] { canvas.put_image_data(mr, 1, 0); });
            canvas.put_image_data(alpha, 0, 0);
            refuses([&] { canvas.bitmap(); });
            refuses([&] { pal::ImageCanvas invalid(0, 2); });
        }
    `);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});

test("unrepresented ORM canvas operations refuse at the pinned source", () => {
    assert.throws(() => lowerGltfOrmComposition(doctoredContext(module, 'c1.getContext("2d")', 'c1.getContext("2d", { alpha: false })')), /Unsupported image canvas call/);
    assert.throws(() => lowerGltfOrmComposition(doctoredContext(module, "d1.data[j] = d2.data[j]!;", "d1.data[j] += d2.data[j]!;")), /Unsupported image data update/);
    assert.throws(() => lowerGltfOrmComposition(doctoredContext(module, "d1.data[j] = d2.data[j]!;", "d1.data[j]++;")), /Unsupported image data update/);
});
