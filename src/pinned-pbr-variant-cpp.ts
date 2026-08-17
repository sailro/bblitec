/**
 * The C++ mirror of each pinned PBR variant's material UBO.
 *
 * Babylon composes one fragment per material feature set, and each variant's
 * `MaterialUniforms` declares only the fields its own extensions contribute, in
 * registration order — 32 to 96 bytes across the corpus, against the renderer's
 * single monolithic `PbrUniforms`. The layout is not derived here: it is the
 * `_structBody` the pin's composer returns, mapped field for field, so a
 * variant whose fields move produces a different struct rather than a silently
 * mismatched upload.
 *
 * The offsets are the pin's own: `_writeMaterialData` keys every field off the
 * composer's `_offsets` map, which makes it the authority on where each field
 * sits. WGSL layout rules are applied here only as a cross-check — `f32` aligns
 * to 4, `vec3<f32>` and `vec4<f32>` to 16, the struct rounds up to 16 — and a
 * field or total the pin places elsewhere is a generation failure.
 */
import type { LoweringContext } from "./lowering/context.js";
import {
    lowerPinnedUboWriter,
    type UboFieldSlot,
} from "./lowering/pinned-ubo-writer-lowerer.js";
import type { PinnedVariantManifestEntry } from "./pinned-pbr-variant-output.js";

/**
 * The pinned extension writers, and how each reads our record.
 *
 * The arithmetic is never here — `lowerPinnedUboWriter` walks each declaration's
 * own AST. What this table carries is the correspondence between the pin's
 * property names and ours, plus which field the writer indexes from.
 */
const baseWriter = {
    modulePath: "src/material/pbr/pbr-renderable.ts",
    symbolName: "_writeMaterialData",
    sourceLocal: "",
    baseField: "environmentIntensity",
    propertySources: {
        environmentIntensity: "material.environment_intensity",
        directIntensity: "material.direct_intensity",
        reflectance: "material.reflectance",
        // The pin's `material.alpha`, which the glTF loader seeds from the base
        // colour factor's alpha.
        alpha: "material.base_color_factor.a",
        baseColorFactor: "material.base_color_factor",
        metallicFactor: "material.metallic_factor",
        roughnessFactor: "material.roughness_factor",
        normalTextureScale: "material.normal_texture_scale",
        // Nothing sets the pin's `usePhysicalLightFalloff`: the generated
        // punctual path is the physical inverse-square mode unconditionally
        // (docs/fidelity.md), which is the pin's own default.
        usePhysicalLightFalloff: null as string | null,
    },
    vectorProperties: { baseColorFactor: 4 },
} as const;

