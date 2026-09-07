import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerStandardMeshAlpha } from "../src/lowering/standard-mesh-alpha.js";
import { pinnedSharedVariantDecls, pinnedStandardVariantsHeader } from "../src/pinned-pbr-variant-cpp.js";
import { composePinnedStandardVariant, pinnedStandardVariantManifestEntry } from "../src/pinned-standard-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

function runNative(name: string, cpp: string, include?: string): void {
    const output = resolve("artifacts/scene231-contracts", name);
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        ...(include ? ["/I", include] : []), source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
}

test("optional output arrays preserve allocation and supplied-buffer identity", { skip: !nativeTools }, () => {
    const result = compileSource(`
        function fill(value: number, out?: Float32Array): Float32Array {
            const target = out ?? new Float32Array(2);
            target[0] = value;
            return target;
        }
        const first = fill(1);
        const second = fill(2);
        const explicit = fill(3, undefined);
        const alias = fill(4, first);
        alias[1] = 9;
        if (first[0] !== 4 || first[1] !== 9 || second[0] !== 2 || explicit[0] !== 3) {
            throw new Error("optional output lost identity or allocation");
        }
    `);
    runNative("optional-output", result.cpp);
});

test("Standard skeleton composition requires its opt-in and does not leak it", async () => {
    const bits = await importPinnedModule<{ MSH_HAS_SKELETON: number }>("material/mesh-features.js");
    const plain = await composePinnedStandardVariant({ diffuseTexture: {} });
    const skinned = await composePinnedStandardVariant({ diffuseTexture: {} }, {
        meshFeatures: bits.MSH_HAS_SKELETON, skeleton: true,
    });
    assert.match(skinned.vertexWgsl, /boneSampler:texture_2d<f32>/);
    assert.match(skinned.vertexWgsl, /textureLoad/);
    assert.match(skinned.fragmentKey, /std-skeleton/);
    await assert.rejects(composePinnedStandardVariant({}, { meshFeatures: bits.MSH_HAS_SKELETON }), /enableStandardSkeleton/);
    assert.deepEqual(await composePinnedStandardVariant({ diffuseTexture: {} }), plain);
});

test("live Standard UV offsets match the pinned writer, including inversion", { skip: !nativeTools }, async () => {
    const context = new LoweringContext();
    const variant = pinnedStandardVariantManifestEntry(await composePinnedStandardVariant({ diffuseTexture: {} }));
    const output = resolve("artifacts/scene231-contracts/uv-headers");
    mkdirSync(join(output, "bblite/upstream"), { recursive: true });
    writeFileSync(join(output, "bblite/upstream/pinned_variant_bindings.hpp"), pinnedSharedVariantDecls(context, "test"));
    writeFileSync(join(output, "standard.hpp"), pinnedStandardVariantsHeader(context, "test", [variant], true));
    const { enableStandardUvOffset } = await importPinnedModule<{ enableStandardUvOffset(): void }>("material/standard/enable-standard-mesh-features.js");
    const { writeStandardUvTransformData } = await importPinnedModule<{
        writeStandardUvTransformData(out: Float32Array, material: { uvScale: number[]; uvOffset: number[] }, inverted: boolean): void;
    }>("material/standard/standard-pipeline.js");
    enableStandardUvOffset();
    const checks: string[] = [];
    for (const offset of [[0, 0], [0.13, 0.07], [-0.71, 0.99], [1 / 3, -1 / 7]]) {
        for (const inverted of [false, true]) {
            const expected = new Float32Array(4);
            writeStandardUvTransformData(expected, { uvScale: [2, 0.5], uvOffset: offset }, inverted);
            const bits = new Uint32Array(expected.buffer);
            checks.push(`{
                bbl::upstream::StandardMaterialProps material{};
                material.uv_scale = {2.0f, 0.5f};
                material.uv_offset = {${offset.join(", ")}};
                bbl::upstream::StandardUvTransformUniforms actual{};
                bbl::upstream::write_standard_uv_transform(material, ${inverted}, actual);
                const std::array<std::uint32_t, 4> expected{${[...bits].map((v) => `${v}u`).join(", ")}};
                for (std::size_t lane = 0; lane < 4; ++lane)
                    assert(std::bit_cast<std::uint32_t>(actual.u[lane]) == expected[lane]);
            }`);
        }
    }
    runNative("uv-writer", `#include <bit>
#include <cassert>
#include "standard.hpp"
int main() { ${checks.join("\n")} }
`, output);
});

test("Standard vertex-alpha decisions distinguish meshes, shadows, and instance colors", { skip: !nativeTools }, async () => {
    const context = new LoweringContext();
    const flags = await importPinnedModule<{ VERTEX_ALPHA: number; MATERIAL_ALPHA_BLEND: number }>("material/standard/standard-flags.js");
    const checks: string[] = [];
    for (const shadow of [false, true]) for (const alpha of [false, true]) {
        for (const vertex of [false, true]) for (const instance of [false, true]) {
            const expected = !shadow && alpha && (vertex || instance)
                ? flags.MATERIAL_ALPHA_BLEND | (vertex ? flags.VERTEX_ALPHA : 0) : 0;
            checks.push(`assert(standard_color_alpha_features(${shadow}, ${alpha}, ${vertex}, ${instance}) == ${expected}u);`);
        }
    }
    runNative("mesh-alpha", `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
${lowerStandardMeshAlpha(context, true)}
int main() { ${checks.join("\n")} }
`);
});
