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
import ts from "typescript";
import { floatLiteral } from "./cpp-literals.js";
import { pinnedLightModeCpp } from "./pinned-light-mode.js";
import type { LoweringContext } from "./lowering/context.js";
import {
    lowerPinnedUboWriter,
    type UboFieldSlot,
} from "./lowering/pinned-ubo-writer-lowerer.js";
import type { PinnedVariantManifestEntry } from "./pinned-pbr-variant-output.js";
import {
    pinnedNumericConstant,
    type PinnedStandardVariantManifestEntry,
} from "./pinned-standard-variants.js";

/**
 * The float lanes a scalar or vector UBO field spans, shared by the PBR and
 * Standard slot builders. Anything that is neither `f32` nor `vec3<f32>` is
 * the four-lane `vec4<f32>`, exactly as both builders spelled it.
 */
function laneCount(wgslType: string): number {
    return wgslType === "f32" ? 1 : wgslType === "vec3<f32>" ? 3 : 4;
}

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
        // The pin writes `material.alpha` into the core UBO independently of
        // an optional baseColorFactor vec4; the generated fragment multiplies
        // the two alpha inputs when both are present.
        alpha: "material.alpha",
        baseColorFactor: "material.base_color_factor",
        metallicFactor: "material.metallic_factor",
        roughnessFactor: "material.roughness_factor",
        normalTextureScale: "material.normal_texture_scale",
        // The pin's default-true `usePhysicalLightFalloff`, which its own
        // writer folds into the `lightFalloffMode` lane as
        // `=== false ? 0 : 1`. Every composed punctual arm carries both
        // falloffs and selects on that lane, so this is a value rather than
        // a composition key.
        usePhysicalLightFalloff: "material.use_physical_light_falloff",
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
        // One lane and no transform: the lightmap's blend, UV set, gamma
        // decode and V flip are all composed into the fragment, so the
        // level is the only thing the block carries.
        modulePath: "src/material/pbr/fragments/lightmap-fragment.ts",
        symbolName: "writeLightmapUBO",
        sourceLocal: "",
        baseField: "lmLvl",
        propertySources: {
            lightmapLevel: "material.lightmap_level",
        },
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
        // The one extension whose writer is a method on its own `pbrExt`
        // literal rather than a top-level `writeXUBO`. Its texture arm --
        // the `anisotropyUVm`/`anisotropyUVt` pair -- rides the second
        // feature bit, which no reached call sets, so the nested transform
        // writer folds away with the offsets it looks up.
        modulePath: "src/material/pbr/fragments/anisotropy-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "aniso",
        baseField: "anisotropyParams",
        propertySources: {
            intensity: "material.anisotropy_intensity",
            direction: "material.anisotropy_direction",
            // Named as absent so a variant that did declare the transform
            // fields would fail here rather than read a record field that
            // does not exist.
            texture: null,
        },
        vectorProperties: { direction: 2 },
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
        modulePath: "src/material/pbr/fragments/subsurface-fragment.ts",
        symbolName: "writeSubsurfaceUBO",
        sourceLocal: "ss",
        baseField: "subsurfaceParams",
        propertySources: {
            translucency: "material",
            intensity: "material.subsurface_intensity",
            color: "material.subsurface_color",
            diffusionDistance:
                "material.subsurface_diffusion_distance",
            thickness: "material",
            min: "material.subsurface_minimum_thickness",
            max: "material.subsurface_maximum_thickness",
            colorTexture: null,
            intensityTexture: null,
        },
        vectorProperties: { color: 3, diffusionDistance: 3 },
        nestedWriters: { writeSsUvTransform: uvTransformSources() },
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
            occlusionTexture: "material.occlusion_transform",
        },
        nestedWriters: {
            writeOne: uvTransformSources({
                baseColor: "material.base_color_transform",
                normal: "material.normal_transform",
                orm: "material.orm_transform",
                emissive: "material.emissive_transform",
                // Occlusion's own carrier, which is what the pin passes:
                // `writeOne(..., "occl", m.occlusionTexture)` reads the
                // texture `buildDefaultPbrTexturesExt` wrapped from the
                // occlusion textureInfo, not the ORM one. The two agree
                // wherever a material gives both slots the same transform --
                // Scene 29's asset carries 30 / -30 on every texture, which
                // is what `scene -- uniforms scene29 --size 256` shows in
                // `occlUVm` -- and part where the occlusion slot declares
                // its own, which is the orm-unpack split's whole point.
                occl: "material.occlusion_transform",
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
            // The pin's own unlit tint, which `setPbrUnlit` takes as its
            // optional second argument. The record defaults to the pin's own
            // `?? [1, 1, 1]`, so a material nothing tinted writes what the
            // folded default used to.
            _unlitColor: "material.unlit_color",
        },
        vectorProperties: { _unlitColor: 3 },
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

/**
 * The one field type whose element count is part of the declaration.
 *
 * `array<vec4<u32>, N>` is the mesh block's light-index list, and N is the
 * pin's own `MAX_LIGHTS / 4` — read from the text rather than restated, so a
 * pin that changed the constant changes the mirror with it.
 */
function arrayFieldType(
    wgslType: string,
): { cppType: string; align: number; size: number } | undefined {
    const match = /^array<vec4<u32>\s*,\s*(\d+)>$/.exec(wgslType);
    if (!match) return undefined;
    const count = Number.parseInt(match[1]!, 10);
    return {
        cppType: `std::array<std::array<std::uint32_t, 4>, ${count}>`,
        align: 16,
        size: count * 16,
    };
}

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
        const mapped = fieldTypes[wgslType] ?? arrayFieldType(wgslType);
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
/** What a composed fragment stage writes, and how many targets it names. */
interface VariantColorOutput {
    noColorOutput: boolean;
    colorTargetCount: number;
}

/**
 * The colour targets a composed fragment stage declares.
 *
 * Read off the ENTRY POINT's return clause, never off the text: the fragment's
 * own input struct numbers its varyings with `@location(n)` too -- the first of
 * them is `@location(0) worldPos` -- so asking whether the source mentions
 * `@location(0)` answers "colour" for a no-colour view, whose entry point
 * returns nothing at all. The three forms the pin composes are that void one,
 * `-> @location(0) vec4<f32>` for a colour pass, and `-> FragmentOutput` for
 * the geometry rewrite, whose struct names one location per attachment plus
 * the optional trailing colour.
 *
 * Both variant tables read it here rather than each deriving it, because a
 * derivation stated twice is what let the two disagree: the PBR half answered
 * "colour" for every no-colour view it ever composed, and a depth-only
 * pipeline built with a colour target is what Dawn refuses outright.
 */
function variantColorOutput(fragmentWgsl: string): VariantColorOutput {
    // The pin's build step minifies the struct's own template while the
    // return clause it interpolates keeps its spaces, so both readers
    // accept either spacing.
    const fragmentOutputStruct = fragmentWgsl.match(
        /struct FragmentOutput\s*\{[^}]*\}/,
    );
    const hasColorReturn = /->\s*@location\(0\)/.test(fragmentWgsl);
    return {
        noColorOutput: !hasColorReturn && !fragmentOutputStruct,
        colorTargetCount: fragmentOutputStruct
            ? (fragmentOutputStruct[0].match(/@location\(\d+\)/g) ?? []).length
            : hasColorReturn
                ? 1
                : 0,
    };
}

/**
 * Whether a composed vertex stage carries the geometry LOCAL_POSITION arm,
 * whose varying reads the raw `position` attribute; both variant tables
 * bind the local vertex lanes for it off this one answer. A stage that
 * declares the varying but never stores it is a pin change to read, not a
 * `false`.
 */
function variantUsesLocalPosition(vertexWgsl: string): boolean {
    const stored = /\bout\.vLocalPos\s*=\s*position;/.test(vertexWgsl);
    if (!stored && vertexWgsl.includes("vLocalPos")) {
        throw new Error(
            "Pinned vertex stage declares vLocalPos without storing the raw position into it.",
        );
    }
    return stored;
}

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
    // The parameter list ends at the return arrow, spelled `) ->` in the
    // pin's source and `)->` by its build step.
    const list = body.slice(0, body.search(/\)\s*->/));
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
        | "texture2dUint"
        | "textureCube"
        // The shadow receiver's three: a PCF map is a depth texture read
        // through a comparison sampler, an ESM map an ordinary float one
        // read through an ordinary sampler, a CSM map a LAYERED depth one
        // whose layer is the selected cascade -- and the pin puts whichever
        // the scene's generators produce in the same group.
        | "textureDepth2d"
        | "textureDepth2dArray"
        | "sampler"
        | "samplerComparison"
        | "storageBuffer"
        | "uniformBuffer";
    /** Which stages declare it; a shared group is declared by both. */
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
/**
 * Which light and which role one group-2 binding name serves.
 *
 * `createShadowFragment` builds every name as `<role>_<lightIndex>`, where
 * the index is the light's own slot in `scene.lights` -- so the suffix is a
 * declared join key, and reading it HERE means neither backend parses a name
 * to answer "which generator is this". A name outside the pin's three shapes
 * fails generation rather than being bound to a guess.
 */