const extensionWriters: ReadonlyArray<{
    modulePath: string;
    symbolName: string;
    sourceLocal: string;
    baseField: string;
    propertySources: Readonly<Record<string, string | null>>;
    /** Properties that are colours rather than scalars, and their lane count. */
    vectorProperties?: Readonly<Record<string, number>>;
    nestedWriters?: Readonly<
        Record<
            string,
            (baseName: string) => Readonly<Record<string, string | null>>
        >
    >;
}> = [
    {
        modulePath: "src/material/pbr/fragments/clearcoat-fragment.ts",
        symbolName: "writeClearcoatUBO",
        sourceLocal: "cc",
        baseField: "ccParams",
        propertySources: {
            indexOfRefraction: "material.clearcoat_index_of_refraction",
            intensity: "material.clearcoat_intensity",
            roughness: "material.clearcoat_roughness",
            bumpTextureScale: "material.clearcoat_normal_scale",
        },
        nestedWriters: { writeCcUvTransform: uvTransformSources() },
    },
    {
        modulePath: "src/material/pbr/fragments/iridescence-fragment.ts",
        symbolName: "writeIridescenceUBO",
        sourceLocal: "iri",
        baseField: "iridescenceParams",
        propertySources: {
            intensity: "material.iridescence_intensity",
            indexOfRefraction: "material.iridescence_index_of_refraction",
            minimumThickness: "material.iridescence_minimum_thickness",
            maximumThickness: "material.iridescence_maximum_thickness",
        },
        nestedWriters: { writeUvTransform: uvTransformSources() },
    },
    {
        modulePath: "src/material/pbr/fragments/sheen-fragment.ts",
        symbolName: "writeSheenUBO",
        sourceLocal: "sh",
        baseField: "sheenParams",
        propertySources: {
            color: "material.sheen_color",
            intensity: "material.sheen_intensity",
            roughness: "material.sheen_roughness",
            // `sh.texture ? 1 : 0` — presence is the byte payload being non-empty.
            texture: "!material.sheen_color_texture.bytes.empty()",
        },
        vectorProperties: { color: 3 },
        nestedWriters: { writeSheenUvTransform: uvTransformSources() },
    },
    {
        modulePath: "src/material/pbr/fragments/reflectance-fragment.ts",
        symbolName: "writeReflectanceUBO",
        sourceLocal: "",
        baseField: "occlusionStrength",
        propertySources: {
            occlusionStrength: "material.occlusion_strength",
            _metallicF0Factor: "material.metallic_f0_factor",
            _specularWeight: "material.specular_weight",
            _metallicReflectanceColor: "material.metallic_reflectance_color",
        },
        vectorProperties: { _metallicReflectanceColor: 3 },
        nestedWriters: { writeReflUvTransform: uvTransformSources() },
    },
    {
        // Fills refractionParams, volumeParams and thicknessParams from three
        // separate offset lookups; the lowerer resolves each `data[x + n]`
        // against the field its own local names.
        modulePath: "src/material/pbr/fragments/refraction-rtt-fragment.ts",
        symbolName: "writeRefractionUBO",
        sourceLocal: "ss",
        baseField: "refractionParams",
        propertySources: {
            refraction: "material",
            intensity: "material.transmission_factor",
            indexOfRefraction: "material.index_of_refraction",
            useThicknessAsDepth: "material.use_thickness_as_depth",
            thickness: "material",
            max: "material.thickness",
            tint: "material",
            color: "material.attenuation_color",
            atDistance: "material.attenuation_distance",
            dispersion: "material.dispersion",
            // `Math.max(ss.tint?.atDistance ?? 1, 1e-4)` guards a zero
            // distance; `min` is that clamp's own name in the pinned helper.
            min: "1.0e-4f",
        },
        vectorProperties: { color: 3 },
        nestedWriters: { writeRefractionUvTransform: uvTransformSources() },
    },
    {
        // The per-texture UV transforms. The pin exposes this writer as a method
        // on its exported `pbrExt` literal and calls a shared helper once per
        // slot, each with its own base name, so each slot resolves to the
        // record's own transform for that texture.
        modulePath: "src/material/pbr/fragments/uv-transform-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "m",
        baseField: "baseColorUVm",
        propertySources: {
            baseColorTexture: "material.base_color_transform",
            normalTexture: "material.normal_transform",
            ormTexture: "material.orm_transform",
            emissiveTexture: "material.emissive_transform",
            specGlossTexture: "bblIdentityTransform",
            occlusionTexture: "bblIdentityTransform",
        },
        nestedWriters: {
            writeOne: uvTransformSources({
                baseColor: "material.base_color_transform",
                normal: "material.normal_transform",
                orm: "material.orm_transform",
                emissive: "material.emissive_transform",
                // Neither slot carries a transform of its own here: occlusion
                // binds through the ORM slot (docs/fidelity.md), and the
                // specular-glossiness pair has no transform in the loader. The
                // pin reads `tex?.uScale ?? 1` for an absent texture, which is
                // the identity a default-constructed TextureTransform gives.
                specGloss: "bblIdentityTransform",
                occl: "bblIdentityTransform",
            }),
        },
    },
    {
        modulePath: "src/material/pbr/fragments/unlit-fragment.ts",
        symbolName: "writeUnlitUBO",
        sourceLocal: "",
        baseField: "unlitColor",
        propertySources: {
            _unlit: "material.unlit",
            // The pin's own unlit tint. Nothing in the loader or the
            // scene-code setters writes it, so our records do not carry it and
            // the read folds to the pin's `?? [1, 1, 1]` default.
            _unlitColor: null,
        },
        vectorProperties: {},
    },
];

