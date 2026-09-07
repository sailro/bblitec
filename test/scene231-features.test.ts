import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerStandardMeshAlpha } from "../src/lowering/standard-mesh-alpha.js";
import { lowerStandardUvTransformWriter } from "../src/lowering/standard-uv-transform-lowerer.js";
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
    const bits = await importPinnedModule<{ MSH_HAS_SKELETON: number; MSH_VAT: number }>("material/mesh-features.js");
    const plain = await composePinnedStandardVariant({ diffuseTexture: {} });
    const skinned = await composePinnedStandardVariant({ diffuseTexture: {} }, {
        meshFeatures: bits.MSH_HAS_SKELETON, skeleton: true,
    });
    assert.match(skinned.vertexWgsl, /boneSampler:texture_2d<f32>/);
    assert.match(skinned.vertexWgsl, /textureLoad/);
    assert.match(skinned.fragmentKey, /std-skeleton/);
    await assert.rejects(composePinnedStandardVariant({}, { meshFeatures: bits.MSH_HAS_SKELETON }), /enableStandardSkeleton/);
    await assert.rejects(composePinnedStandardVariant({}, { meshFeatures: bits.MSH_VAT, skeleton: true }), /vertex animation textures are not supported/);
    assert.deepEqual(await composePinnedStandardVariant({ diffuseTexture: {} }), plain);
});

test("Standard shadow composition suppresses mesh vertex alpha", async () => {
    const flags = await importPinnedModule<{
        VERTEX_ALPHA: number; MATERIAL_ALPHA_BLEND: number;
        NO_COLOR_OUTPUT: number; ESM_SHADOW_OUTPUT: number;
    }>("material/standard/standard-flags.js");
    const material = { diffuseTexture: {} };
    const alpha = await composePinnedStandardVariant(material, { vertexColors: { vertexAlpha: true } });
    const alphaBits = flags.VERTEX_ALPHA | flags.MATERIAL_ALPHA_BLEND;
    assert.equal(alpha.features & alphaBits, alphaBits);
    for (const passFeatures of [flags.NO_COLOR_OUTPUT, flags.ESM_SHADOW_OUTPUT]) {
        const shadow = await composePinnedStandardVariant(material, { passFeatures, vertexColors: { vertexAlpha: true } });
        const opaqueShadow = await composePinnedStandardVariant(material, { passFeatures, vertexColors: { vertexAlpha: false } });
        assert.equal(shadow.features & alphaBits, 0);
        assert.deepEqual(shadow, opaqueShadow);
    }
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

test("Standard texture transforms retain live material offsets and the pinned UV2 exemption", { skip: !nativeTools }, async () => {
    const { stdUvTransformExt } = await importPinnedModule<{
        stdUvTransformExt: { _bind(material: unknown, entries: unknown[], binding: number, mesh: unknown, scene: unknown): number };
    }>("material/standard/fragments/std-uv-transform-fragment.js");
    const context = new LoweringContext();
    const channels = ["diffuseTexture", "_bumpTexture", "_specularTexture", "_ambientTexture", "_opacityTexture"];
    const lowered = lowerStandardUvTransformWriter(context, {
        presence: Object.fromEntries(channels.map((name) => [name, "true"])),
        coordIndex: { diffuseCoordIndex: "material.diffuse_coord_index" },
    });
    const checks: string[] = [];
    for (const offset of [[0, 0], [0.13, 0.07], [1 / 3, -1 / 7]]) {
        for (const invertY of [false, true]) for (const coordIndex of [0, 1]) {
            const texture = { uScale: 1.3, vScale: 0.7, uOffset: 0.17, vOffset: -0.11, uAng: 0.4, invertY };
            const material = { uvScale: [2, 0.5], uvOffset: offset,
                diffuseCoordIndex: coordIndex,
                ...Object.fromEntries(channels.map((name) => [name, texture])) };
            let expected = new Uint32Array();
            const scene = { surface: { engine: { _device: {
                createBuffer: () => ({}),
                queue: { writeBuffer: (_buffer: unknown, _offset: number, bytes: ArrayBuffer, start: number, length: number) => {
                    expected = new Uint32Array(bytes.slice(start, start + length));
                } },
            } } } };
            const entries: unknown[] = [];
            assert.equal(stdUvTransformExt._bind(material, entries, 0, null, scene), 1);
            assert.equal(expected.length, lowered.floatCount);
            checks.push(`{
                bbl::MaterialRecord material{};
                material.standard_uv_offset_x = ${offset[0]};
                material.standard_uv_offset_y = ${offset[1]};
                material.diffuse_coord_index = ${coordIndex};
                bbl::TextureData texture{};
                texture.uv_transform = {1.3, 0.7, 0.17, -0.11, 0.4};
                texture.uv_invert_y = ${invertY};
                material.base_color_texture = texture;
                material.bump_texture = texture;
                material.specular_texture = texture;
                material.ambient_texture = texture;
                material.opacity_texture = texture;
                bbl::upstream::StandardMaterialProps props{{2.0f, 0.5f}};
                bbl::upstream::StandardUvTxUniforms actual{};
                bbl::upstream::write_std_uv_transform_data(material, props, actual);
                const std::array<std::uint32_t, ${expected.length}> expected{${[...expected].map((v) => `${v}u`).join(", ")}};
                for (std::size_t lane = 0; lane < expected.size(); ++lane)
                    assert(std::bit_cast<std::uint32_t>(actual.data[lane]) == expected[lane]);
            }`);
        }
    }
    runNative("uv-transform-offset", `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bit>
#include <cassert>
namespace bbl::upstream {
struct StandardMaterialProps { std::array<float, 2> uv_scale; };
${lowered.source}
}
int main() { ${checks.join("\n")} }
`);
});