export function shadowBindingSlot(
    name: string,
): { role: "map" | "map_sampler" | "info"; light: number } {
    const slot = shadowBindingSlotOrNull(name);
    if (!slot) {
        throw new Error(
            `A composed shadow binding is named '${name}', which is none of ` +
                "the pin's own shadowTex_/shadowSamp_/shadowComp_/" +
                "shadowInfo_ or csmTex_/csmComp_/csmInfo_ shapes.",
        );
    }
    return slot;
}

/**
 * The same read, for a group whose rows are NOT all shadow bindings.
 *
 * The node family's receiver continues the graph's own group 1, so its
 * reflection returns the graph's textures beside the shadow rows and the
 * split is by this name shape -- the one the pin's emitter builds them from.
 */
export function shadowBindingSlotOrNull(
    name: string,
): { role: "map" | "map_sampler" | "info"; light: number } | null {
    // `csm-shadow-fragment-core.ts` builds the cascaded receiver's three
    // rows under its own prefix -- `csmTex_`/`csmComp_`/`csmInfo_` -- and
    // the ESM/PCF core builds the other four under `shadow`. The ROLE is the
    // same either way, which is why one reader answers for both: the row's
    // TYPE says which resource shape it wants, and the generator says how
    // big its block is.
    const match = name.match(
        /^(?:shadow(Tex|Samp|Comp|Info)|csm(Tex|Comp|Info))_(\d+)$/,
    );
    if (!match) return null;
    const role = match[1] ?? match[2]!;
    return {
        role: role === "Tex"
            ? "map"
            : role === "Info"
              ? "info"
              : "map_sampler",
        light: Number(match[3]),
    };
}

/**
 * One `PinnedShadowBinding` row, from a reflected binding.
 *
 * Every family's receiver rows are one shape and one reflection, so the
 * literal is written once here rather than per emitter.
 */
export function pinnedShadowBindingRow(
    entry: VariantBinding,
    slot: { role: "map" | "map_sampler" | "info"; light: number },
): string {
    return (
        `    {${entry.binding}, "${entry.name}", ` +
        `PinnedBindingKind::${entry.kind}, ` +
        `PinnedShadowRole::${slot.role}, ` +
        `${slot.light}u, ` +
        `${entry.vertex ? "true" : "false"}, ` +
        `${entry.fragment ? "true" : "false"}},`
    );
}

export function variantBindings(
    vertexWgsl: string,
    fragmentWgsl: string,
    // Which group to read. Group 1 is the per-draw one every family shares;
    // group 2 is the shadow receiver's, whose rows the same reflection
    // answers for -- the composed text is the only authority on either.
    group = 1,
): readonly VariantBinding[] {
    const pattern = new RegExp(
        `@group\\(${group}\\)\\s*@binding\\((\\d+)\\)\\s*` +
            "var(?:<([^>]*)>)?\\s*([A-Za-z0-9_]+)\\s*:\\s*" +
            "([A-Za-z0-9_<>]+)",
        "g",
    );
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
                // A group-1 uniform block past the hand-managed mesh (0) and
                // material (1): the geometry arms' gpUniforms is the reached
                // one, and Dawn builds its layout entry from this row. Every
                // uniform block of another group is the group's own.
                : addressSpace.startsWith("uniform")
                ? (group !== 1 || Number(match[1]) > 1
                    ? "uniformBuffer"
                    : undefined)
                : type.startsWith("texture_cube")
                ? "textureCube"
                // A cascaded receiver's map is `texture_depth_2d_array`:
                // the same depth sample type, bound through a layered view
                // whose layer the fragment selects per cascade.
                : type === "texture_depth_2d_array"
                ? "textureDepth2dArray"
                : type.startsWith("texture_depth")
                ? "textureDepth2d"
                // An integer texture is `textureLoad`ed by construction --
                // WebGPU has no sampler for one -- and its sample type is
                // its own, which the layout has to say rather than assume
                // unfilterable float. The clustered slice and tile-mask
                // textures are the reached pair.
                : /^texture_2d<u32>/.test(type)
                ? "texture2dUint"
                : type.startsWith("texture_")
                ? (sampled ? "texture2d" : "texture2dLoad")
                : type === "sampler_comparison"
                ? "samplerComparison"
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

/**
 * One field per line, out of a WGSL struct body.
 *
 * The separator is a comma or a newline — the composed fragments minify a
 * block onto one line while the node pipeline writes one field per line — but
 * only outside `<>`: `li: array<vec4<u32>, 4>` carries a comma inside its own
 * type, and splitting there produces two halves of a field rather than two
 * fields.
 */
function splitWgslFields(structBody: string): string {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const character of structBody) {
        if (character === "<") depth += 1;
        else if (character === ">") depth -= 1;
        if (depth === 0 && (character === "," || character === "\n")) {
            parts.push(current);
            current = "";
            continue;
        }
        current += character;
    }
    parts.push(current);
    return parts
        .map((part) => part.replace(/\/\/.*$/, "").trim())
        .filter((part) => part !== "")
        .map((part) => `${part},`)
        .join("\n");
}

/**
 * A WGSL struct declaration mirrored into C++, padded to the pin's offsets.
 *
 * Each composed family declares blocks a PAL uploads byte for byte, and each
 * reads them out of the composed text rather than restating them. This is
 * that step, once: parse the declaration, lay it out under WGSL's uniform
 * rules, and emit the struct with a `static_assert` per field.
 */
export function mirroredStructFromWgsl(
    structName: string,
    structBody: string,
    provenance: string,
): string {
    const fields = parseVariantFields(splitWgslFields(structBody));
    const { offsets, totalBytes } = variantLayout(fields);
    const mirrored = mirroredMembers(structName, fields, offsets, totalBytes);
    return `// ${provenance}\n` +
        `struct ${structName} {\n${mirrored.members}\n};\n` +
        `static_assert(\n` +
        `    sizeof(${structName}) == ${totalBytes},\n` +
        `    "${structName} must be the pinned ${totalBytes} bytes.");\n` +
        mirrored.asserts;
}