/**
 * The shared UV-transform helper's reads, against our own `TextureTransform`.
 *
 * The pin calls the helper once per texture slot, each with its own base name
 * (`writeOne(data, offsets, "baseColor", ...)`), and each slot has its own
 * transform on the record. So the sources are a function of that base name
 * rather than one table: the extension slots read the transform passed in, and
 * a named base-colour or normal slot reads the record's own.
 */
function uvTransformSources(
    slotTransforms: Readonly<Record<string, string>> = {},
): (baseName: string) => Readonly<Record<string, string | null>> {
    return (baseName) => {
        const owner = slotTransforms[baseName] ?? "transform";
        return {
            uScale: `${owner}.u_scale`,
            vScale: `${owner}.v_scale`,
            uAng: `${owner}.rotation`,
            uOffset: `${owner}.u_offset`,
            vOffset: `${owner}.v_offset`,
        };
    };
}

interface VariantField {
    name: string;
    wgslType: string;
    cppType: string;
    align: number;
    size: number;
}

const fieldTypes: Readonly<
    Record<string, { cppType: string; align: number; size: number }>
> = {
    "f32": { cppType: "float", align: 4, size: 4 },
    "vec3<f32>": { cppType: "std::array<float, 3>", align: 16, size: 12 },
    "vec4<f32>": { cppType: "std::array<float, 4>", align: 16, size: 16 },
    // The scene block carries matrices where the material blocks do not.
    "mat4x4<f32>": { cppType: "std::array<float, 16>", align: 16, size: 64 },
    // The mesh block carries its light count and index list.
    "u32": { cppType: "std::uint32_t", align: 4, size: 4 },
};

/** A WGSL identifier reused verbatim as the C++ member name. */
function memberName(name: string): string {
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        throw new Error(
            `Pinned material UBO field '${name}' is not an identifier.`,
        );
    }
    return name;
}

export function parseVariantFields(structBody: string): VariantField[] {
    const fields: VariantField[] = [];
    for (const line of structBody.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const match = /^(\w+)\s*:\s*(.+?),?$/.exec(trimmed);
        if (!match) {
            throw new Error(
                `Pinned material UBO declaration is not a field: '${trimmed}'.`,
            );
        }
        const wgslType = match[2]!.trim();
        const mapped = fieldTypes[wgslType];
        if (!mapped) {
            throw new Error(
                `Pinned material UBO field '${match[1]}' has unsupported ` +
                    `type '${wgslType}'.`,
            );
        }
        fields.push({
            name: memberName(match[1]!),
            wgslType,
            cppType: mapped.cppType,
            align: mapped.align,
            size: mapped.size,
        });
    }
    if (fields.length === 0) {
        throw new Error("Pinned material UBO declares no fields.");
    }
    return fields;
}

/** Offsets and total size under WGSL uniform layout rules. */
export function variantLayout(
    fields: readonly VariantField[],
): { offsets: number[]; totalBytes: number } {
    const offsets: number[] = [];
    let cursor = 0;
    for (const field of fields) {
        cursor = Math.ceil(cursor / field.align) * field.align;
        offsets.push(cursor);
        cursor += field.size;
    }
    return { offsets, totalBytes: Math.ceil(cursor / 16) * 16 };
}

/** A C++ identifier for a variant key such as `ibl|reflectance|refraction`. */
export function variantCppName(fragmentKey: string): string {
    const parts = fragmentKey
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part !== "");
    return parts
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("") || "Base";
}

/**
 * The pin's own `SceneUniforms`, mirrored in C++ from its own declaration.
 *
 * `shader/scene-uniforms.ts` says it itself: "Only the size + the WGSL source
 * are exported." The composer injects that identical text into every material
 * template's scene slot, so reading the layout out of it is what keeps this
 * struct and every variant's fragment from disagreeing. The caller passes the
 * WGSL because the renderer lowerer already reads it for the shaders.
 */
/**
 * The pinned per-light UBO writers, one per light kind.
 *
 * `render/lights-ubo.ts` states the layout — "16-byte header (u32 count + 3×u32
 * padding) followed by up to MAX_LIGHTS × LightEntry (4 × vec4 = 64 bytes
 * each)" — and each light fills its own entry through `_writeLightUbo`. Those
 * writers decide which lane carries what: the kind tag in `vLightData.w`, the
 * spot exponent in `vLightSpecular.w`, its cone cosine in `vLightDirection.w`,
 * and a hemispheric light's ground colour reusing `vLightDirection`. None of
 * that is restated here; it is walked out of each declaration.
 */
