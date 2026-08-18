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
        // The pin's `material.alpha`: `gltf-pbr-builder.ts` seeds it from the
        // base colour factor's alpha for BLEND and MASK materials only -- an
        // OPAQUE material keeps the default 1 -- and the whiteFallback case
        // assembles with the white factor, so an animated base colour seeds
        // 1 too while its live alpha rides the baseColorFactor lanes
        // (Scene 253's PBRProperties-Transparent, browser buffer#230).
        alpha: "(material.alpha_mode == MaterialAlphaMode::opaque ||" +
            " material.animated_base_color" +
            " ? 1.0f : material.base_color_factor.a)",
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
        // Each of the pin's two calls takes its own texture's transform. Left at
        // the default they both read the writer's `transform` parameter, which
        // the dispatcher fills with the identity — and Scene 29's asset carries
        // `KHR_texture_transform` at u_scale 30 / v_scale -30 on every texture,
        // measured with `scene -- uniforms scene29 --size 256`.
        nestedWriters: {
            writeSheenUvTransform: uvTransformSources({
                sheenUV: "material.sheen_transform",
                sheenRoughUV: "material.sheen_roughness_transform",
            }),
        },
    },
    {
        modulePath: "src/material/pbr/fragments/reflectance-fragment.ts",
        symbolName: "writeReflectanceUBO",
        sourceLocal: "",
        baseField: "occlusionStrength",
        propertySources: {
            // The pin's live `material.occlusionStrength`: seeded by
            // `assemblePbrPropsExt` as `_occlusionImage ? 1.0 : 0` (presence,
            // not the glTF strength -- the loader mirrors that seed) and then
            // overwritten by the animation pointer, so the writer reads the
            // record verbatim.
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
        // Each call takes its own texture's transform: Scene 244 animates the
        // dome's thicknessTexture rotation through KHR_animation_pointer, and
        // an identity here freezes the shimmer the browser rotates.
        nestedWriters: {
            writeRefractionUvTransform: uvTransformSources({
                refractionMapUV: "material.transmission_transform",
                thicknessUV: "material.thickness_transform",
            }),
        },
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
                // Occlusion rides the ORM texture, so it carries that
                // texture's transform: the browser's block for Scene 29 has
                // `occlUVm` equal to `ormUVm` at 30 / -30 where the identity
                // stood here (`scene -- uniforms scene29 --size 256` against
                // the native capture's `pinnedMaterialBlocks`).
                occl: "material.orm_transform",
                // Specular-glossiness has no transform in the loader; the pin
                // reads `tex?.uScale ?? 1` for an absent texture, which is the
                // identity a default-constructed TextureTransform gives.
                specGloss: "bblIdentityTransform",
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
    {
        modulePath: "src/material/pbr/fragments/emissive-fragment.ts",
        symbolName: "writeEmissiveUBO",
        sourceLocal: "",
        baseField: "emissiveColor",
        propertySources: {
            // The pin's `_emissiveColor` is the factor times the strength; the
            // loader folds the strength in at load and keeps the factor apart so
            // a pointer track can rewrite either half.
            _emissiveColor: "material.emissive_factor",
        },
        vectorProperties: { _emissiveColor: 3 },
    },
    {
        // Declared inline on the extension's own literal rather than as a named
        // function, so the lowerer is pointed at the member.
        modulePath: "src/material/pbr/fragments/alpha-test-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "",
        baseField: "alphaCutOff",
        propertySources: {
            _alphaCutOff: "material.alpha_cutoff",
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
/** One vertex input a variant's own vertex stage declares. */
interface VariantAttribute {
    location: number;
    /** The pin's own name for it — `position`, `joints`, `uv2`, … */
    name: string;
    wgslType: string;
}

/**
 * The vertex inputs a composed vertex stage declares.
 *
 * Read from the stage's own parameter list. The pin numbers these densely per
 * variant — a skinned mesh puts `joints` at location 4 where an unskinned one
 * puts nothing — so a fixed layout would feed the wrong attribute to every
 * variant but the widest.
 */
function variantAttributes(vertexWgsl: string): readonly VariantAttribute[] {
    const body = vertexWgsl.slice(vertexWgsl.indexOf("@vertex fn main("));
    const list = body.slice(0, body.indexOf(") ->"));
    const attributes: VariantAttribute[] = [];
    const pattern =
        /@location\((\d+)\)\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>]+)/g;
    for (const match of list.matchAll(pattern)) {
        attributes.push({
            location: Number(match[1]),
            name: match[2]!,
            wgslType: match[3]!,
        });
    }
    return attributes.sort((left, right) => left.location - right.location);
}

/** One resource a variant declares in group 1. */
interface VariantBinding {
    binding: number;
    /** The pin's own name for it -- baseColorTexture, iblSampler, ... */
    name: string;
    kind:
        | "texture2d"
        | "texture2dLoad"
        | "textureCube"
        | "sampler"
        | "storageBuffer"
        | "uniformBuffer";
    /** Which stages declare it; group 1 is shared by both. */
    vertex: boolean;
    fragment: boolean;
}

/**
 * The group-1 resources a composed variant declares, across both its stages.
 *
 * Read from the stages' own declarations rather than rebuilt from the feature
 * bits: the pin assigns these indices densely in extension registration order,
 * so the same index names a different texture in two variants, and a table built
 * from anything but the emitted text would be a second implementation of that
 * order. Both stages are read because group 1 is shared -- a skinned variant
 * declares its bone texture in the vertex stage and nothing else there.
 *
 * A texture the stage only `textureLoad`s is reported separately: WebGPU refuses
 * to bind an rgba32float texture as filterable, and the pin's bone palette is
 * exactly that.
 */
function variantBindings(
    vertexWgsl: string,
    fragmentWgsl: string,
): readonly VariantBinding[] {
    const pattern =
        /@group\(1\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s*([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_<>]+)/g;
    const byBinding = new Map<number, VariantBinding>();
    for (const [text, isVertex] of [
        [vertexWgsl, true],
        [fragmentWgsl, false],
    ] as const) {
        for (const match of text.matchAll(pattern)) {
            const addressSpace = match[2] ?? "";
            const type = match[4]!;
            const name = match[3]!;
            const sampled = new RegExp(
                `textureSample[A-Za-z]*\\(\\s*${name}\\b`,
            ).test(text);
            // The morph arms read their deltas and weights through read-only
            // storage buffers in the vertex stage.
            const kind = addressSpace.startsWith("storage")
                ? "storageBuffer"
                // Group-1 uniform blocks past the hand-managed mesh (0) and
                // material (1): the geometry arms' gpUniforms is the reached
                // one, and Dawn builds its layout entry from this row.
                : addressSpace.startsWith("uniform")
                ? (Number(match[1]) > 1 ? "uniformBuffer" : undefined)
                : type.startsWith("texture_cube")
                ? "textureCube"
                : type.startsWith("texture_")
                ? (sampled ? "texture2d" : "texture2dLoad")
                : type === "sampler"
                ? "sampler"
                : undefined;
            if (!kind) continue;
            const binding = Number(match[1]);
            const existing = byBinding.get(binding);
            if (existing) {
                existing.vertex ||= isVertex;
                existing.fragment ||= !isVertex;
                // A texture sampled in either stage is filterable in both.
                if (kind === "texture2d") existing.kind = kind;
                continue;
            }
            byBinding.set(binding, {
                binding,
                name,
                kind,
                vertex: isVertex,
                fragment: !isVertex,
            });
        }
    }
    return [...byBinding.values()].sort(
        (left, right) => left.binding - right.binding,
    );
}

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
 * The world-matrix lanes the light writers read, from the pin's own builder.
 *
 * Each light writer takes its direction and position out of `light.worldMatrix`
 * rather than off the light, so the authority on what those lanes hold is
 * `src/light/light-matrix.ts` — lowered into this scene as
 * `local_matrix_from_direction`, which sets column 2 to the *normalized*
 * direction and the translation to the position. Reading the lanes off that
 * matrix rather than mapping them onto record fields by hand is what makes the
 * normalization and the signs the pin's: a hand table had `-direction.y`,
 * `-direction.z` and `-position.x` and no normalization, which the browser's own
 * lights block for Scene 7 contradicts — `(0, 1, 0)` for a light created with
 * direction `(0, 1, 0)`.
 */
const lightMatrixLanes: Readonly<Record<number, string>> = Object.fromEntries(
    Array.from({ length: 16 }, (_unused, lane) => [lane, `world[${lane}]`]),
);

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
/**
 * The C++ members for a mirrored block, padded to the pin's own offsets.
 *
 * WGSL and C++ do not agree on where a field lands: a `u32` followed by a
 * `vec4<u32>` sits at byte 68 in a plain C++ struct and at byte 80 in WGSL,
 * which is a silently wrong upload rather than a compile error. The padding is
 * explicit and each field carries a static_assert on its own offset, so a block
 * whose layout drifts fails the build at the field that moved.
 */
function mirroredMembers(
    structName: string,
    fields: readonly { name: string; cppType: string; wgslType: string; size: number }[],
    offsets: readonly number[],
    /** The pin's own total, which rounds up to 16 past the last field. */
    totalBytes?: number,
): { members: string; asserts: string } {
    const members: string[] = [];
    const asserts: string[] = [];
    let cursor = 0;
    fields.forEach((field, index) => {
        const offset = offsets[index]!;
        if (offset > cursor) {
            members.push(
                `    // ${offset - cursor} bytes of WGSL alignment padding.`,
            );
            members.push(
                `    std::array<std::uint8_t, ${offset - cursor}> ` +
                    `_pad${index}{};`,
            );
        }
        members.push(`    // offset ${offset}, ${field.wgslType}`);
        members.push(`    ${field.cppType} ${field.name}{};`);
        asserts.push(
            `static_assert(
` +
                `    offsetof(${structName}, ${field.name}) == ${offset},\n` +
                `    "${structName}::${field.name} must sit where the pin ` +
                `puts it.");`,
        );
        cursor = offset + field.size;
    });
    // WGSL rounds a uniform block up to 16 bytes, so the pin allocates past the
    // last field. Without the tail the C++ struct is smaller than the binding
    // the shader declares, which WebGPU refuses at draw time.
    if (totalBytes !== undefined && totalBytes > cursor) {
        members.push(
            `    // ${totalBytes - cursor} bytes rounding the block up to 16.`,
        );
        members.push(
            `    std::array<std::uint8_t, ${totalBytes - cursor}> _padEnd{};`,
        );
    }
    return {
        members: members.join("\n"),
        asserts: asserts.join("\n"),
    };
}

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
    const mirrored = mirroredMembers("MeshUniforms", fields, offsets);
    let members = mirrored.members;
    let asserts = mirrored.asserts;
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
        const natural = fields.reduce(
            (cursor, field, index) => Math.max(
                cursor,
                offsets[index]! + field.size,
            ),
            0,
        );
        if (arrayOffset > natural) {
            members += `\n    // ${arrayOffset - natural} bytes of WGSL ` +
                `alignment padding.\n` +
                `    std::array<std::uint8_t, ${arrayOffset - natural}> ` +
                `_padArray{};`;
        }
        members += `\n    // offset ${arrayOffset}, ` +
            `array<vec4<u32>, ${arrayField[2]}>\n` +
            `    std::array<std::array<std::uint32_t, 4>, ${arrayField[2]}> ` +
            `${arrayField[1]}{};`;
        asserts += `\nstatic_assert(\n` +
            `    offsetof(MeshUniforms, ${arrayField[1]}) == ` +
            `${arrayOffset},\n` +
            `    "MeshUniforms::${arrayField[1]} must sit where the pin ` +
            `puts it.");`;
        end = arrayOffset + Number.parseInt(arrayField[2]!, 10) * 16;
    }
    return `// src/render/lights-ubo.ts appendMeshLightUboFields\n` +
        `struct MeshUniforms {\n${members}\n};\n` +
        `static_assert(\n    sizeof(MeshUniforms) == ${end},\n` +
        `    "MeshUniforms must be the pinned ${end} bytes.");\n${asserts}`;
}

export function lightUniformsBlock(
    context: LoweringContext,
    maxLights: number,
    /**
     * The light kinds the scene compiles. Only their writers are emitted: each
     * reads the pin's own light world matrix, which is lowered into the scene
     * only for the kinds it reaches, so emitting all four would reference a
     * module a lightless scene does not build.
     */
    lightKinds: readonly string[],
): string {
    const slots: UboFieldSlot[] = [
        { name: "vLightData", offset: 0, lanes: 4 },
        { name: "vLightDiffuse", offset: 16, lanes: 4 },
        { name: "vLightSpecular", offset: 32, lanes: 4 },
        { name: "vLightDirection", offset: 48, lanes: 4 },
    ];
    const writers = lightWriters
        .filter((light) => lightKinds.includes(light.kind.toLowerCase()))
        .map((light) =>
        `// ${light.modulePath} ${light.symbolName}\n` +
        `inline void write_${light.kind.toLowerCase()}_light(\n` +
        `    const LightRecord& light,\n` +
        `    LightEntry& out) {\n` +
        // The pin's own light world matrix, from the module this scene already
        // lowers. Its column 2 is the normalized direction and its translation
        // the position, which is what the writers' lane reads resolve against.
        `    std::array<float, 16> world{};\n` +
        `    local_matrix_from_direction(\n` +
        `        light.direction.x,\n` +
        `        light.direction.y,\n` +
        `        light.direction.z,\n` +
        `        light.position.x,\n` +
        `        light.position.y,\n` +
        `        light.position.z,\n` +
        `        world);\n` +
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
    // Which writer a kind takes is Babylon's own mapping, so it is emitted here
    // rather than restated in each PAL — and a scene that compiles no light of a
    // kind gets no arm for it, which is what keeps the lowered light matrix out
    // of a lightless scene's header.
    // Always declared, so a PAL needs no per-kind guard of its own; a scene that
    // compiles no light gets a body that writes nothing, because it has no light
    // to write.
    const dispatch = [
        "",
        "",
        "/** Fills one LightEntry, whichever kind the light is. */",
        "inline void write_pinned_light(",
        "    const LightRecord& light,",
        "    LightEntry& out) {",
        "    switch (light.kind) {",
        ...lightWriters
            .filter((light) => lightKinds.includes(light.kind.toLowerCase()))
            .flatMap((light) => [
                `        case LightKind::${light.kind.toLowerCase()}:`,
                `            write_${light.kind.toLowerCase()}_light(light, out);`,
                "            return;",
            ]),
        "        default:",
        "            return;",
        "    }",
        "}",
    ].join("\n");
    return `// src/light/types.ts MAX_LIGHTS\n` +
        `inline constexpr std::size_t pinned_max_lights = ${maxLights};\n\n` +
        `// src/render/lights-ubo.ts fillLightsData\n` +
        `struct LightEntry {\n${members}\n};\n` +
        `static_assert(\n    sizeof(LightEntry) == 64,\n` +
        `    "The pinned LightEntry is 4 x vec4.");\n\n` +
        writers.join("\n\n") + dispatch;
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
    const mirrored = mirroredMembers(
        "SceneUniforms",
        fields,
        offsets,
        totalBytes,
    );
    return `// src/shader/scene-uniforms.ts SCENE_UBO_WGSL\n` +
        `struct SceneUniforms {\n${mirrored.members}\n};\n` +
        `static_assert(\n` +
        `    sizeof(SceneUniforms) == ${totalBytes},\n` +
        `    "SceneUniforms must be the pinned ${totalBytes} bytes.");\n` +
        mirrored.asserts;
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
    lightKinds: readonly string[],
    renderableMeshFeatures: readonly number[],
    runtimeMeshFeatures?: number,
    pinnedMaterialCount?: number,
): string {
    const blocks: string[] = [];
    const table: string[] = [];
    // Filled as the variants are emitted, so the indices match the table order.
    const selectors: string[] = [];
    const bindingRows: string[] = [];
    const attributeRows: string[] = [];
    // One case per variant for the type-erased material writer: each variant
    // declares its own struct, so a PAL holding an opaque byte range needs a
    // single entry point that knows which one to build.
    const variantMaterialCases: string[] = [];
    // Which attribute sets the asset draws each material on. One value is the
    // missing half of a PAL's key; more than one means the PAL has to supply the
    // bits itself, because our geometry record does not carry uv2 or vertex
    // colour presence.
    const meshFeaturesByMaterial = new Map<number, Set<number>>();
    for (const variant of variants) {
        for (const selector of variant.selectors) {
            const set = meshFeaturesByMaterial.get(selector.materialIndex) ??
                new Set<number>();
            set.add(selector.meshFeatures);
            meshFeaturesByMaterial.set(selector.materialIndex, set);
        }
    }
    const materialCount = pinnedMaterialCount ??
        (meshFeaturesByMaterial.size === 0
            ? 0
            : Math.max(...meshFeaturesByMaterial.keys()) + 1);
    const meshFeatureRows = Array.from(
        { length: materialCount },
        (_unused, index) => {
            const set = meshFeaturesByMaterial.get(index);
            return set?.size === 1
                ? `    ${[...set][0]},`
                : "    std::numeric_limits<std::size_t>::max(),";
        },
    );
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
        // Named after the emitted file, not the fragment key: the key names the
        // material's feature set, and the same set composes a distinct variant
        // per light mode and tone-mapping state, so keying the struct on it
        // would declare one type several times.
        const name = variantCppName(
            variant.vertex.replace(/\.vert\.wgsl$/, ""),
        );
        const mirroredVariant = mirroredMembers(
            `${name}MaterialUniforms`,
            fields,
            offsets,
            totalBytes,
        );
        const members = mirroredVariant.members;
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
        const reached = extensionWriters.filter((extension) =>
            slots.some((slot) => slot.name === extension.baseField)
        );
        // Every field the variant declares has to be filled by some writer. A
        // field with none uploads a zero, which is the exact failure mode this
        // path exists to remove: the fragment compiles, binds and draws, and one
        // term is missing. Scene 259's emissive colour was that -- 57.6 MAD
        // against 0.001 on the transcribed path -- so an unwritten field is a
        // build error naming the field and the extension that owns it.
        //
        // The base writer covers the fields `_writeMaterialData` names; each
        // extension covers the block starting at its own base field, in
        // declaration order, which is how the pin partitions them too.
        {
            const covered = new Set<string>();
            const bases = [
                ...reached.map((extension) => extension.baseField),
            ];
            let owner = "base";
            for (const slot of slots) {
                if (bases.includes(slot.name)) owner = slot.name;
                if (owner === "base") {
                    if (
                        Object.prototype.hasOwnProperty.call(
                            baseWriter.propertySources,
                            slot.name,
                        ) ||
                        slot.name === "materialAlpha" ||
                        slot.name === "lightFalloffMode" ||
                        slot.name === "normalScale"
                    ) {
                        covered.add(slot.name);
                    }
                } else {
                    covered.add(slot.name);
                }
            }
            const unwritten = slots
                .map((slot) => slot.name)
                .filter((field) =>
                    !covered.has(field) && !field.startsWith("_")
                );
            if (unwritten.length > 0) {
                throw new Error(
                    `Pinned variant '${variant.fragmentKey}' declares ` +
                        `${unwritten.map((f) => `'${f}'`).join(", ")} with no ` +
                        "writer. Add the owning extension to " +
                        "`extensionWriters` in src/pinned-pbr-variant-cpp.ts; " +
                        "an unwritten field uploads a zero and renders as a " +
                        "missing term rather than a failure.",
                );
            }
        }
        const lowered = reached
            .map((extension) =>
                `// ${extension.modulePath} ${extension.symbolName}\n` +
                // Named after the field the writer starts at, not the symbol:
                // several extensions expose their writer as `pbrExt.writeUbo`
                // on their own literal, so the symbol is not unique within a
                // variant while the base field is.
                `inline void write_${name}_${
                    extension.baseField.replace(/\W+/g, "_")
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
                `// materials: ${
                    [
                        ...new Set(
                            variant.selectors.map(
                                (selector) => selector.materialName,
                            ),
                        ),
                    ].join(", ")
                }\n` +
                `struct ${name}MaterialUniforms {\n${members}\n};\n` +
                `static_assert(\n` +
                `    sizeof(${name}MaterialUniforms) == ${totalBytes},\n` +
                `    "${variant.fragmentKey} material UBO must be the pin's ` +
                `${totalBytes} bytes.");\n` + mirroredVariant.asserts + writer +
                (lowered.length > 0
                    ? `\n\n${lowered.join("\n\n")}`
                    : ""),
        );
        for (const selector of variant.selectors) {
            selectors.push(
                `    {${selector.materialIndex}, ${selector.meshFeatures}, ` +
                    `${selector.lightMode}, ` +
                    `"${selector.singleLightType}", ` +
                    `${selector.toneMapping ? "true" : "false"}, ` +
                    `${
                        selector.geometryTask ??
                            "std::numeric_limits<std::size_t>::max()"
                    }, ` +
                    `${table.length}},`,
            );
        }
        // Every writer the variant has, not just the base one. The pin fills its
        // block the same way — `_writeMaterialData` first, then `ext.writeUbo`
        // for each registered extension in registration order — and a writer
        // that is emitted but never called leaves its fields zero. That is how
        // Scene 259's emissive colour rendered 128 levels dark here while the
        // transcribed path measured 0.000.
        // The pin's refraction fragment multiplies its thickness lanes by
        // `ts`, the mesh world's largest column -- but this backend bakes the
        // node transform into the vertices, so its pinned mesh world carries
        // no scale and the fragment's `ts` is 1. The product stays the pin's
        // by moving the scale into the block here, per draw.
        const thicknessScaled: string[] = [];
        if (fields.some((field) => field.name === "refractionParams")) {
            thicknessScaled.push(
                "            block.refractionParams[2] *= thickness_scale;",
            );
        }
        if (fields.some((field) => field.name === "thicknessParams")) {
            thicknessScaled.push(
                "            block.thicknessParams[0] *= thickness_scale;",
                "            block.thicknessParams[1] *= thickness_scale;",
            );
        }
        variantMaterialCases.push(
            [
                `        case ${table.length}: {`,
                `            ${name}MaterialUniforms block{};`,
                `            write_${name}_material(material, block);`,
                ...reached.map((extension) =>
                    `            write_${name}_${
                        extension.baseField.replace(/\W+/g, "_")
                    }(\n` +
                    `                material,\n` +
                    `                bblIdentityTransform,\n` +
                    `                block);`
                ),
                ...thicknessScaled,
                "            std::memcpy(",
                "                destination,",
                "                &block,",
                "                std::min(bytes, sizeof(block)));",
                "            return;",
                "        }",
            ].join("\n"),
        );
        const attributes = variantAttributes(variant.vertexWgsl);
        const bindings = variantBindings(
            variant.vertexWgsl,
            variant.fragmentWgsl,
        );
        // The MRT arm's target count: the geometry rewrite declares one
        // FragmentOutput location per attachment (plus the optional trailing
        // colour); a colour fragment has one and a depth-only view none.
        const fragmentOutputStruct = variant.fragmentWgsl.match(
            /struct FragmentOutput \{[^}]*\}/,
        );
        const colorTargetCount = fragmentOutputStruct
            ? (fragmentOutputStruct[0].match(/@location\(\d+\)/g) ?? [])
                .length
            : variant.fragmentWgsl.includes("@location(0)")
                ? 1
                : 0;
        table.push(
            `    {"${variant.fragmentKey}", "${variant.vertex}", ` +
                `"${variant.fragment}", ${totalBytes}, ` +
                `${bindingRows.length}, ${bindings.length}, ` +
                `${attributeRows.length}, ${attributes.length}, ` +
                `${
                    bindings.filter((binding) =>
                        binding.kind === "sampler" && binding.vertex
                    ).length
                }, ` +
                `${
                    bindings.filter((binding) =>
                        binding.kind === "sampler" && binding.fragment
                    ).length
                }, ` +
                `${
                    variant.fragmentWgsl.includes("@location(0)")
                        ? "false"
                        : "true"
                }, ` +
                `${colorTargetCount}, ` +
                // The geometry LOCAL_POSITION arm's varying reads the raw
                // `position` attribute, which this backend maps onto the
                // vertex's local lanes with the real node world so worldPos
                // stays the identical product.
                `${
                    variant.vertexWgsl.includes("vLocalPos")
                        ? "true"
                        : "false"
                }},`,
        );
        for (const attribute of attributes) {
            attributeRows.push(
                `    {${attribute.location}, "${attribute.name}", ` +
                    `"${attribute.wgslType}"},`,
            );
        }
        for (const entry of bindings) {
            bindingRows.push(
                `    {${entry.binding}, "${entry.name}", ` +
                    `PbrBindingKind::${entry.kind}, ` +
                    `${entry.vertex ? "true" : "false"}, ` +
                    `${entry.fragment ? "true" : "false"}},`,
            );
        }
    }
    return `// ${provenance}
// Generated from the pin's own composed variants; see
// upstream/pbr-variants/variants.json.
#pragma once

#include <array>
#include <cstddef>
#include <string_view>

#include <algorithm>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <limits>

#include <bblite/runtime.hpp>
${
        lightKinds.length > 0
            ? "#include <bblite/upstream/light_matrix.hpp>\n"
            : ""
    }
namespace bbl::upstream {

using bbl::MaterialRecord;
using bbl::LightRecord;
using bbl::LightKind;
using bbl::TextureTransform;

// The pin reads an absent texture's transform through its own nullish
// defaults, which is the identity a default-constructed TextureTransform is.
inline constexpr TextureTransform bblIdentityTransform{};

// The pin's finalWorld for a mesh whose node transform the loader baked into
// its vertices.
inline constexpr std::array<float, 16> pinned_identity_matrix{
    1.0f, 0.0f, 0.0f, 0.0f,
    0.0f, 1.0f, 0.0f, 0.0f,
    0.0f, 0.0f, 1.0f, 0.0f,
    0.0f, 0.0f, 0.0f, 1.0f,
};

${sceneUniformsStruct(sceneUniformsWgsl, pinnedSceneUboBytes)}

${lightUniformsBlock(context, pinnedMaxLights, lightKinds)}

${meshUniformsBlock(variants[0]!.fragmentWgsl, meshLightIndexWordOffset)}

${blocks.join("\n\n")}

// What the pin's fragment declares in group 1, beyond the two uniform blocks.
//
// The indices are dense and assigned in extension registration order, so the
// same index names a different texture in two variants: a PAL builds this
// variant's group-1 layout and bind group from its own row range, never from a
// shared slot order.
enum class PbrBindingKind {
    texture2d,
    // Read with textureLoad rather than sampled: rgba32float, which WebGPU
    // refuses to bind as filterable. The pin's bone palette is one.
    texture2dLoad,
    textureCube,
    sampler,
    // A read-only storage buffer; the morph arms' deltas and weights.
    storageBuffer,
    // A group-1 uniform block past mesh (0) and material (1): the geometry
    // arms' gpUniforms.
    uniformBuffer,
};

struct PbrVariantBinding {
    std::uint32_t binding;
    std::string_view name;
    PbrBindingKind kind;
    /** Which stages declare it; group 1 is shared by both. */
    bool vertex;
    bool fragment;
};

inline constexpr std::array<PbrVariantBinding, ${bindingRows.length}>
    pbr_variant_bindings{{
${bindingRows.join("\n")}
}};

// The vertex inputs one variant's stage declares, in location order. A PAL
// resolves each name against its own vertex layout: the names are the pin's, the
// offsets and formats are the PAL's, and a variant that asks for an input the
// PAL does not carry fails by name.
struct PbrVariantAttribute {
    std::uint32_t location;
    std::string_view name;
    std::string_view wgsl_type;
};

inline constexpr std::array<PbrVariantAttribute, ${attributeRows.length}>
    pbr_variant_attributes{{
${attributeRows.join("\n")}
}};

struct PbrVariantEntry {
    std::string_view key;
    std::string_view vertex_shader;
    std::string_view fragment_shader;
    std::size_t material_ubo_bytes;
    /** Half-open range into the binding table above. */
    std::size_t first_binding;
    std::size_t binding_count;
    /** Half-open range into the attribute table above. */
    std::size_t first_attribute;
    std::size_t attribute_count;
    /**
     * Texture/sampler pairs each stage declares, for the shader create info.
     *
     * The *uniform* slot order is deliberately absent. A stage can declare a
     * block it never reads — the pin's unlit fragment declares its mesh block
     * for the mli() helper and then takes no light path — and Tint strips it, so the
     * compiled HLSL carries fewer uniform registers than the WGSL declares. A
     * backend that binds by slot has to read the order out of the compiled
     * shader, not out of the source.
     */
    std::size_t vertex_sampler_count;
    std::size_t fragment_sampler_count;
    /** A depth-only view's fragment writes no colour target. */
    bool no_color_output;
    /** How many colour targets the fragment writes: one for a colour pass,
     *  zero for a depth-only view, and the attachment count (plus the
     *  optional trailing colour) for a geometry-output MRT arm. */
    std::size_t color_target_count;
    /** Whether the vertex stage carries the LOCAL_POSITION varying, which
     *  reads the raw \`position\` attribute: the PAL binds the vertex's
     *  local lanes and the real node world for such variants. */
    bool uses_local_position;
};

inline constexpr std::array<PbrVariantEntry, ${variants.length}>
    pbr_variants{{
${table.join("\n")}
}};

// The pin's own composition key, per composed variant.
//
// \`pbr-renderable.ts\` builds it per renderable — the material's features, the
// mesh's attributes, the light mode with its single-light kind, and whether tone
// mapping is on — so this is a *renderable* lookup, not a material one: the same
// material on a skinned mesh and on a static one takes two rows, and so does the
// same mesh under one light and under three.
struct PbrVariantSelector {
    std::uint32_t material_index;
    std::uint32_t mesh_features;
    std::uint32_t light_mode;
    std::string_view single_light_type;
    bool tone_mapping;
    /** The geometry-output task an MRT variant draws in, npos for the
     *  colour passes -- part of the key so a geometry draw never resolves
     *  a colour variant or the reverse. */
    std::size_t geometry_task;
    std::size_t variant;
};

inline constexpr std::array<PbrVariantSelector, ${selectors.length}>
    pbr_variant_selectors{{
${selectors.join("\n")}
}};

/**
 * How many materials the composed asset declares.
 *
 * The generated glTF loader appends one MaterialRecord per glTF material, in
 * document order, so a scene whose materials all come from that asset has
 * \`MaterialHandle::value\` equal to the glTF index this table is keyed by. A PAL
 * checks that — \`engine.materials.size() == pbr_variant_material_count\` — before
 * using a handle as a key, because scene code that creates its own material
 * would shift the correspondence.
 */
inline constexpr std::size_t pbr_variant_material_count =
    ${materialCount};

/**
 * The mesh attributes each material is drawn with, or \`npos\` when the asset
 * draws it on more than one attribute set.
 *
 * Generation reads this off the asset. A PAL cannot: our ModelGeometry records
 * tangents and morphs but not whether the primitive carried a second UV set or
 * vertex colours, and the pin composes a different variant for each. Where the
 * asset is unambiguous this is the missing half of the key; where it is not, the
 * caller has to supply the bits itself.
 */
inline constexpr std::array<
    std::size_t,
    ${meshFeatureRows.length}> pbr_variant_mesh_features{{
${meshFeatureRows.join("\n")}
}};

/**
 * The mesh attribute bits per runtime mesh handle.
 *
 * Generation walks each asset's nodes in the pinned loader's own creation
 * order -- nodes by index, a meshed node's primitives in order -- and appends
 * one entry per scene-code builder mesh after them, which is exactly how the
 * runtime hands out mesh handles. This is the mesh half of the variant key,
 * per renderable rather than per material, so one material drawn under two
 * attribute sets resolves each mesh's own variant.
 */
inline constexpr std::array<
    std::size_t,
    ${renderableMeshFeatures.length}> pbr_renderable_mesh_features{{
${renderableMeshFeatures.map((bits) => `    ${bits},`).join("\n")}
}};

/**
 * The bits for meshes created past the static table -- scene code can keep
 * creating meshes after registration, all from the fixed-set builders --
 * or npos when the scene's builders disagree and such a draw must refuse.
 */
inline constexpr std::size_t pbr_runtime_mesh_features =
    ${runtimeMeshFeatures ?? "std::numeric_limits<std::size_t>::max()"};

/**
 * Fills a variant's material block, whichever variant it is.
 *
 * Each variant declares its own struct and its own writer, so a PAL holding an
 * opaque byte range needs one entry point. The bytes written are the struct's,
 * and the destination is checked against the pin's own total for that variant.
 */
inline void write_pbr_variant_material(
    std::size_t variant,
    const MaterialRecord& material,
    void* destination,
    std::size_t bytes,
    float thickness_scale = 1.0f) {
    // Unused when no composed variant carries a thickness lane.
    (void)thickness_scale;
    switch (variant) {
${variantMaterialCases.join("\n")}
        default:
            return;
    }
}

/**
 * The pin's own name for a light's kind.
 *
 * \`getPackedSingleLightType\` returns these strings and the composer keys the
 * single-light arm on them, so a selector row and a live light have to agree on
 * the spelling. LightKind is our enum; the strings are the pin's.
 */
inline std::string_view pinned_single_light_type(const LightRecord& light) {
    switch (light.kind) {
        case LightKind::hemispheric:
            return "hemispheric";
        case LightKind::directional:
            return "directional";
        case LightKind::point:
            return "point";
        case LightKind::spot:
            return "spot";
    }
    return "";
}

/** The variant a renderable composes, or \`npos\` when none was emitted. */
inline std::size_t pbr_variant_for(
    std::uint32_t material_index,
    std::uint32_t mesh_features,
    std::uint32_t light_mode,
    std::string_view single_light_type,
    bool tone_mapping,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    for (const PbrVariantSelector& selector : pbr_variant_selectors) {
        if (
            selector.material_index == material_index &&
            selector.mesh_features == mesh_features &&
            selector.light_mode == light_mode &&
            selector.single_light_type == single_light_type &&
            selector.tone_mapping == tone_mapping &&
            selector.geometry_task == geometry_task) {
            return selector.variant;
        }
    }
    return std::numeric_limits<std::size_t>::max();
}

} // namespace bbl::upstream
`;
}
