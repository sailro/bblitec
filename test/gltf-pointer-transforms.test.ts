import { inlineCpp } from "./generated-cpp.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { pinnedPbrVariantsHeader } from "../src/pinned-pbr-variant-cpp.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const context = new LoweringContext();
const tools = optionalNativeFixtureTools(false);

function runFixture(name: string, source: string): void {
    const output = resolve(`artifacts/${name}`);
    mkdirSync(output, { recursive: true });
    const fixture = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(fixture, source);
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", fixture,
    ]);
    assert.ok(execFileSync(executable, { encoding: "utf8" }).includes(`${name}: ok`));
}

for (const layer of [
    { name: "clearcoat", property: "_clearCoat", baseField: "ccParams", writer: "writeClearcoatUBO",
        textureKeys: ["texture", "roughnessTexture", "bumpTexture"],
        fields: ["clearcoat", "clearcoat_roughness", "clearcoat_normal"],
        uvFields: ["ccIntUV", "ccRoughUV", "ccNormUV"] },
    { name: "iridescence", property: "_iridescence", baseField: "iridescenceParams", writer: "writeIridescenceUBO",
        textureKeys: ["texture", "thicknessTexture"],
        fields: ["iridescence", "iridescence_thickness"],
        uvFields: ["iridescenceUV", "iridescenceThicknessUV"] },
]) test(`the emitted ${layer.name} writer reads every live texture transform`, {
    skip: !tools,
}, async () => {
    const transforms = [
        { uScale: 2, vScale: 3, uAng: 0.25, uOffset: 0.1, vOffset: 0.2, _hasTx: true },
        { uScale: -4, vScale: 5, uAng: 0.5, uOffset: 0.3, vOffset: 0.4, _hasTx: true },
        { uScale: 1.2, vScale: 0.7, uAng: -0.2, uOffset: 0.5, vOffset: 0.6, _hasTx: true },
    ];
    const material = { [layer.property]: {
        isEnabled: true, ...Object.fromEntries(layer.textureKeys.map((key, i) => [key, transforms[i]])),
    } };
    const variant = await composePinnedPbrVariant(material);
    const spec = variant.materialUboSpec as {
        _offsets: Map<string, number>; _totalBytes: number; _structBody: string;
    };
    const header = inlineCpp(pinnedPbrVariantsHeader(context, variant.vertexWgsl, 368, 20, 4, "test", [{
        fragmentKey: variant.fragmentKey, pipeline: "test", selectors: [], vertex: "", fragment: "",
        vertexWgsl: variant.vertexWgsl, fragmentWgsl: variant.fragmentWgsl,
        materialUbo: { ...spec, _offsets: Object.fromEntries(spec._offsets) },
    }], [], []));
    const start = header.indexOf("struct PbrTestMaterialUniforms");
    const structEnd = header.indexOf("inline void write_PbrTest_material", start);
    const writerStart = header.indexOf(`inline void write_PbrTest_${layer.baseField}`, structEnd);
    const writerEnd = header.indexOf("\n}", writerStart) + 2;
    assert.ok(start >= 0 && structEnd > start && writerStart > structEnd && writerEnd > writerStart);
    const writers = await importPinnedModule<Record<string,
        (data: Float32Array, material: object, offsets: Map<string, number>) => void
    >>(`material/pbr/fragments/${layer.name}-fragment.js`);
    const expected = new Float32Array(spec._totalBytes / 4);
    writers[layer.writer]!(expected, material, spec._offsets);
    runFixture(`gltf-${layer.name}-transforms-check`, `#include <bblite/runtime.hpp>
#include <cassert>
#include <iostream>
using namespace bbl;
${header.slice(start, structEnd)}
${header.slice(writerStart, writerEnd)}
int main() {
    MaterialRecord material{};
    ${transforms.slice(0, layer.fields.length).map((texture, index) => Object.entries({
        u_scale: texture.uScale, v_scale: texture.vScale, rotation: texture.uAng,
        u_offset: texture.uOffset, v_offset: texture.vOffset,
    }).map(([property, value]) => `material.${layer.fields[index]}_transform.${property} = static_cast<float>(${value});`).join("\n    ")).join("\n    ")}
    PbrTestMaterialUniforms actual{};
    write_PbrTest_${layer.baseField}(material, TextureTransform{}, actual);
    ${layer.uvFields.flatMap((field) => [field + "m", field + "t"]).map((field) => {
        const offset = spec._offsets.get(field)! / 4;
        return [0, 1, 2, 3].map((lane) => `assert(std::abs(actual.${field}[${lane}] - static_cast<float>(${expected[offset + lane]})) < 0.000001f);`).join("\n    ");
    }).join("\n    ")}
    std::cout << "gltf-${layer.name}-transforms-check: ok\\n";
}
`);

});

test("source pointer transforms resolve shared occlusion and extension owners", async () => {
    const { resolveAnimationPointer } = await importPinnedModule<{
        resolveAnimationPointer: (pointer: string, context: { materials: object[] }) => {
            writer: (out: Float32Array, offset: number) => void;
        } | null;
    }>("loader-gltf/animation-pointer.js");
    for (const independent of [false, true]) {
        const sharedImage = { uOffset: 11, vOffset: 12 };
        const mat = {
            _uboVersion: 0,
            ormTexture: sharedImage,
            ...(independent ? { occlusionTexture: { uOffset: 21, vOffset: 22 } } : {}),
        };
        const target = resolveAnimationPointer(
            "/materials/0/occlusionTexture/extensions/KHR_texture_transform/offset",
            { materials: [mat] },
        );
        assert.ok(target);
        target.writer(new Float32Array([0.25, 0.75]), 0);
        assert.equal(mat.ormTexture.uOffset, independent ? 11 : 0.25);
        assert.equal(mat.occlusionTexture?.uOffset, independent ? 0.25 : undefined);
        assert.equal(sharedImage.uOffset, 11, "the pointer owns a private transform wrapper");
    }

    for (const [path, owners] of [
        ["KHR_materials_anisotropy/anisotropyTexture", ["_anisotropy", "texture"]],
        ["KHR_materials_diffuse_transmission/diffuseTransmissionColorTexture", ["_subsurface", "translucency", "colorTexture"]],
        ["KHR_materials_diffuse_transmission/diffuseTransmissionTexture", ["_subsurface", "translucency", "intensityTexture"]],
        ["KHR_materials_specular/specularTexture", ["_metallicReflectanceTexture"]],
        ["KHR_materials_specular/specularColorTexture", ["_reflectanceTexture"]],
    ] as const) {
        const mat: Record<string, unknown> = {_uboVersion: 0};
        let owner = mat;
        for (const part of owners.slice(0, -1)) owner = owner[part] = {};
        const key = owners.at(-1)!;
        const sharedTexture = {uOffset: 11, vOffset: 12}; owner[key] = sharedTexture;
        const target = resolveAnimationPointer(`/materials/0/extensions/${path}/extensions/KHR_texture_transform/offset`, {materials: [mat]});
        assert.ok(target);
        target.writer(new Float32Array([.25, .75]), 0);
        assert.equal(sharedTexture.uOffset, 11);
        assert.deepEqual(owner[key], {uOffset: .25, vOffset: .75, _animPriv: true});
    }
    for (const path of ["pbrMetallicRoughness/metallicRoughnessTexture", "extensions/KHR_materials_unknown/unknownTexture"])
        assert.equal(resolveAnimationPointer(`/materials/0/${path}/extensions/KHR_texture_transform/offset`, {materials: [{}]}), null);
});