const lightWriters: ReadonlyArray<{
    kind: string;
    modulePath: string;
    symbolName: string;
}> = [
    {
        kind: "Point",
        modulePath: "src/light/point-light.ts",
        symbolName: "createPointLight#_writeLightUbo",
    },
    {
        kind: "Directional",
        modulePath: "src/light/directional-light.ts",
        symbolName: "createDirectionalLight#_writeLightUbo",
    },
    {
        kind: "Spot",
        modulePath: "src/light/spot-light.ts",
        symbolName: "createSpotLight#_writeLightUbo",
    },
    {
        kind: "Hemispheric",
        modulePath: "src/light/hemispheric.ts",
        symbolName: "createHemisphericLight#_writeLightUbo",
    },
];

/** How the light writers' reads map onto our own `LightRecord`. */
const lightSources: Readonly<Record<string, string>> = {
    worldMatrix: "light.world_matrix", // lanes resolve through laneSources
    diffuse: "light.diffuse_color",
    diffuseColor: "light.diffuse_color",
    specular: "light.specular_color",
    specularColor: "light.specular_color",
    groundColor: "light.ground_color",
    intensity: "light.intensity",
    range: "light.range",
    exponent: "light.exponent",
    // The factory computes `Math.cos(angle * 0.5)` once and the writer captures
    // it; the record carries that cosine for the precision reason recorded in
    // TODO.md rather than recomputing it per frame.
    _cosHalfAngle: "light.cos_half_angle",
    // `Number.MAX_VALUE` fills a directional light's range slot.
    MAX_VALUE: "std::numeric_limits<float>::max()",
};

/**
 * The world-matrix lanes the light writers read, against what the record keeps.
 *
 * `LightRecord` stores the values those lanes carry rather than the matrix, and
 * the glTF loader applies the mirror as it fills them — `position` takes
 * `-w[12]`, `direction` takes `w[8]`, `-w[9]`, `-w[10]` — so reading the lanes
 * back means undoing that same convention here.
 */
const lightMatrixLanes: Readonly<Record<number, string>> = {
    8: "light.direction.x",
    9: "-light.direction.y",
    10: "-light.direction.z",
    12: "-light.position.x",
    13: "light.position.y",
    14: "light.position.z",
};

const lightVectors: Readonly<Record<string, number>> = {
    worldMatrix: 16,
    diffuse: 3,
    diffuseColor: 3,
    specular: 3,
    specularColor: 3,
    groundColor: 3,
};

/** The pin's `LightEntry`, and a writer per light kind. */
/**
 * The pin's own `MeshUniforms`, mirrored from the fragment that declares it.
 *
 * The block is composed rather than written down: a base `world` matrix plus the
 * fields `appendMeshLightUboFields` pushes (`lc`, then `li` sized to
 * `ceil(MAX_LIGHTS / 4)`). So the authority is the struct the scene's own
 * composed fragment declares, and `lights-ubo.ts` is the cross-check —
 * `writeMeshLightSelection` writes the count at word 16 and the indices from
 * `MSH_LIGHT_INDEX_WORD_OFFSET`, which those offsets have to agree with.
 */
