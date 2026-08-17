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
const extensionWriters: ReadonlyArray<{
    modulePath: string;
    symbolName: string;
    sourceLocal: string;
    baseField: string;
    propertySources: Readonly<Record<string, string | null>>;
    /** Properties that are colours rather than scalars, and their lane count. */
    vectorProperties?: Readonly<Record<string, number>>;
    nestedWriters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
            bumpTextureScale: "material.clearcoat_bump_scale",
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

/** The shared UV-transform helper's reads, against our TextureTransform. */
function uvTransformSources(): Readonly<Record<string, string>> {
    return {
        uScale: "transform.u_scale",
        vScale: "transform.v_scale",
        uAng: "transform.rotation",
        uOffset: "transform.u_offset",
        vOffset: "transform.v_offset",
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

/**
 * Where each field the pin names lives on our own `MaterialRecord`.
 *
 * The pin's `_writeMaterialData` reads `material.<field>` and writes it at the
 * offset the composer published, so this is the correspondence between its
 * property names and ours — plumbing, not arithmetic. Most fall out of a
 * camelCase-to-snake_case rename because the record was ported from the same
 * source; the entries below are the ones that do not, and a field absent from
 * both is a generation failure rather than a zero silently uploaded.
 */
const materialFieldSources: Readonly<Record<string, string>> = {
    environmentIntensity: "material.environment_intensity",
    directIntensity: "material.direct_intensity",
    reflectance: "material.reflectance",
    // The pin reads `material.alpha`, which the glTF loader seeds from the base
    // colour factor's alpha; the record keeps it there rather than duplicating
    // it into a scalar.
    materialAlpha: "material.base_color_factor.a",
    metallicFactor: "material.metallic_factor",
    roughnessFactor: "material.roughness_factor",
    normalScale: "material.normal_texture_scale",
    // The pin writes `usePhysicalLightFalloff === false ? 0 : 1`. Nothing here
    // sets that flag: the generated punctual path is the physical
    // inverse-square mode unconditionally (see docs/fidelity.md), which is the
    // pin's own default, so this is 1 by construction rather than by choice.
    lightFalloffMode: "1.0f",
    alphaCutOff: "material.alpha_cutoff",
    // `reflectance-fragment.ts` writeReflectanceUBO, in its own order.
    occlusionStrength: "material.occlusion_strength",
    metallicF0Factor: "material.metallic_f0_factor",
    specularWeight: "material.specular_weight",
    // `iridescence-fragment.ts` writeIridescenceUBO.
    iridescenceIntensity: "material.iridescence_intensity",
};

/**
 * Vector fields, by the components the pin's own writer puts in each lane.
 *
 * Only writers that read a value straight off the material are listed. The ones
 * that compute — the clearcoat's `pow(-a/b, 2)` and `1/ior`, the refraction's
 * thickness-as-depth selection, the volume's `log(max(tint, 1e-6)) / distance` —
 * are formulas and belong lowered from the pin's AST, not restated here, so
 * they are deliberately absent and their variants report the gap.
 */
const materialVectorSources: Readonly<Record<string, readonly string[]>> = {
    baseColorFactor: [
        "material.base_color_factor.r",
        "material.base_color_factor.g",
        "material.base_color_factor.b",
        "material.base_color_factor.a",
    ],
    emissiveColor: [
        "material.emissive_factor.r",
        "material.emissive_factor.g",
        "material.emissive_factor.b",
    ],
    metallicReflectanceColor: [
        "material.metallic_reflectance_color.r",
        "material.metallic_reflectance_color.g",
        "material.metallic_reflectance_color.b",
    ],
    iridescenceParams: [
        "material.iridescence_intensity",
        "material.iridescence_index_of_refraction",
        "material.iridescence_minimum_thickness",
        "material.iridescence_maximum_thickness",
    ],
};

/**
 * Emits the writer for one variant's material UBO.
 *
 * Fields the correspondence above does not name fail generation, which keeps a
 * newly composed field visible instead of shipping as a zero. Padding members
 * the pin declares are written as zero explicitly, because the pin's own
 * `Float32Array` starts zeroed and the offsets after them depend on them
 * existing.
 */
function materialWriter(
    variantName: string,
    fields: readonly VariantField[],
    offsets: readonly number[],
): string {
    const lines: string[] = [];
    fields.forEach((field, index) => {
        if (field.name.startsWith("_")) {
            lines.push(
                `    // ${field.name}: the pin's padding at offset ` +
                    `${offsets[index]}`,
            );
            return;
        }
        if (field.wgslType === "f32") {
            const source = materialFieldSources[field.name];
            if (source === undefined) {
                throw new Error(
                    `Pinned material UBO field '${field.name}' has no source ` +
                        "on MaterialRecord. Add it to materialFieldSources in " +
                        "src/pinned-pbr-variant-cpp.ts.",
                );
            }
            lines.push(
                `    // offset ${offsets[index]}\n` +
                    `    out.${field.name} = static_cast<float>(${source});`,
            );
            return;
        }
        const components = materialVectorSources[field.name];
        const lanes = field.wgslType === "vec3<f32>" ? 3 : 4;
        if (components === undefined) {
            throw new Error(
                `Pinned material UBO field '${field.name}' has no source on ` +
                    "MaterialRecord. Add it to materialVectorSources in " +
                    "src/pinned-pbr-variant-cpp.ts.",
            );
        }
        if (components.length !== lanes) {
            throw new Error(
                `Pinned material UBO field '${field.name}' is ` +
                    `${field.wgslType} but its source names ` +
                    `${components.length} component(s).`,
            );
        }
        lines.push(
            `    // offset ${offsets[index]}, ${field.wgslType}\n` +
                components
                    .map((component, lane) =>
                        `    out.${field.name}[${lane}] = ` +
                        `static_cast<float>(${component});`
                    )
                    .join("\n"),
        );
    });
    return `inline void write_${variantName}_material(
    const MaterialRecord& material,
    ${variantName}MaterialUniforms& out) {
${lines.join("\n")}
}`;
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
 * Emits `upstream/pbr_variants.hpp`: one struct per variant plus the table that
 * names each variant's stages and byte size.
 */
export function pinnedPbrVariantsHeader(
    context: LoweringContext,
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
                `inline void write_${name}_${extension.symbolName}(\n` +
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
            writer = `\n\n${materialWriter(name, fields, offsets)}`;
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

#include <bblite/runtime.hpp>

namespace bbl::upstream {

using bbl::MaterialRecord;
using bbl::TextureTransform;

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
