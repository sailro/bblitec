import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMat4CreateHeader } from "../src/lowering/pinned-mat4-create.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("matrix constructors translate their own source and stay outside JS storage", () => {
    assert.doesNotMatch(
        readFileSync("native/include/bblite/js_data.hpp", "utf8"),
        /mat4_compose|compose_mat4/,
    );
    const changed = pinnedMat4CreateHeader(
        doctoredContext(
            "src/math/create-identity-mat4.ts",
            "m[15] = 1;",
            "m[15] = 2;",
        ),
    );
    assert.match(
        changed,
        /m\[static_cast<std::size_t>\(15\.0\)\] = static_cast<float>\(2\.0\)/,
    );
    const stores = pinnedMat4CreateHeader(
        doctoredContext(
            "src/math/compose-mat4-into-buffer.ts",
            "qx * qx",
            "qx * qy",
        ),
    );
    assert.match(stores, /const double xx = \(qx \* qy\)/);
    const unused = compileSource("const count = 1;");
    assert.ok(!unused.manifest.features.includes("math:mat4-create"));
    for (const order of [
        "const matrix = createIdentityMat4(); const engine = await createEngine({}, { useHighPrecisionMatrix: true });",
        "const engine = await createEngine({}, { useHighPrecisionMatrix: true }); const matrix = createIdentityMat4();",
    ])
        assert.throws(
            () =>
                compileSource(
                    `import { createIdentityMat4, createEngine } from 'babylon-lite'; ${order}`,
                ),
            /high-precision matrix allocation/,
        );
});

const native = optionalNativeFixtureTools();
test(
    "generated matrix constructors match upstream Float32 bits and fresh allocation",
    { skip: !native },
    async () => {
        type ComposeArguments = [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
        ];
        const { composeMat4 } = await importPinnedModule<{
            composeMat4(this: void, ...values: ComposeArguments): Float32Array;
        }>("math/compose-mat4.js");
        const { createIdentityMat4 } = await importPinnedModule<{
            createIdentityMat4(this: void): Float32Array;
        }>("math/create-identity-mat4.js");
        const { createTranslationMat4 } = await importPinnedModule<{
            createTranslationMat4(
                this: void,
                x: number,
                y: number,
                z: number,
            ): Float32Array;
        }>("math/create-translation-mat4.js");
        const cases: ComposeArguments[] = [
            [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
            [
                -0, 2.123456789, -3.87654321, 0.125, -0.25, 0.375, 0.8125, -2,
                0, 0.000001,
            ],
            [1e30, -1e-30, 1e-45, 1e20, -0.2, 0.3, 0.7, 1e-10, 2, -3],
            ...Array.from({ length: 12 }, (_, i): ComposeArguments => [
                i + 0.123,
                i - 0.987,
                -i,
                Math.sin(i),
                Math.cos(i),
                0.3,
                0.25,
                i - 5,
                i / 3,
                -i / 7,
            ]),
        ];
        const bits = (values: Float32Array) =>
            [
                ...new Uint32Array(
                    values.buffer,
                    values.byteOffset,
                    values.length,
                ),
            ]
                .map((value) => `${value}u`)
                .join(", ");
        const literal = (value: number) =>
            Object.is(value, -0)
                ? "-0.0"
                : Number.isInteger(value) && Math.abs(value) < 1e21
                  ? `${value}.0`
                  : String(value);
        const checks = cases.map(
            (values) =>
                `check(bbl::upstream::compose_mat4(${values.map(literal).join(", ")}), {${bits(composeMat4(...values))}});`,
        );
        checks.push(
            `check(bbl::upstream::create_identity_mat4(), {${bits(createIdentityMat4())}});`,
        );
        checks.push(
            `check(bbl::upstream::create_translation_mat4(-0.0, 1.123456789, -9.87654321), {${bits(createTranslationMat4(-0, 1.123456789, -9.87654321))}});`,
        );
        const output = resolve("artifacts/pinned-mat4-create");
        mkdirSync(join(output, "bblite/upstream"), { recursive: true });
        writeFileSync(
            join(output, "bblite/upstream/pinned_mat4_create.hpp"),
            pinnedMat4CreateHeader(new LoweringContext()),
        );
        writeFileSync(
            join(output, "check.cpp"),
            `#include <bblite/upstream/pinned_mat4_create.hpp>
#include <bit>
#include <cassert>
void check(const bbl::js::F32Array& actual, const std::array<std::uint32_t,16>& expected) {
    assert(actual.size() == expected.size());
    for (std::size_t i=0; i<16; ++i) assert((std::isnan(actual[i]) && std::isnan(std::bit_cast<float>(expected[i]))) || std::bit_cast<std::uint32_t>(actual[i]) == expected[i]);
}
int main() {
    ${checks.join("\n")}
    auto first = bbl::upstream::create_identity_mat4();
    auto second = bbl::upstream::create_identity_mat4();
    assert(first.storage() != second.storage());
    first[0] = 7.0f;
    assert(second[0] == 1.0f);
}`,
        );
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(native!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/permissive-",
            "/fp:precise",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "/I",
            output,
            join(output, "check.cpp"),
        ]);
        execFileSync(executable, { encoding: "utf8" });
    },
);