export function meshUniformsBlock(
    fragmentWgsl: string,
    lightIndexWordOffset: number,
): string {
    const body = /struct MeshUniforms\s*\{([\s\S]*?)\}/.exec(fragmentWgsl);
    if (!body) {
        throw new Error(
            "A pinned composed fragment no longer declares struct " +
                "MeshUniforms.",
        );
    }
    // `li` is an array of vec4<u32>; its element count comes from the
    // declaration rather than from MAX_LIGHTS restated here.
    const arrayField =
        /(\w+)\s*:\s*array<vec4<u32>\s*,\s*(\d+)>/.exec(body[1]!);
    const scalarText = body[1]!
        .replace(/(\w+)\s*:\s*array<vec4<u32>\s*,\s*\d+>\s*,?/g, "")
        .split(/[,\n]/)
        .map((part) => part.replace(/\/\/.*$/, "").trim())
        .filter((part) => part !== "")
        .map((part) => `${part},`)
        .join("\n");
    const fields = parseVariantFields(scalarText);
    const { offsets, totalBytes } = variantLayout(fields);
    let members = fields
        .map((field, index) =>
            `    // offset ${offsets[index]}, ${field.wgslType}\n` +
            `    ${field.cppType} ${field.name}{};`
        )
        .join("\n");
    let end = totalBytes;
    if (arrayField) {
        // The array aligns to 16 like any vec4, after the scalars.
        const arrayOffset = Math.ceil(
            fields.reduce(
                (cursor, field, index) => Math.max(
                    cursor,
                    offsets[index]! + field.size,
                ),
                0,
            ) / 16,
        ) * 16;
        if (arrayOffset !== lightIndexWordOffset * 4) {
            throw new Error(
                `Pinned MSH_LIGHT_INDEX_WORD_OFFSET is ` +
                    `${lightIndexWordOffset} (byte ` +
                    `${lightIndexWordOffset * 4}); the mirrored mesh layout ` +
                    `puts '${arrayField[1]}' at byte ${arrayOffset}.`,
            );
        }
        members += `\n    // offset ${arrayOffset}, ` +
            `array<vec4<u32>, ${arrayField[2]}>\n` +
            `    std::array<std::array<std::uint32_t, 4>, ${arrayField[2]}> ` +
            `${arrayField[1]}{};`;
        end = arrayOffset + Number.parseInt(arrayField[2]!, 10) * 16;
    }
    return `// src/render/lights-ubo.ts appendMeshLightUboFields\n` +
        `struct MeshUniforms {\n${members}\n};\n` +
        `static_assert(\n    sizeof(MeshUniforms) <= ${end},\n` +
        `    "MeshUniforms exceeds the pinned ${end} bytes.");`;
}

export function lightUniformsBlock(
    context: LoweringContext,
    maxLights: number,
): string {
    const slots: UboFieldSlot[] = [
        { name: "vLightData", offset: 0, lanes: 4 },
        { name: "vLightDiffuse", offset: 16, lanes: 4 },
        { name: "vLightSpecular", offset: 32, lanes: 4 },
        { name: "vLightDirection", offset: 48, lanes: 4 },
    ];
    const writers = lightWriters.map((light) =>
        `// ${light.modulePath} ${light.symbolName}\n` +
        `inline void write_${light.kind.toLowerCase()}_light(\n` +
        `    const LightRecord& light,\n` +
        `    LightEntry& out) {\n` +
        `${
            lowerPinnedUboWriter(context, {
                modulePath: light.modulePath,
                symbolName: light.symbolName,
                sourceLocal: "",
                offsetParameter: "offset",
                baseField: "vLightData",
                propertySources: lightSources,
                vectorProperties: lightVectors,
                laneSources: { worldMatrix: lightMatrixLanes },
                slots,
            }).join("\n")
        }\n}`
    );
    const members = slots
        .map((slot) =>
            `    // offset ${slot.offset}, vec4<f32>\n` +
            `    std::array<float, 4> ${slot.name}{};`
        )
        .join("\n");
    return `// src/light/types.ts MAX_LIGHTS\n` +
        `inline constexpr std::size_t pinned_max_lights = ${maxLights};\n\n` +
        `// src/render/lights-ubo.ts fillLightsData\n` +
        `struct LightEntry {\n${members}\n};\n` +
        `static_assert(\n    sizeof(LightEntry) == 64,\n` +
        `    "The pinned LightEntry is 4 x vec4.");\n\n` +
        writers.join("\n\n");
}