/**
 * The pin's own mesh block, from a composed fragment.
 *
 * The widest declaration wins: the velocity geometry arm appends
 * `previousWorld` and `velocityEnabled` after the light-index array, so the
 * fields keep their declared order rather than being laid out scalars-first.
 * The array's offset is cross-checked against the pin's own
 * `MSH_LIGHT_INDEX_WORD_OFFSET`, which is what checks the mirror against the
 * constant the writers index by rather than only against the declaration.
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
    const declaration = body[1]!;
    const fields = parseVariantFields(splitWgslFields(declaration));
    const { offsets } = variantLayout(fields);
    const arrayIndex = fields.findIndex((field) =>
        field.wgslType.startsWith("array<")
    );
    if (arrayIndex < 0) {
        throw new Error(
            "The pinned mesh block no longer declares its light-index array.",
        );
    }
    if (offsets[arrayIndex] !== lightIndexWordOffset * 4) {
        throw new Error(
            `Pinned MSH_LIGHT_INDEX_WORD_OFFSET is ${lightIndexWordOffset} ` +
                `(byte ${lightIndexWordOffset * 4}); the mirrored mesh ` +
                `layout puts '${fields[arrayIndex]!.name}' at byte ` +
                `${offsets[arrayIndex]}.`,
        );
    }
    return mirroredStructFromWgsl(
        "MeshUniforms",
        declaration,
        "src/render/lights-ubo.ts appendMeshLightUboFields",
    );
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
    const reachedLightWriters = lightWriters.filter(
        (light) => lightKinds.includes(light.kind.toLowerCase()),
    );
    const dispatch = [
        "",
        "",
        "/** Fills one LightEntry, whichever kind the light is. */",
        "inline void write_pinned_light(",
        "    const LightRecord& light,",
        "    LightEntry& out) {",
        // A lightless scene emits a body that writes nothing, without the
        // caseless switch MSVC warns about.
        ...(reachedLightWriters.length === 0
            ? [
                "    (void)light;",
                "    (void)out;",
            ]
            : [
                "    switch (light.kind) {",
                ...reachedLightWriters.flatMap((light) => [
                    `        case LightKind::${light.kind.toLowerCase()}:`,
                    `            write_${
                        light.kind.toLowerCase()
                    }_light(light, out);`,
                    "            return;",
                ]),
                "        default:",
                "            return;",
                "    }",
            ]),
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
 * The declarations both composed material families read.
 *
 * `variantBindings` reflects group 1 and group 2 out of the composed WGSL with
 * one walk for either family, so the rows it yields are one shape; declaring
 * them per family would be two spellings of one reflection, and would force
 * each backend to carry a second copy of the layout and bind-group builders.
 * The receive bit is shared for the same reason: one pinned
 * `material/mesh-features.ts` serves both. Emitted into whichever family
 * header a scene reaches first, exactly like the scene/lights/mesh mirrors
 * beside it.
 */
