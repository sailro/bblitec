import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMat4InvertHeader } from "../src/lowering/pinned-mat4-invert.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

test("matrix inverse preserves pinned Float32 lanes, null singulars, and fresh result storage", { skip: !tools }, async () => {
    const { mat4Invert } = await importPinnedModule<{
        mat4Invert(input: Float32Array): Float32Array | null;
    }>("math/mat4-invert.js");
    const cases = [
        new Float32Array(16),
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 7.1234567, -9.987654, 11, 1]),
        new Float32Array([1e-10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Float32Array(3),
        ...Array.from({ length: 8 }, (_, sample) => Float32Array.from({ length: 16 },
            (_, lane) => Math.sin(sample * 19 + lane) * (lane % 5 === 0 ? 1000 : 0.13))),
    ];
    const output = resolve("artifacts/pinned-mat4-invert");
    const include = join(output, "bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(join(include, "pinned_mat4_invert.hpp"), pinnedMat4InvertHeader(new LoweringContext()));
    const bits = (data: Float32Array): string => [...new Uint32Array(data.buffer)].map(
        (value) => `std::bit_cast<float>(${value}u)`,
    ).join(", ");
    const checks = cases.map((input) => {
        const expected = mat4Invert(input);
        return `{ const bbl::js::F32Array input{${bits(input)}};
            auto actual = bbl::upstream::mat4_invert_array(input);
            assert(actual.has_value() == ${expected !== null});
            ${expected ? `const std::array<float, 16> expected{${bits(expected)}};
            assert(actual->storage() != input.storage());
            for (std::size_t lane = 0; lane < expected.size(); ++lane) {
                assert((std::isnan(expected[lane]) && std::isnan((*actual)[lane])) ||
                    std::bit_cast<std::uint32_t>(expected[lane]) == std::bit_cast<std::uint32_t>((*actual)[lane]));
            }` : ""}
        }`;
    }).join("\n");
    const compiled = compileSource(`
        import { mat4Compose, mat4Invert } from "babylon-lite";
        import type { Mat4 } from "babylon-lite";
        function translation(matrix: Mat4): number { return matrix[12]!; }
        function invertTranslation(matrix: Mat4): number {
            const inverse = mat4Invert(matrix);
            if (!inverse) return -99;
            return translation(inverse);
        }
        if (invertTranslation(mat4Compose(7, 0, 0, 0, 0, 0, 1, 1, 1, 1)) !== -7)
            throw new Error("Mat4 parameter or inverse changed");
        if (invertTranslation(mat4Compose(7, 0, 0, 0, 0, 0, 1, 0, 1, 1)) !== -99)
            throw new Error("singular inverse did not take its guard");
    `);
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    writeFileSync(join(output, "check.cpp"), `
        #define main generated_scene_main
        #include "program.hpp"
        #undef main
        #include <bit>
        #include <cassert>
        void peer();
        int main() { assert(generated_scene_main() == 0); ${checks} peer(); }
    `);
    writeFileSync(join(output, "peer.cpp"), `#include <bblite/upstream/pinned_mat4_invert.hpp>
        void peer() { static_cast<void>(bbl::upstream::mat4_invert_array(bbl::js::F32Array(16))); }`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-", "/fp:precise",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", output,
        join(output, "check.cpp"), join(output, "peer.cpp"),
    ]);
    execFileSync(executable, { encoding: "utf8" });
});

test("Mat4 recognition follows the pinned symbol and refuses unsupported F64 storage", () => {
    const local = compileSource(`
        interface Mat4 { amount: number }
        function amount(matrix: Mat4) { return matrix.amount; }
        if (amount({ amount: 7 }) !== 7) throw new Error("local Mat4 changed");
    `);
    assert.doesNotMatch(local.cpp, /pinned_mat4_invert/);
    for (const body of [
        `const inverse = mat4Invert(input as unknown as Mat4);`,
        `function inverse(matrix: Mat4) { return mat4Invert(matrix); }
         const result = inverse(input as unknown as Mat4);`,
        `function matrix(): Mat4 { return input as unknown as Mat4; }
         const result = mat4Invert(matrix());`,
    ]) {
        assert.throws(() => compileSource(`
            import { mat4Invert } from "babylon-lite";
            import type { Mat4 } from "babylon-lite";
            const input = new Float64Array(16);
            ${body}
        `, { fileName: "matrix-storage.ts" }), /matrix-storage.ts:.*(?:Float32Array|f32array)/);
    }
    assert.throws(() => compileSource(`
        import { createEngine, mat4Identity, mat4Invert } from "babylon-lite";
        const engine = await createEngine({}, { useHighPrecisionMatrix: true });
        const inverse = mat4Invert(mat4Identity());
    `, { fileName: "matrix-precision.ts" }), /matrix-precision.ts:.*high-precision matrix allocation/);
});