export function sceneUniformsStruct(
    sceneUniformsWgsl: string,
    pinnedBytes?: number,
): string {
    // The packaged module is minified: the struct name is mangled and the
    // declaration is one line. The binding names it, so that is what identifies
    // it rather than a literal `SceneUniforms`.
    const binding =
        /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s*scene\s*:\s*(\w+)\s*;/
            .exec(sceneUniformsWgsl);
    if (!binding) {
        throw new Error(
            "Pinned scene uniforms no longer bind at @group(0) @binding(0).",
        );
    }
    const body = new RegExp(
        `struct ${binding[1]}\\s*\\{([\\s\\S]*?)\\}`,
    ).exec(sceneUniformsWgsl);
    if (!body) {
        throw new Error(
            `Pinned scene uniforms no longer declare struct ` +
                `'${binding[1]}'.`,
        );
    }
    const fields = parseVariantFields(
        body[1]!
            .split(/[,\n]/)
            .map((part) => part.replace(/\/\/.*$/, "").trim())
            .filter((part) => part !== "")
            .map((part) => `${part},`)
            .join("\n"),
    );
    const { offsets, totalBytes } = variantLayout(fields);
    // `scene-uniforms-size.ts` publishes the byte count the pin allocates for
    // this block. The layout above is derived from the declaration
    // independently, so the two agreeing is what makes this the pin's block
    // rather than a plausible reading of it.
    if (pinnedBytes !== undefined && pinnedBytes !== totalBytes) {
        throw new Error(
            `Pinned SCENE_UBO_BYTES is ${pinnedBytes}; the mirrored scene ` +
                `layout computes ${totalBytes}.`,
        );
    }
    const members = fields
        .map((field, index) =>
            `    // offset ${offsets[index]}, ${field.wgslType}\n` +
            `    ${field.cppType} ${field.name}{};`
        )
        .join("\n");
    return `// src/shader/scene-uniforms.ts SCENE_UBO_WGSL\n` +
        `struct SceneUniforms {\n${members}\n};\n` +
        `static_assert(\n` +
        `    sizeof(SceneUniforms) <= ${totalBytes},\n` +
        `    "SceneUniforms exceeds the pinned ${totalBytes} bytes.");`;
}

/**
 * Emits `upstream/pbr_variants.hpp`: one struct per variant plus the table that
 * names each variant's stages and byte size.
 */