export function pinnedSharedVariantDecls(
    context: LoweringContext,
    provenance: string,
): string {
    const receiveShadowsBit = pinnedNumericConstant(
        context,
        "src/material/mesh-features.ts",
        "MSH_RECEIVE_SHADOWS",
    );
    const thinInstancesBit = pinnedNumericConstant(
        context,
        "src/material/mesh-features.ts",
        "MSH_HAS_THIN_INSTANCES",
    );
    const instanceColorBit = pinnedNumericConstant(
        context,
        "src/material/mesh-features.ts",
        "MSH_HAS_INSTANCE_COLOR",
    );
    const vatBit = pinnedNumericConstant(
        context,
        "src/material/mesh-features.ts",
        "MSH_VAT",
    );
    const skeletonBit = pinnedNumericConstant(
        context,
        "src/material/mesh-features.ts",
        "MSH_HAS_SKELETON",
    );
    return `// ${provenance}
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace bbl::upstream {

// src/material/mesh-features.ts MSH_RECEIVE_SHADOWS, evaluated from its own
// declaration. The bit rides each family's static per-handle mesh table (a
// mesh's receiveShadows cannot change here), and a DEPTH-ONLY view of a
// receiving mesh drops it: rebuildSingle derives receiveShadows as
// \`!shadowOutput && ...\`, so a caster pass composes without the shadow
// fragment.
inline constexpr std::uint32_t pinned_msh_receive_shadows =
    ${receiveShadowsBit}u;

// MSH_HAS_THIN_INSTANCES from the same declaration. A pool can attach after
// mesh creation, so the PAL ORs this value onto the static per-handle word and
// generation composes both rows of that feature lattice.
inline constexpr std::uint32_t pinned_msh_has_thin_instances =
    ${thinInstancesBit}u;

// _computeMeshFeatures reads this only inside its thin-instance branch and
// only when mesh.thinInstances.colors exists. The PAL therefore ORs it from
// the same MeshRecord predicate that decides whether to bind the colour lane.
inline constexpr std::uint32_t pinned_msh_has_instance_color =
    ${instanceColorBit}u;

// MSH_VAT and the MSH_HAS_SKELETON it replaces. _computeMeshFeatures writes
// them as one either/or -- a baked mesh has no live skeleton left -- so the
// PAL SWAPS rather than ORs, and generation composed the swapped row.
inline constexpr std::uint32_t pinned_msh_vat =
    ${vatBit}u;
inline constexpr std::uint32_t pinned_msh_has_skeleton =
    ${skeletonBit}u;

enum class PinnedBindingKind {
    texture2d,
    // Read with textureLoad rather than sampled: rgba32float, which WebGPU
    // refuses to bind as filterable. The pin's bone palette is one.
    texture2dLoad,
    // An integer texture, read with textureLoad: texture_2d<u32>, whose
    // sample type WebGPU names Uint rather than UnfilterableFloat.
    texture2dUint,
    textureCube,
    // The shadow receiver's three: a PCF map is a depth texture read through
    // a comparison sampler, an ESM one an ordinary float texture read
    // through an ordinary sampler, a CSM one a layered depth texture -- and
    // the pin puts whichever the scene's generators produce into the same
    // group.
    textureDepth2d,
    // The cascaded receiver's own: \`texture_depth_2d_array\`, one layer per
    // cascade, the layer selected per fragment from camera view depth.
    textureDepth2dArray,
    sampler,
    samplerComparison,
    // A read-only storage buffer; the morph arms' deltas and weights.
    storageBuffer,
    // A group-1 uniform block past mesh (0) and material (1): the Standard UV
    // transform block, and the geometry arms' gpUniforms. Every uniform block
    // of another group is that group's own.
    uniformBuffer,
};

/**
 * One row of a variant's group 1, beyond the two uniform blocks.
 *
 * The indices are dense and assigned in extension registration order, so the
 * same index names a different texture in two variants: a PAL builds a
 * variant's group-1 layout and bind group from its own row range, never from
 * a shared slot order.
 */
struct PinnedVariantBinding {
    std::uint32_t binding;
    std::string_view name;
    PinnedBindingKind kind;
    /** Which stages declare it; group 1 is shared by both. */
    bool vertex;
    bool fragment;
};

/** What one group-2 row serves for its light. */
enum class PinnedShadowRole {
    map,
    map_sampler,
    info,
};

/**
 * One row of a receiver's group 2, read out of the composed text like the
 * group-1 rows above.
 *
 * \`light\` is the ordinal in the scene's shadow-generator walk, which is what
 * turns the pin's own \`shadowTex_<lightIndex>\` naming into a join a backend
 * can make without parsing a name.
 */
struct PinnedShadowBinding {
    std::uint32_t binding;
    std::string_view name;
    PinnedBindingKind kind;
    PinnedShadowRole role;
    std::uint32_t light;
    bool vertex;
    bool fragment;
};

${pinnedLightModeCpp()}

} // namespace bbl::upstream
`;
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
    const pbrShadowRows: string[] = [];
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
        // Pipeline identity is deliberately separate from physical stage
        // identity: several pipelines may share one vertex shader while their
        // fragment/material layouts differ.
        const name = variantCppName(`pbr-${variant.pipeline}`);
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
            lanes: laneCount(field.wgslType),
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
                //
                // `material` is [[maybe_unused]] because a writer whose reads
                // all fold at generation — the unlit writer's colour default
                // is one — emits a body that never touches it, and the
                // warning-clean rule covers generated C++ too (MSVC C4100).
                `inline void write_${name}_${
                    extension.baseField.replace(/\W+/g, "_")
                }(\n` +
                `    [[maybe_unused]] const MaterialRecord& material,\n` +
                `    const TextureTransform& transform,\n` +
                `    ${name}MaterialUniforms& out) {\n` +
                // A writer whose slots carry no UV transform never reads the
                // parameter; the cast keeps the shared signature warning-free.
                `    (void)transform;\n` +
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
            // extension writers own. `material` carries [[maybe_unused]] for
            // the same reason the extension writers' does: a variant whose
            // base fields all fold leaves the parameter unread (MSVC C4100).
            writer = `\n\ninline void write_${name}_material(\n` +
                `    [[maybe_unused]] const MaterialRecord& material,\n` +
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
                `    {${selector.materialIndex}, ${
                    selector.materialView === "no-color"
                        ? 1
                        : selector.materialView === "esm-shadow"
                          ? 2
                          : 0
                }, ${selector.meshFeatures}, ` +
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
        // Group 2, when the variant composed the receiver fragment. Reflected
        // rather than counted: `createShadowFragment` picks each binding's
        // TYPE from its own light's filter, so an ESM directional beside a
        // PCF spot declares a float texture next to a depth one in the same
        // group and a layout built from a light count could not tell them
        // apart.
        const shadowBindings = variantBindings(
            variant.vertexWgsl,
            variant.fragmentWgsl,
            2,
        );
        const { noColorOutput, colorTargetCount } = variantColorOutput(
            variant.fragmentWgsl,
        );
        table.push(
            `    {"${variant.fragmentKey}", "${variant.vertex}", ` +
                `"${variant.fragment}", ${totalBytes}, ` +
                `${bindingRows.length}, ${bindings.length}, ` +
                `${pbrShadowRows.length}, ${shadowBindings.length}, ` +
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
                `${noColorOutput ? "true" : "false"}, ` +
                `${colorTargetCount}, ` +
                // The geometry LOCAL_POSITION arm's varying reads the raw
                // `position` attribute, which this backend maps onto the
                // vertex's local lanes with the real node world so worldPos
                // stays the identical product.
                `${variantUsesLocalPosition(variant.vertexWgsl) ? "true" : "false"}, ` +
                `${
                    bindings.some((binding) =>
                        binding.name === "shadowParams"
                    )
                        ? "true"
                        : "false"
                }},`,
        );
        for (const entry of shadowBindings) {
            pbrShadowRows.push(
                pinnedShadowBindingRow(
                    entry,
                    shadowBindingSlot(entry.name),
                ),
            );
        }
        for (const attribute of attributes) {
            attributeRows.push(
                `    {${attribute.location}, "${attribute.name}", ` +
                    `"${attribute.wgslType}"},`,
            );
        }
        for (const entry of bindings) {
            bindingRows.push(
                `    {${entry.binding}, "${entry.name}", ` +
                    `PinnedBindingKind::${entry.kind}, ` +
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

#include <bblite/upstream/pinned_variant_bindings.hpp>
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

inline constexpr std::array<PinnedVariantBinding, ${bindingRows.length}>
    pbr_variant_bindings{{
${bindingRows.join("\n")}
}};

/**
 * The receiver's group, read out of the composed text like the group above.
 *
 * \`createPbrShadowFragment\` wraps the same core \`createStdShadowFragment\`
 * wraps, so the rows are the shadow family's rather than the material
 * family's: three per shadow-casting light, each typed from that light's own
 * filter.
 */
inline constexpr std::array<PinnedShadowBinding, ${pbrShadowRows.length}>
    pbr_shadow_bindings{{
${pbrShadowRows.join("\n")}
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
    /** Half-open range into the shadow (group 2) binding table. */
    std::size_t first_shadow_binding;
    std::size_t shadow_binding_count;
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
    /** An ESM caster view's fragment returns the exponential depth, so its
     *  pipeline's colour target is the generator's map rather than the
     *  frame. Reflected from the one thing that view adds -- the
     *  \`shadowParams\` block its depth code reads -- beside
     *  \`no_color_output\`, so both caster shapes are one question. */
    bool esm_shadow_output;
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
    /** 0 colour, 1 no-colour depth, 2 ESM exponential depth. */
    std::uint32_t material_view;
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
 * document order, then every scene-code creation follows in creation order,
 * so a handle below this count names the material this table was composed
 * for. A PAL checks the HANDLE against it before using one as a key: records
 * appended past it are the shadow caster views the scene's own shadow task
 * builds, and those draw through their own no-colour variants.
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
    std::uint32_t material_view,
    std::uint32_t mesh_features,
    std::uint32_t light_mode,
    std::string_view single_light_type,
    bool tone_mapping,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    for (const PbrVariantSelector& selector : pbr_variant_selectors) {
        if (
            selector.material_index == material_index &&
            selector.material_view == material_view &&
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

/** Which slot groups a scene compiles, mirroring the render capabilities. */
export interface MaterialTextureSlotFeatures {
    transmission: boolean;
    clearcoat: boolean;
    sheen: boolean;
    iridescence: boolean;
    /** A composed variant binds the opt-in lightmap pair (`lmTexture`). */
    lightmap: boolean;
    metallicReflectanceMap: boolean;
    reflectanceMap: boolean;
    /** A composed variant samples the spec-gloss pair, which replaces the
     *  metallic-roughness workflow rather than layering over it. */
    specularGlossiness: boolean;
    occlusionUv2: boolean;
    standardBump: boolean;
    /** A composed Standard variant binds the pin's 2D reflection pair
     *  (std-reflection-fragment.ts `rT`/`rS`), so the record's
     *  reflection_texture needs a mesh slot. */
    standardReflection: boolean;
    /** A composed variant binds the clustered light field's three data
     *  textures, which the scene's container owns rather than a material. */
    clusteredLights: boolean;
    /** A composed variant reads a baked vertex-animation texture, and the
     *  instanced arm its per-instance params texture beside it. Both are
     *  the MESH's rather than the material's, like the bone palette. */
    vat: boolean;
    vatInstances: boolean;
}

/** One emitted row; `slot: null` marks a scene-owned resource. */
interface MaterialSlotRow {
    source: string;
    srgb: "linear" | "srgb" | "srgb_unless_standard" | "base_color";
    fallback:
        | "white"
        | "black"
        | "flat_normal"
        | "white_or_flat_normal"
        | "base_color_record"
        | "orm_record"
        | "white_or_emissive_factor";
    textureName: string;
    samplerName: string;
}

/**
 * The material texture-slot rows, in the append order both backends bind.
 *
 * This list is the single copy of what `pal_sdl_gpu.cpp` and `pal_dawn.cpp`
 * each hand-encoded: which record field fills which slot, the per-slot sRGB
 * rule, the per-slot fallback texel, and the pin's own binding names for the
 * slot. The order is a contract — the five base slots, the transmission
 * pair, the reached material-extension pairs in registration order, then
 * the Standard bump and 2D reflection pairs, each appended after
 * everything before it so no existing slot index moves when one appears.
 */
function materialTextureSlotRows(
    features: MaterialTextureSlotFeatures,
): { mesh: MaterialSlotRow[]; state: MaterialSlotRow[] } {
    const mesh: MaterialSlotRow[] = [
        {
            source: "base_color",
            srgb: "base_color",
            fallback: "base_color_record",
            textureName: "baseColorTexture",
            samplerName: "baseColorSampler",
        },
        {
            source: "specular_or_metallic_roughness",
            srgb: "linear",
            fallback: "orm_record",
            textureName: "ormTexture",
            samplerName: "ormSampler",
        },
        {
            source: "opacity_or_normal",
            srgb: "linear",
            fallback: "white_or_flat_normal",
            textureName: "normalTexture",
            samplerName: "normalSampler_",
        },
        {
            source: "ambient_or_emissive",
            srgb: "srgb_unless_standard",
            fallback: "white_or_emissive_factor",
            textureName: "emissiveTexture",
            samplerName: "emissiveSampler",
        },
        {
            source: "standard_emissive",
            srgb: "linear",
            fallback: "black",
            textureName: "",
            samplerName: "",
        },
    ];
    if (features.transmission) {
        mesh.push(
            {
                source: "transmission",
                srgb: "linear",
                fallback: "white",
                textureName: "refractionMapTexture",
                samplerName: "refractionMapSampler",
            },
            {
                source: "thickness",
                srgb: "linear",
                fallback: "white",
                textureName: "thicknessTexture_",
                samplerName: "thicknessSampler_",
            },
        );
    }
    if (features.clearcoat) {
        mesh.push(
            {
                source: "clearcoat",
                srgb: "linear",
                fallback: "white",
                textureName: "ccIntensityTexture",
                samplerName: "ccIntensitySampler_",
            },
            {
                source: "clearcoat_roughness",
                srgb: "linear",
                fallback: "white",
                textureName: "ccRoughnessTexture",
                samplerName: "ccRoughnessSampler_",
            },
            {
                source: "clearcoat_normal",
                srgb: "linear",
                fallback: "flat_normal",
                textureName: "ccNormalTexture",
                samplerName: "ccNormalSampler_",
            },
        );
    }
    if (features.sheen) {
        mesh.push(
            {
                source: "sheen_color",
                srgb: "srgb",
                fallback: "white",
                textureName: "sheenTexture_",
                samplerName: "sheenSampler_",
            },
            {
                source: "sheen_roughness",
                srgb: "linear",
                fallback: "white",
                textureName: "sheenRoughTexture_",
                samplerName: "sheenRoughSampler_",
            },
        );
    }
    if (features.iridescence) {
        mesh.push(
            {
                source: "iridescence",
                srgb: "srgb",
                fallback: "white",
                textureName: "iridescenceTexture",
                samplerName: "iridescenceSampler_",
            },
            {
                source: "iridescence_thickness",
                srgb: "srgb",
                fallback: "white",
                textureName: "iridescenceThicknessTexture",
                samplerName: "iridescenceThicknessSampler_",
            },
        );
    }
    if (features.metallicReflectanceMap) {
        mesh.push({
            source: "metallic_reflectance",
            // The pinned fragment manually raises sampled RGB to 2.2; the
            // texture itself is therefore uploaded through a linear view.
            srgb: "linear",
            fallback: "white",
            textureName: "metallicReflectanceMap",
            samplerName: "metallicReflectanceMapSampler",
        });
    }
    if (features.reflectanceMap) {
        mesh.push({
            source: "reflectance",
            srgb: "linear",
            fallback: "white",
            textureName: "reflectanceMap",
            samplerName: "reflectanceMapSampler",
        });
    }
    // Appended after the layered extensions rather than beside the base
    // workflow it replaces, so a scene that compiles it shifts no existing
    // slot index -- the same reasoning the Standard bump pair follows.
    if (features.specularGlossiness) {
        mesh.push({
            source: "spec_gloss",
            // `gltf-ext-spec-gloss.ts` fetches this map with its sRGB flag
            // set, the same as the diffuse one: the RGB it carries is a
            // specular colour, and the glossiness rides the alpha, which an
            // sRGB view leaves alone.
            srgb: "srgb",
            fallback: "white",
            textureName: "specGlossTexture",
            samplerName: "specGlossSampler",
        });
    }
    if (features.occlusionUv2) {
        mesh.push({
            source: "occlusion_uv2",
            srgb: "linear",
            fallback: "white",
            textureName: "occlusionTexture",
            samplerName: "occlusionSampler_",
        });
    }
    if (features.lightmap) {
        // A baked lightmap is a `loadTexture2D` image the scene hands the
        // setter, so its encoding is the texture's: the reached call loads
        // it linear and the composed fragment does the sRGB decode itself
        // (the pin's `gamma` arm). Uploading through an sRGB view would
        // decode it twice.
        mesh.push({
            source: "lightmap",
            srgb: "linear",
            fallback: "white",
            textureName: "lmTexture",
            samplerName: "lmSampler",
        });
    }
    if (features.standardBump) {
        mesh.push({
            source: "standard_bump",
            srgb: "linear",
            fallback: "flat_normal",
            textureName: "",
            samplerName: "",
        });
    }
    if (features.standardReflection) {
        // Appended after the bump slot for the same reason bump appends
        // last: no existing slot index moves. The pin uploads the 2D
        // reflection through the same loadTexture2D path as the diffuse
        // (linear rgba8unorm, load-babylon.ts TEX_SLOTS), and no variant
        // binds the slot without HAS_REFLECTION_TEXTURE, so the white
        // fallback is never sampled.
        mesh.push({
            source: "standard_reflection",
            srgb: "linear",
            fallback: "white",
            textureName: "",
            samplerName: "",
        });
    }
    const state: MaterialSlotRow[] = [
        {
            source: "environment_cube",
            srgb: "linear",
            fallback: "white",
            textureName: "iblTexture",
            samplerName: "iblSampler",
        },
        {
            source: "brdf_lut",
            srgb: "linear",
            fallback: "white",
            textureName: "brdfLUT",
            samplerName: "brdfSampler_",
        },
    ];
    if (features.transmission) {
        state.push({
            source: "scene_color",
            srgb: "linear",
            fallback: "white",
            textureName: "refractionTexture",
            samplerName: "refractionSampler_",
        });
    }
    state.push({
        source: "bone_palette",
        srgb: "linear",
        fallback: "white",
        textureName: "boneSampler",
        samplerName: "",
    });
    if (features.vat) {
        // The baked palette: the same rgba32float layout the bone palette
        // has, `frameCount` rows tall, and `textureLoad`ed exactly the same
        // way -- so it carries no sampler either. Appended after the bone
        // palette for the reason bump and reflection append last: no
        // existing slot index moves.
        state.push({
            source: "vat_palette",
            srgb: "linear",
            fallback: "white",
            textureName: "vatSampler",
            samplerName: "",
        });
    }
    if (features.vatInstances) {
        state.push({
            source: "vat_instance_params",
            srgb: "linear",
            fallback: "white",
            textureName: "vatInstanceTex",
            samplerName: "",
        });
    }
    if (features.clusteredLights) {
        // The clustered field's three, which the scene's CONTAINER owns:
        // scene-owned rows exactly as the environment cube and the BRDF LUT
        // are, and named here for the same reason -- so each backend resolves
        // them through the one table rather than by comparing binding names
        // of its own. Each is `textureLoad`ed and carries no sampler, and two
        // are integer formats a sampler could not serve; upstream binds them
        // from the extension's own `bind` hook, which appends to group 1
        // after the material's own pairs.
        state.push(
            {
                source: "clustered_lights",
                srgb: "linear",
                fallback: "white",
                textureName: "clusteredLights",
                samplerName: "",
            },
            {
                source: "clustered_cells",
                srgb: "linear",
                fallback: "white",
                textureName: "clusteredCells",
                samplerName: "",
            },
            {
                source: "clustered_indices",
                srgb: "linear",
                fallback: "white",
                textureName: "clusteredIndices",
                samplerName: "",
            },
        );
    }
    return { mesh, state };
}

/**
 * Emits `upstream/material_texture_slots.hpp`: the one texture-slot table
 * both render backends execute.
 *
 * The rows carry everything the five hand-kept copies used to restate —
 * the material-field→slot association, the per-slot sRGB rule, the fallback
 * texel and the pinned binding names — so each backend keeps only its own
 * upload mechanics and an enum→API residue. Emitted for every scene: the
 * base slots serve the Standard family too, which is why this is not part
 * of `pbr_variants.hpp` (a scene with no glTF materials emits no variant
 * header but still fills its texture slots).
 *
 * The composed variants are the cross-check: every texture, cube and
 * sampler name a variant declares must be served by some row, so a pin
 * binding this table does not know fails at generation, named, rather than
 * in both PALs at draw time.
 */
export function materialTextureSlotsHeader(
    features: MaterialTextureSlotFeatures,
    variants: readonly { vertexWgsl: string; fragmentWgsl: string }[],
    provenance: string,
): string {
    const { mesh, state } = materialTextureSlotRows(features);
    const served = new Set<string>();
    for (const row of [...mesh, ...state]) {
        if (row.textureName !== "") served.add(row.textureName);
        if (row.samplerName !== "") served.add(row.samplerName);
    }
    const unserved = new Set<string>();
    for (const variant of variants) {
        for (
            const binding of variantBindings(
                variant.vertexWgsl,
                variant.fragmentWgsl,
            )
        ) {
            if (
                binding.kind === "storageBuffer" ||
                binding.kind === "uniformBuffer"
            ) {
                continue;
            }
            if (!served.has(binding.name)) unserved.add(binding.name);
        }
    }
    if (unserved.size > 0) {
        throw new Error(
            `Pinned variants declare ${
                [...unserved].sort().map((name) => `'${name}'`).join(", ")
            } which the material texture-slot table does not serve. Add ` +
                "the row to materialTextureSlotRows in " +
                "src/pinned-pbr-variant-cpp.ts; an unserved name fails in " +
                "both PALs at draw time.",
        );
    }
    const rows = [
        ...mesh.map((row, slot) => ({ ...row, slot: `${slot}` })),
        ...state.map((row) => ({ ...row, slot: "material_texture_no_slot" })),
    ].map((row) =>
        `    {${row.slot}, MaterialTextureSource::${row.source}, ` +
        `MaterialTextureSrgb::${row.srgb}, ` +
        `MaterialTextureFallback::${row.fallback}, ` +
        `"${row.textureName}", "${row.samplerName}"},`
    );
    return `// ${provenance}
// The material texture-slot table both render backends execute: which
// record field fills each slot, the slot's sRGB rule and fallback texel,
// and the pin's own binding names for it. Rows follow the append order the
// backends bind -- the five base slots, the transmission pair, reached
// material-extension pairs in registration order (clearcoat intensity/
// roughness/normal, sheen color/roughness, iridescence intensity/
// thickness, dedicated uv2 occlusion), then the Standard bump and 2D
// reflection pairs, each appended after everything before it so no
// existing slot index moves. Scene-owned resources follow with no mesh
// slot. A per-slot rule hand-kept in a PAL is the drift this table exists
// to remove; change the emitter instead.
#pragma once

#include <array>
#include <cstddef>
#include <limits>
#include <string_view>

namespace bbl::upstream {

// Which material-record field fills a slot. Paired values name the
// Standard and PBR families' fields for the one slot both bind -- the
// upload path resolves the family at run time; the association itself is
// decided here.
enum class MaterialTextureSource {
    /** Both families' base colour texture. */
    base_color,
    /** Standard specular map / PBR metallic-roughness (ORM) map. */
    specular_or_metallic_roughness,
    /** Standard opacity map / PBR normal map. */
    opacity_or_normal,
    /** Standard ambient map / PBR emissive map. */
    ambient_or_emissive,
    /** Standard emissive map; a PBR material leaves the fallback. */
    standard_emissive,
    /** KHR_materials_pbrSpecularGlossiness map: RGB specular, A glossiness
     *  (PBR only, and it replaces the metallic-roughness workflow). */
    spec_gloss,
    /** KHR_materials_transmission map (PBR only). */
    transmission,
    /** KHR_materials_volume thickness map (PBR only). */
    thickness,
    clearcoat,
    clearcoat_roughness,
    clearcoat_normal,
    sheen_color,
    sheen_roughness,
    iridescence,
    iridescence_thickness,
    /** The opt-in baked lightmap (PBR only). */
    lightmap,
    metallic_reflectance,
    reflectance,
    /** The dedicated uv2 occlusion map, when the record flags it. */
    occlusion_uv2,
    /** Standard bump map; a PBR material leaves the fallback. */
    standard_bump,
    /** Standard 2D reflection map (std-reflection-fragment.ts rT/rS,
     *  sampled at computed reflCoords); a PBR material leaves the
     *  fallback. */
    standard_reflection,
    // Scene-owned resources the pinned bindings also name: no mesh slot,
    // no record field -- each backend resolves these from its own state.
    environment_cube,
    brdf_lut,
    /** The transmission scene-colour grab the pin refracts through. */
    scene_color,
    /** The skinned variants' rgba32float bone palette (textureLoad). */
    bone_palette,
    /** A baked mesh's rgba32float VAT, frameCount rows tall (textureLoad). */
    vat_palette,
    /** Its per-instance params texture, two texels per instance. */
    vat_instance_params,
    /** The clustered field's per-light payload (rgba32float, textureLoad). */
    clustered_lights,
    /** Its per-slice light range (rgba32uint, textureLoad). */
    clustered_cells,
    /** Its per-tile light mask (r32uint, textureLoad). */
    clustered_indices,
};

enum class MaterialTextureSrgb {
    linear,
    srgb,
    /** sRGB for the PBR family, linear for Standard. */
    srgb_unless_standard,
    /**
     * The base-colour rule: the record's own encoding, which is where this
     * port keeps what upstream keeps on the \`Texture2D\` -- the format
     * \`loadTexture2D\` picked from its caller's \`srgb\` option. The glTF
     * loader passes true and so does the texture-less factor bake; a
     * scene-code solid texture is rgba8unorm and so is a load that asked
     * for no decode. Standard uploads linear either way.
     */
    base_color,
};

enum class MaterialTextureFallback {
    white,
    black,
    /** A flat tangent-space normal (128, 128, 255), so a material with
     *  no map reads (0, 0, 1) and keeps its interpolated normal. */
    flat_normal,
    /** White for Standard, the flat normal for PBR. */
    white_or_flat_normal,
    /** The record's own baked base-colour texel; white for Standard. */
    base_color_record,
    /** The pinned ORM factor texel, so an animated metallic or roughness
     *  factor multiplies the authored value rather than white; white for
     *  Standard. */
    orm_record,
    /** White when the PBR emissive factor is non-zero (the factor scales
     *  the sample), black otherwise; white for Standard. */
    white_or_emissive_factor,
};

/** The slot value for a scene-owned row: no per-mesh storage. */
inline constexpr std::size_t material_texture_no_slot =
    std::numeric_limits<std::size_t>::max();

struct MaterialTextureSlot {
    /** Mesh-owned storage slot, or material_texture_no_slot. */
    std::size_t slot;
    MaterialTextureSource source;
    MaterialTextureSrgb srgb;
    MaterialTextureFallback fallback;
    /** The pin's own binding names; empty when no composed variant binds
     *  the slot (the Standard-only slots). */
    std::string_view texture_name;
    std::string_view sampler_name;
};

/** How many mesh-owned texture slots this scene compiles. */
inline constexpr std::size_t material_texture_mesh_slots = ${mesh.length};

inline constexpr std::array<MaterialTextureSlot, ${rows.length}>
    material_texture_slots{{
${rows.join("\n")}
}};

} // namespace bbl::upstream
`;
}

/**
 * The pin's Standard material-UBO sizing, from the renderable's own scratch.
 *
 * `writeStdMaterialData` keys on literal float lanes rather than a published
 * `_offsets` map (the Standard template inlines its `matUniforms` struct
 * text, so `composeShader` returns no `_materialUboSpec`), which makes the
 * authorities: the composed fragment's own struct declaration for the field
 * layout, and `standard-renderable.ts`'s `new F32(24)` scratch for the
 * allocation the writer fills. Both are read here rather than assumed.
 */
function pinnedStandardMaterialFloats(context: LoweringContext): number {
    const file = context.sourceFile(
        "src/material/standard/standard-renderable.ts",
    );
    const initializer = context.unwrapExpression(
        context.variableInitializer(file, "_stdMatScratch"),
    );
    if (
        !ts.isNewExpression(initializer) ||
        initializer.arguments?.length !== 1 ||
        !ts.isNumericLiteral(initializer.arguments[0]!)
    ) {
        throw new Error(
            "Expected the pinned _stdMatScratch to be `new F32(<floats>)`.",
        );
    }
    return Number.parseInt(initializer.arguments[0].text, 10);
}

/**
 * The pin's own Standard material defaults, from `createStandardMaterial`.
 *
 * The C++ mirror of `StandardMaterialProps` carries them so a wave-D caller
 * that fills only what its loader knows still uploads the pin's values for
 * the rest — `lightmapLevel` and `reflectionCoordMode` have no MaterialRecord
 * field today, and their defaults are what the pin renders with.
 */
function standardMaterialDefault(
    context: LoweringContext,
    property: string,
): number | readonly number[] {
    const { file, declaration } = context.functionDeclaration(
        "src/material/standard/create-standard-material.ts",
        "createStandardMaterial",
    );
    const literal = declaration.body!.statements
        .filter(ts.isReturnStatement)
        .map((statement) => {
            // The pin returns `{ ... } as StandardMaterialProps`.
            const unwrapped = statement.expression &&
                context.unwrapExpression(statement.expression);
            return unwrapped && ts.isObjectLiteralExpression(unwrapped)
                ? unwrapped
                : undefined;
        })
        .find((expression) => expression !== undefined);
    if (!literal) {
        throw new Error(
            "Expected createStandardMaterial to return an object literal.",
        );
    }
    for (const entry of literal.properties) {
        if (
            !ts.isPropertyAssignment(entry) ||
            !ts.isIdentifier(entry.name) ||
            entry.name.text !== property
        ) {
            continue;
        }
        const value = entry.initializer;
        if (ts.isNumericLiteral(value)) {
            return Number.parseFloat(value.text);
        }
        if (ts.isArrayLiteralExpression(value)) {
            return value.elements.map((element) => {
                if (!ts.isNumericLiteral(element)) {
                    throw new Error(
                        `Pinned Standard default '${property}' is not a ` +
                            "numeric array.",
                    );
                }
                return Number.parseFloat(element.text);
            });
        }
        throw new Error(
            `Pinned Standard default '${property}' is not a literal ` +
                `(${value.getText(file)}).`,
        );
    }
    throw new Error(
        `createStandardMaterial declares no property '${property}'.`,
    );
}

/**
 * The fields of the pin's `StandardMaterialProps` the two lowered writers
 * read, with our snake_case spellings. `kind` decides the C++ member type;
 * defaults come from `createStandardMaterial`'s own AST.
 */
const standardPropsFields: ReadonlyArray<{
    pinName: string;
    cppName: string;
    kind: "color3" | "float" | "float2";
}> = [
    { pinName: "diffuseColor", cppName: "diffuse_color", kind: "color3" },
    { pinName: "alpha", cppName: "alpha", kind: "float" },
    { pinName: "specularColor", cppName: "specular_color", kind: "color3" },
    { pinName: "specularPower", cppName: "specular_power", kind: "float" },
    { pinName: "emissiveColor", cppName: "emissive_color", kind: "color3" },
    { pinName: "ambientColor", cppName: "ambient_color", kind: "color3" },
    { pinName: "bumpLevel", cppName: "bump_level", kind: "float" },
    {
        pinName: "ambientTexLevel",
        cppName: "ambient_tex_level",
        kind: "float",
    },
    { pinName: "lightmapLevel", cppName: "lightmap_level", kind: "float" },
    { pinName: "opacityLevel", cppName: "opacity_level", kind: "float" },
    { pinName: "alphaCutOff", cppName: "alpha_cutoff", kind: "float" },
    { pinName: "reflectionLevel", cppName: "reflection_level", kind: "float" },
    {
        pinName: "reflectionCoordMode",
        cppName: "reflection_coord_mode",
        kind: "float",
    },
    { pinName: "uvScale", cppName: "uv_scale", kind: "float2" },
];

/** How the pinned Standard writers' property reads map onto the mirror. */
const standardWriterSources: Readonly<Record<string, string>> = {
    diffuseColor: "material.diffuse_color",
    specularColor: "material.specular_color",
    emissiveColor: "material.emissive_color",
    ambientColor: "material.ambient_color",
    alpha: "material.alpha",
    specularPower: "material.specular_power",
    bumpLevel: "material.bump_level",
    ambientTexLevel: "material.ambient_tex_level",
    lightmapLevel: "material.lightmap_level",
    opacityLevel: "material.opacity_level",
    alphaCutOff: "material.alpha_cutoff",
    reflectionLevel: "material.reflection_level",
    reflectionCoordMode: "material.reflection_coord_mode",
    // The composition-time texture level: `rebuildSingle` passes
    // `(features & NEEDS_UV) !== 0 ? 1 : 0` (the geometry renderable passes
    // its HAS_DIFFUSE_TEXTURE form), so it is a writer parameter here too.
    textureLevel: "texture_level",
};

/**
 * Emits `upstream/standard_variants.hpp`: the Standard material family's
 * pinned-composition mirror — the material-props record with the pin's own
 * defaults, the `matUniforms` mirror with the pin's offsets, both UBO writers
 * lowered from their pinned ASTs, and the per-variant stage/binding tables.
 *
 * Nothing routes here yet: the emission rides `pinnedStandardVariants`, which
 * no caller sets, so the generated tree is unchanged until wave D wires the
 * PALs and flips the transcribed fragment off.
 */
export function pinnedStandardVariantsHeader(
    context: LoweringContext,
    provenance: string,
    variants: readonly PinnedStandardVariantManifestEntry[],
): string {
    if (variants.length === 0) {
        throw new Error(
            "pinnedStandardVariantsHeader needs at least one composed " +
                "variant; the material struct is read from the composed " +
                "fragment text.",
        );
    }
    // The template's own material block, from the composed fragment: the
    // Standard template inlines `matUniforms` rather than building it from
    // UBO field specs, so the text is the layout authority.
    const structMatch = /struct matUniforms\s*\{([^}]*)\}/.exec(
        variants[0]!.fragmentWgsl,
    );
    if (!structMatch) {
        throw new Error(
            "A pinned composed Standard fragment no longer declares " +
                "struct matUniforms.",
        );
    }
    const fields = parseVariantFields(
        structMatch[1]!
            .split(/[,\n]/)
            .map((part) => part.replace(/\/\/.*$/, "").trim())
            .filter((part) => part !== "")
            .map((part) => `${part},`)
            .join("\n"),
    );
    const { offsets, totalBytes } = variantLayout(fields);
    // Every variant shares the block — the template emits it unconditionally
    // — so any variant disagreeing with the first is a pin change to see.
    for (const variant of variants.slice(1)) {
        const other = /struct matUniforms\s*\{([^}]*)\}/.exec(
            variant.fragmentWgsl,
        );
        if (!other || other[1] !== structMatch[1]) {
            throw new Error(
                `Pinned Standard variant '${variant.fragmentKey}' declares ` +
                    "a different matUniforms block than its siblings.",
            );
        }
    }
    // The renderable's own allocation: `new F32(24)` (96 bytes). The writer
    // fills lanes of that scratch, so the mirrored layout must total it.
    const pinnedFloats = pinnedStandardMaterialFloats(context);
    if (totalBytes !== pinnedFloats * 4) {
        throw new Error(
            `Pinned Standard material scratch is F32(${pinnedFloats}) ` +
                `(${pinnedFloats * 4} bytes); the mirrored matUniforms ` +
                `layout computes ${totalBytes}.`,
        );
    }
    const slots: UboFieldSlot[] = fields.map((field, index) => ({
        name: field.name,
        offset: offsets[index]!,
        lanes: laneCount(field.wgslType),
    }));
    const mirrored = mirroredMembers(
        "StandardMaterialUniforms",
        fields,
        offsets,
        totalBytes,
    );
    // The pin's writer, lowered from its own AST. `lowerPinnedUboWriter`
    // resolves every `data[<lane>]` store against the slots above and fails
    // on any lane no declared field covers — which is the offsets cross-check
    // in the direction the pin states it (writer lanes → struct fields).
    const materialWriterBody = lowerPinnedUboWriter(context, {
        modulePath: "src/material/standard/standard-pipeline.ts",
        symbolName: "writeStdMaterialData",
        sourceLocal: "mat",
        baseField: "dc",
        propertySources: standardWriterSources,
        vectorProperties: {
            diffuseColor: 3,
            specularColor: 3,
            emissiveColor: 3,
            ambientColor: 3,
        },
        slots,
    }).join("\n");
    // And the reverse direction: every field the struct declares (padding
    // aside) must be written, or a lane uploads a zero the fragment reads.
    const unwritten = fields
        .map((field) => field.name)
        .filter((name) =>
            !name.startsWith("_") &&
            !materialWriterBody.includes(`out.${name}`)
        );
    if (unwritten.length > 0) {
        throw new Error(
            `Pinned Standard matUniforms declares ${
                unwritten.map((name) => `'${name}'`).join(", ")
            } with no write in the lowered writeStdMaterialData.`,
        );
    }
    // The vertex-stage UV block the second writer fills. The template builds
    // it as literal text, so the marker is asserted before the writer is
    // lowered against its single vec4.
    if (
        !context.store.getSource(
            "src/material/standard/standard-template.ts",
        ).includes("struct upUniforms{u:vec4<f32>,}")
    ) {
        throw new Error(
            "Pinned Standard template no longer declares the " +
                "`struct upUniforms{u:vec4<f32>,}` block " +
                "writeStandardUvTransformData fills.",
        );
    }
    const uvWriterBody = lowerPinnedUboWriter(context, {
        modulePath: "src/material/standard/standard-pipeline.ts",
        symbolName: "writeStandardUvTransformData",
        sourceLocal: "material",
        baseField: "u",
        propertySources: {
            invertY: "invert_y",
            uvScale: "material.uv_scale",
        },
        vectorProperties: { uvScale: 2 },
        laneSources: {
            uvScale: {
                0: "material.uv_scale[0]",
                1: "material.uv_scale[1]",
            },
        },
        // `enableStandardUvOffset()` is the pin's opt-in for a per-material
        // UV offset; no reached scene calls it, so the resolver is the pin's
        // own uninstalled null and the offset lanes fold to their defaults.
        // A scene that enables it must extend this before wave D flips over.
        absentHooks: ["_uvOffsetResolver"],
        slots: [{ name: "u", offset: 0, lanes: 4 }],
    }).join("\n");
    const propsMembers = standardPropsFields.map((field) => {
        const value = standardMaterialDefault(context, field.pinName);
        if (field.kind === "color3") {
            if (!Array.isArray(value) || value.length !== 3) {
                throw new Error(
                    `Pinned Standard default '${field.pinName}' is not a ` +
                        "3-lane colour.",
                );
            }
            return `    Color3 ${field.cppName}{${
                value.map(floatLiteral).join(", ")
            }};`;
        }
        if (field.kind === "float2") {
            if (!Array.isArray(value) || value.length !== 2) {
                throw new Error(
                    `Pinned Standard default '${field.pinName}' is not a ` +
                        "2-lane vector.",
                );
            }
            return `    std::array<float, 2> ${field.cppName}{${
                value.map(floatLiteral).join(", ")
            }};`;
        }
        if (typeof value !== "number") {
            throw new Error(
                `Pinned Standard default '${field.pinName}' is not a number.`,
            );
        }
        return `    float ${field.cppName} = ${floatLiteral(value)};`;
    });
    const table: string[] = [];
    const bindingRows: string[] = [];
    const attributeRows: string[] = [];
    const shadowRows: string[] = [];
    for (const variant of variants) {
        const attributes = variantAttributes(variant.vertexWgsl);
        const bindings = variantBindings(
            variant.vertexWgsl,
            variant.fragmentWgsl,
        );
        // The receiver's own group, read the same way and for the same
        // reason: `createShadowFragment` numbers three bindings per
        // shadow-casting light in `scene.lights` order and picks each one's
        // TYPE from that light's filter, so a scene mixing an ESM
        // directional with a PCF spot declares a float texture beside a
        // depth one in the same group. A layout built from a light count
        // could not tell them apart.
        const shadowBindings = variantBindings(
            variant.vertexWgsl,
            variant.fragmentWgsl,
            2,
        );
        const { noColorOutput, colorTargetCount } = variantColorOutput(
            variant.fragmentWgsl,
        );
        table.push(
            `    {"${variant.fragmentKey}", "${variant.vertex}", ` +
                `"${variant.fragment}", ${variant.features}, ` +
                `${variant.meshFeatures}, ` +
                `${bindingRows.length}, ${bindings.length}, ` +
                `${shadowRows.length}, ${shadowBindings.length}, ` +
                `${attributeRows.length}, ${attributes.length}, ` +
                `${noColorOutput ? "true" : "false"}, ` +
                `${colorTargetCount}, ` +
                // The LOCAL_POSITION geometry arm reads the raw position
                // attribute for its varying, so the draw binds the local
                // vertex lanes for it.
                `${variantUsesLocalPosition(variant.vertexWgsl) ? "true" : "false"}},`,
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
                    `PinnedBindingKind::${entry.kind}, ` +
                    `${entry.vertex ? "true" : "false"}, ` +
                    `${entry.fragment ? "true" : "false"}},`,
            );
        }
        for (const entry of shadowBindings) {
            shadowRows.push(
                pinnedShadowBindingRow(
                    entry,
                    shadowBindingSlot(entry.name),
                ),
            );
        }
    }
    return `// ${provenance}
// Generated from the pin's own composed Standard variants. Nothing selects
// these yet: the transcribed standard fragment stays live until wave D wires
// the PALs over, so this header ships beside it rather than replacing it.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include <bblite/upstream/pinned_variant_bindings.hpp>
#include <bblite/runtime.hpp>

namespace bbl::upstream {

using bbl::Color3;

// src/material/standard/create-standard-material.ts createStandardMaterial
//
// The pin's own StandardMaterialProps, with the pin's own defaults — the
// values the two writers below read. Wave D fills it from MaterialRecord
// (diffuse_color, specular_power, bump_level, ... are one-to-one, and
// lightmap_level / reflection_coord_mode have no record field yet).
struct StandardMaterialProps {
${propsMembers.join("\n")}
};

// src/material/standard/standard-template.ts matUniforms
//
// The template inlines this block's WGSL, and the renderable allocates the
// pin's F32(${pinnedFloats}) scratch for it, so those two are the layout
// authorities the mirror is checked against.
struct StandardMaterialUniforms {
${mirrored.members}
};
static_assert(
    sizeof(StandardMaterialUniforms) == ${totalBytes},
    "The pinned Standard material UBO is ${totalBytes} bytes.");
${mirrored.asserts}

// src/material/standard/standard-pipeline.ts writeStdMaterialData
//
// texture_level is the composition-time value the renderable passes:
// (features & NEEDS_UV) != 0 ? 1 : 0 for the colour path, and the geometry
// renderable's HAS_DIFFUSE_TEXTURE form for the MRT path.
inline void write_standard_material(
    [[maybe_unused]] const StandardMaterialProps& material,
    float texture_level,
    StandardMaterialUniforms& out) {
${materialWriterBody}
}

// src/material/standard/standard-template.ts upUniforms — the vertex-stage
// UV transform block, bound only when the variant carries NEEDS_UV.
struct StandardUvTransformUniforms {
    // offset 0, vec4<f32>
    std::array<float, 4> u{};
};
static_assert(
    sizeof(StandardUvTransformUniforms) == 16,
    "The pinned Standard UV block is one vec4.");

// src/material/standard/standard-pipeline.ts writeStandardUvTransformData
//
// invert_y is isStandardUvInverted(features, material): the diffuse
// texture's invertY when one exists, else the opacity texture's, else the
// bump texture's.
inline void write_standard_uv_transform(
    [[maybe_unused]] const StandardMaterialProps& material,
    bool invert_y,
    StandardUvTransformUniforms& out) {
${uvWriterBody}
}

// What each composed variant declares in group 1, past the hand-managed
// mesh (0) and material (1) blocks -- the same reading discipline, and the
// same reflected rows, as pbr_variants.hpp.
inline constexpr std::array<PinnedVariantBinding, ${bindingRows.length}>
    standard_variant_bindings{{
${bindingRows.join("\n")}
}};

/**
 * The receiver's group, read out of the composed text like the group above.
 */
inline constexpr std::array<PinnedShadowBinding, ${shadowRows.length}>
    standard_shadow_bindings{{
${shadowRows.join("\n")}
}};

struct StandardVariantAttribute {
    std::uint32_t location;
    std::string_view name;
    std::string_view wgsl_type;
};

inline constexpr std::array<StandardVariantAttribute, ${attributeRows.length}>
    standard_variant_attributes{{
${attributeRows.join("\n")}
}};

struct StandardVariantEntry {
    std::string_view key;
    std::string_view vertex_shader;
    std::string_view fragment_shader;
    /** The pin's Standard feature bits this variant composed under. */
    std::uint32_t features;
    /** The pin's MSH_* bits for the mesh half of the key. */
    std::uint32_t mesh_features;
    /** Half-open range into the binding table above. */
    std::size_t first_binding;
    std::size_t binding_count;
    /** Half-open range into the shadow (group 2) binding table. */
    std::size_t first_shadow_binding;
    std::size_t shadow_binding_count;
    /** Half-open range into the attribute table above. */
    std::size_t first_attribute;
    std::size_t attribute_count;
    /** A NO_COLOR_OUTPUT view's fragment writes no colour target. */
    bool no_color_output;
    /** One for a colour pass, zero for a depth-only view, the attachment
     *  count (plus the optional trailing colour) for a geometry MRT arm. */
    std::size_t color_target_count;
    /** A LOCAL_POSITION geometry variant's varying reads the raw position
     *  attribute, so its draw binds the local vertex lanes. */
    bool uses_local_position;
};

inline constexpr std::array<StandardVariantEntry, ${variants.length}>
    standard_variants{{
${table.join("\n")}
}};

/** Every variant shares the template's one material block. */
inline constexpr std::size_t standard_material_ubo_bytes = ${totalBytes};

} // namespace bbl::upstream
`;
}
