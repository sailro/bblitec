/**
 * The generated material texture-slot table.
 *
 * The five hand-kept copies — both backends' upload selection, the two
 * pinned name maps and Dawn's slot-order comment — collapse into the one
 * table `materialTextureSlotsHeader` emits, so what this asserts is the
 * contract those copies used to restate: the base slots and their sRGB and
 * fallback rules, the extension append order, the pinned binding names per
 * slot, and the generation-time refusal of a pinned name no row serves.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    materialTextureSlotsHeader,
    type MaterialTextureSlotFeatures,
} from "../src/pinned-pbr-variant-cpp.js";
import { metallicReflectanceCapabilityDefines } from "../src/upstream-lower.js";

const noFeatures: MaterialTextureSlotFeatures = {
    transmission: false,
    clearcoat: false,
    sheen: false,
    iridescence: false,
    lightmap: false,
    metallicReflectanceMap: false,
    reflectanceMap: false,
    specularGlossiness: false,
    occlusionUv2: false,
    standardBump: false,
    standardReflection: false,
    clusteredLights: false,
};

/** A composed-variant fixture carrying just the group-1 declarations. */
function variantWith(
    bindings: readonly [name: string, type: string][],
): { vertexWgsl: string; fragmentWgsl: string } {
    const declarations = bindings
        .map(([name, type], index) =>
            `@group(1) @binding(${index + 2}) var ${name} : ${type};`
        )
        .join("\n");
    const samples = bindings
        .filter(([, type]) => type.startsWith("texture_2d"))
        .map(([name]) => `textureSample(${name}, s, uv);`)
        .join("\n");
    return {
        vertexWgsl: "@vertex fn main() {}",
        fragmentWgsl: `${declarations}\n@fragment fn main() {\n${samples}\n}`,
    };
}

/** The order rows appear in the emitted table body. */
function rowOrder(header: string, rows: readonly string[]): void {
    let cursor = -1;
    for (const row of rows) {
        const at = header.indexOf(row);
        assert.ok(at >= 0, `missing row: ${row}`);
        assert.ok(at > cursor, `row out of order: ${row}`);
        cursor = at;
    }
}

test("the base slots carry the rules both backends used to hand-keep", () => {
    const header = materialTextureSlotsHeader(noFeatures, [], "test");
    assert.ok(
        header.includes(
            "inline constexpr std::size_t material_texture_mesh_slots = 5;",
        ),
    );
    rowOrder(header, [
        // Slot 0: the base-colour rule (bytes keep sRGB, a bare fallback
        // takes the record's encoding) and the record's baked texel.
        `    {0, MaterialTextureSource::base_color, ` +
        `MaterialTextureSrgb::base_color, ` +
        `MaterialTextureFallback::base_color_record, ` +
        `"baseColorTexture", "baseColorSampler"},`,
        // Slot 1: Standard specular / PBR ORM, linear, the pinned ORM
        // factor texel.
        `    {1, MaterialTextureSource::specular_or_metallic_roughness, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::orm_record, ` +
        `"ormTexture", "ormSampler"},`,
        // Slot 2: Standard opacity / PBR normal, linear, flat normal for
        // the PBR family only.
        `    {2, MaterialTextureSource::opacity_or_normal, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::white_or_flat_normal, ` +
        `"normalTexture", "normalSampler_"},`,
        // Slot 3: Standard ambient / PBR emissive, sRGB only for PBR,
        // black unless the emissive factor scales the sample.
        `    {3, MaterialTextureSource::ambient_or_emissive, ` +
        `MaterialTextureSrgb::srgb_unless_standard, ` +
        `MaterialTextureFallback::white_or_emissive_factor, ` +
        `"emissiveTexture", "emissiveSampler"},`,
        // Slot 4: the Standard emissive slot; no pinned name binds it.
        `    {4, MaterialTextureSource::standard_emissive, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::black, ` +
        `"", ""},`,
        // Scene-owned rows follow the mesh slots.
        `MaterialTextureSource::environment_cube`,
        `MaterialTextureSource::brdf_lut`,
        `MaterialTextureSource::bone_palette`,
    ]);
    // The scene-colour grab exists only when transmission is compiled.
    assert.ok(!header.includes("scene_color,\n    material"));
    assert.ok(!header.includes(`"refractionTexture"`));
});