export function pinnedPbrVariantsHeader(
    context: LoweringContext,
    sceneUniformsWgsl: string,
    pinnedSceneUboBytes: number,
    meshLightIndexWordOffset: number,
    pinnedMaxLights: number,
    provenance: string,
    variants: readonly PinnedVariantManifestEntry[],
): string {
    const blocks: string[] = [];
    const table: string[] = [];
    for (const variant of variants) {
        const spec = variant.materialUbo as {
            _structBody?: string;
            _totalBytes?: number;
            _offsets?: Record<string, number>;
        };
        if (typeof spec?._structBody !== "string") {
            throw new Error(
                `Pinned variant '${variant.fragmentKey}' carries no material ` +
                    "UBO body.",
            );
        }
        const fields = parseVariantFields(spec._structBody);
        const computed = variantLayout(fields);
        const totalBytes = spec._totalBytes ?? computed.totalBytes;
        if (spec._totalBytes !== undefined && spec._totalBytes !== computed.totalBytes) {
            throw new Error(
                `Pinned variant '${variant.fragmentKey}' material UBO is ` +
                    `${spec._totalBytes} bytes; the mirrored layout computes ` +
                    `${computed.totalBytes}.`,
            );
        }
        // The pin's own offsets where it publishes them — `_writeMaterialData`
        // keys every field off this map, so it is the authority. The computed
        // layout stays as the cross-check on the fields it does not name.
        const pinned = spec._offsets ?? {};
        const offsets = fields.map((field, index) =>
            pinned[field.name] ?? computed.offsets[index]!
        );
        for (const [name, offset] of Object.entries(pinned)) {
            const index = fields.findIndex((field) => field.name === name);
            if (index >= 0 && computed.offsets[index] !== offset) {
                throw new Error(
                    `Pinned variant '${variant.fragmentKey}' field '${name}' ` +
                        `sits at ${offset}; the mirrored layout computes ` +
                        `${computed.offsets[index]}.`,
                );
            }
        }
        const name = variantCppName(variant.fragmentKey);
        const members = fields
            .map((field, index) =>
                `    // offset ${offsets[index]}, ${field.wgslType}\n` +
                `    ${field.cppType} ${field.name}{};`
            )
            .join("\n");
        const slots: UboFieldSlot[] = fields.map((field, index) => ({
            name: field.name,
            offset: offsets[index]!,
            lanes: field.wgslType === "f32"
                ? 1
                : field.wgslType === "vec3<f32>"
                ? 3
                : 4,
        }));
        // Every pinned extension writer whose base field this variant declares,
        // lowered from that declaration's own AST. The arithmetic is the pin's.
        const lowered = extensionWriters
            .filter((extension) =>
                slots.some((slot) => slot.name === extension.baseField)
            )
            .map((extension) =>
                `// ${extension.modulePath} ${extension.symbolName}\n` +
                `inline void write_${name}_${
                    extension.symbolName.replace(/\W+/g, "_")
                }(\n` +
                `    const MaterialRecord& material,\n` +
                `    const TextureTransform& transform,\n` +
                `    ${name}MaterialUniforms& out) {\n` +
                `${
                    lowerPinnedUboWriter(context, {
                        modulePath: extension.modulePath,
                        symbolName: extension.symbolName,
                        sourceLocal: extension.sourceLocal,
                        baseField: extension.baseField,
                        propertySources: extension.propertySources,
                        slots,
                        ...(extension.vectorProperties
                            ? { vectorProperties: extension.vectorProperties }
                            : {}),
                        ...(extension.nestedWriters
                            ? { nestedWriters: extension.nestedWriters }
                            : {}),
                    }).join("\n")
                }\n}`
            );
        let writer: string;
        try {
            // The pin's own `_writeMaterialData`, lowered like every extension
            // writer. It fills only the fields it owns and delegates the rest,
            // which is why a hand-written version kept failing on fields the
            // extension writers own.
            writer = `\n\ninline void write_${name}_material(\n` +
                `    const MaterialRecord& material,\n` +
                `    ${name}MaterialUniforms& out) {\n` +
                `${
                    lowerPinnedUboWriter(context, {
                        modulePath: baseWriter.modulePath,
                        symbolName: baseWriter.symbolName,
                        sourceLocal: baseWriter.sourceLocal,
                        baseField: baseWriter.baseField,
                        propertySources: baseWriter.propertySources,
                        vectorProperties: baseWriter.vectorProperties,
                        slots,
                    }).join("\n")
                }\n}`;
        } catch (error) {
            // Not fatal: the struct and the compiled stages are usable, and
            // naming the unmapped field is more useful than failing every
            // scene that reaches the variant before its fields are mapped.
            writer = `\n\n// No writer yet — ${
                error instanceof Error ? error.message : String(error)
            }`;
        }
        blocks.push(
            `// ${variant.fragmentKey}\n` +
                `// materials: ${variant.materials.join(", ")}\n` +
                `struct ${name}MaterialUniforms {\n${members}\n};\n` +
                `static_assert(\n` +
                `    sizeof(${name}MaterialUniforms) <= ${totalBytes},\n` +
                `    "${variant.fragmentKey} material UBO exceeds the pin's ` +
                `${totalBytes} bytes.");` + writer +
                (lowered.length > 0
                    ? `\n\n${lowered.join("\n\n")}`
                    : ""),
        );
        table.push(
            `    {"${variant.fragmentKey}", "${variant.vertex}", ` +
                `"${variant.fragment}", ${totalBytes}},`,
        );
    }
    return `// ${provenance}
// Generated from the pin's own composed variants; see
// upstream/pbr-variants/variants.json.
#pragma once

#include <array>
#include <cstddef>
#include <string_view>

#include <cstdint>
#include <limits>

#include <bblite/runtime.hpp>

namespace bbl::upstream {

using bbl::MaterialRecord;
using bbl::LightRecord;
using bbl::TextureTransform;

// The pin reads an absent texture's transform through its own nullish
// defaults, which is the identity a default-constructed TextureTransform is.
inline constexpr TextureTransform bblIdentityTransform{};

${sceneUniformsStruct(sceneUniformsWgsl, pinnedSceneUboBytes)}

${lightUniformsBlock(context, pinnedMaxLights)}

${meshUniformsBlock(variants[0]!.fragmentWgsl, meshLightIndexWordOffset)}

${blocks.join("\n\n")}

struct PbrVariantEntry {
    std::string_view key;
    std::string_view vertex_shader;
    std::string_view fragment_shader;
    std::size_t material_ubo_bytes;
};

inline constexpr std::array<PbrVariantEntry, ${variants.length}>
    pbr_variants{{
${table.join("\n")}
}};

} // namespace bbl::upstream
`;
}