test("extension rows append in the pinned registration order", () => {
    const header = materialTextureSlotsHeader(
        {
            transmission: true,
            clearcoat: true,
            sheen: true,
            iridescence: true,
            lightmap: true,
            metallicReflectanceMap: true,
            reflectanceMap: true,
            specularGlossiness: true,
            occlusionUv2: true,
            standardBump: true,
            standardReflection: true,
            clusteredLights: true,
        },
        [],
        "test",
    );
    assert.ok(
        header.includes(
            "inline constexpr std::size_t material_texture_mesh_slots = 21;",
        ),
    );
    rowOrder(header, [
        // The transmission pair follows the base five...
        `    {5, MaterialTextureSource::transmission, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"refractionMapTexture", "refractionMapSampler"},`,
        `    {6, MaterialTextureSource::thickness, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"thicknessTexture_", "thicknessSampler_"},`,
        // ...then clearcoat intensity/roughness/normal...
        `    {7, MaterialTextureSource::clearcoat, `,
        `    {8, MaterialTextureSource::clearcoat_roughness, `,
        `    {9, MaterialTextureSource::clearcoat_normal, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::flat_normal, ` +
        `"ccNormalTexture", "ccNormalSampler_"},`,
        // ...sheen colour (sRGB) and roughness (linear)...
        `    {10, MaterialTextureSource::sheen_color, ` +
        `MaterialTextureSrgb::srgb, MaterialTextureFallback::white, ` +
        `"sheenTexture_", "sheenSampler_"},`,
        `    {11, MaterialTextureSource::sheen_roughness, ` +
        `MaterialTextureSrgb::linear, `,
        // ...both iridescence maps sRGB...
        `    {12, MaterialTextureSource::iridescence, ` +
        `MaterialTextureSrgb::srgb, `,
        `    {13, MaterialTextureSource::iridescence_thickness, ` +
        `MaterialTextureSrgb::srgb, `,
        // ...the two reflectance maps, whose fragment performs its own RGB
        // decode and therefore binds linear texture views...
        `    {14, MaterialTextureSource::metallic_reflectance, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"metallicReflectanceMap", "metallicReflectanceMapSampler"},`,
        `    {15, MaterialTextureSource::reflectance, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"reflectanceMap", "reflectanceMapSampler"},`,
        // ...the spec-gloss map, appended after the layered extensions so a
        // scene compiling it shifts no index above...
        `    {16, MaterialTextureSource::spec_gloss, ` +
        `MaterialTextureSrgb::srgb, MaterialTextureFallback::white, ` +
        `"specGlossTexture", "specGlossSampler"},`,
        // ...the dedicated uv2 occlusion...
        `    {17, MaterialTextureSource::occlusion_uv2, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"occlusionTexture", "occlusionSampler_"},`,
        // ...the opt-in baked lightmap, uploaded linear because its own
        // fragment does the sRGB decode...
        `    {18, MaterialTextureSource::lightmap, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"lmTexture", "lmSampler"},`,
        // ...then the Standard bump pair, so no index above moves...
        `    {19, MaterialTextureSource::standard_bump, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::flat_normal, ` +
        `"", ""},`,
        // ...and the Standard 2D reflection pair after bump, the same
        // append-only contract.
        `    {20, MaterialTextureSource::standard_reflection, ` +
        `MaterialTextureSrgb::linear, ` +
        `MaterialTextureFallback::white, ` +
        `"", ""},`,
        // The transmission scene-colour grab joins the scene-owned rows.
        `    {material_texture_no_slot, ` +
        `MaterialTextureSource::scene_color, ` +
        `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
        `"refractionTexture", "refractionSampler_"},`,
    ]);
});

test("the reflectance rows serve the pin's two composed bindings", () => {
    const header = materialTextureSlotsHeader(
        {
            ...noFeatures,
            metallicReflectanceMap: true,
            reflectanceMap: true,
        },
        [
            variantWith([
                ["metallicReflectanceMap", "texture_2d<f32>"],
                ["metallicReflectanceMapSampler", "sampler"],
                ["reflectanceMap", "texture_2d<f32>"],
                ["reflectanceMapSampler", "sampler"],
            ]),
        ],
        "test",
    );

    assert.match(header, /MaterialTextureSource::metallic_reflectance/);
    assert.match(header, /MaterialTextureSource::reflectance/);
});

test("each metallic-reflectance map adds exactly its own slot", () => {
    for (const [feature, binding, source, absent] of [
        [
            "metallicReflectanceMap",
            "metallicReflectanceMap",
            "metallic_reflectance",
            "MaterialTextureSource::reflectance",
        ],
        [
            "reflectanceMap",
            "reflectanceMap",
            "reflectance",
            "MaterialTextureSource::metallic_reflectance",
        ],
    ] as const) {
        const header = materialTextureSlotsHeader(
            { ...noFeatures, [feature]: true },
            [
                variantWith([
                    [binding, "texture_2d<f32>"],
                    [`${binding}Sampler`, "sampler"],
                ]),
            ],
            "test",
        );
        assert.match(
            header,
            /inline constexpr std::size_t material_texture_mesh_slots = 6;/,
        );
        assert.match(header, new RegExp(`MaterialTextureSource::${source}`));
        assert.ok(!header.includes(absent));
    }
});

test("each metallic-reflectance map defines only its own native capability", () => {
    for (const [binding, expected, absent] of [
        [
            "metallicReflectanceMap",
            "BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP 1",
            "BBLITE_MATERIAL_REFLECTANCE_MAP 1",
        ],
        [
            "reflectanceMap",
            "BBLITE_MATERIAL_REFLECTANCE_MAP 1",
            "BBLITE_MATERIAL_METALLIC_REFLECTANCE_MAP 1",
        ],
    ] as const) {
        const defines = metallicReflectanceCapabilityDefines(
            new Set([binding]),
        );
        assert.match(defines, new RegExp(expected));
        assert.doesNotMatch(defines, new RegExp(absent));
    }
});

test("a scene-37-shaped scene appends occlusion straight after the base five", () => {
    // Scene 37's variants bind the dedicated uv2 occlusion pair and no
    // other extension, so its occlusion row takes slot 5 where a
    // transmission scene's map pair would sit.
    const header = materialTextureSlotsHeader(
        { ...noFeatures, occlusionUv2: true },
        [
            variantWith([
                ["baseColorTexture", "texture_2d<f32>"],
                ["baseColorSampler", "sampler"],
                ["occlusionTexture", "texture_2d<f32>"],
                ["occlusionSampler_", "sampler"],
                ["iblTexture", "texture_cube<f32>"],
                ["iblSampler", "sampler"],
                ["brdfLUT", "texture_2d<f32>"],
                ["brdfSampler_", "sampler"],
            ]),
        ],
        "test",
    );
    assert.ok(
        header.includes(
            `    {5, MaterialTextureSource::occlusion_uv2, ` +
            `MaterialTextureSrgb::linear, MaterialTextureFallback::white, ` +
            `"occlusionTexture", "occlusionSampler_"},`,
        ),
    );
});

test("a pinned binding no row serves refuses at generation, named", () => {
    assert.throws(
        () =>
            materialTextureSlotsHeader(
                noFeatures,
                [
                    variantWith([
                        ["baseColorTexture", "texture_2d<f32>"],
                        ["anisotropyTexture", "texture_2d<f32>"],
                        ["anisotropySampler_", "sampler"],
                    ]),
                ],
                "test",
            ),
        /'anisotropySampler_', 'anisotropyTexture'/,
    );
    // The morph arms' storage buffers and the geometry arms' uniform
    // block are not texture slots; they must not trip the check.
    const header = materialTextureSlotsHeader(
        noFeatures,
        [
            {
                vertexWgsl:
                    "@group(1) @binding(6) var<storage, read> " +
                    "morphDeltas : array<f32>;\n" +
                    "@group(1) @binding(4) var<uniform> gp : GpUniforms;",
                fragmentWgsl: "@fragment fn main() {}",
            },
        ],
        "test",
    );
    assert.ok(header.includes("material_texture_slots"));
});

test("the emission is deterministic", () => {
    const features: MaterialTextureSlotFeatures = {
        ...noFeatures,
        transmission: true,
        sheen: true,
    };
    assert.equal(
        materialTextureSlotsHeader(features, [], "test"),
        materialTextureSlotsHeader(features, [], "test"),
    );
});
