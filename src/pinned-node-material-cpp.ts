/**
 * Emits `upstream/node_variants.hpp` — the C++ side of a composed node graph.
 *
 * A node material carries no records this port authors. Its program, its
 * uniform block's layout and its vertex inputs are all outputs of the pin's
 * own compiler, so the header is a transcript of what composition produced:
 * which stages to load, which vertex inputs to feed them, and the bytes the
 * pin's own `writeNodeUBO` would have written into the block.
 *
 * The mesh block is mirrored from the composed text the same way the material
 * variants' blocks are, because it is the same kind of thing — a struct the
 * shader declares and the PAL must upload byte for byte. `buildMeshStruct` in
 * `node-pipeline.ts` is what wrote it.
 */
import { floatLiteral, stringLiteral } from "./cpp-literals.js";
import {
    mirroredStructFromWgsl,
    variantBindings,
} from "./pinned-pbr-variant-cpp.js";
import type { ComposedNodeMaterial } from "./pinned-node-material.js";

/**
 * One environment resource a composed stage names, joined onto the source the
 * generated slot table already knows it by.
 *
 * The pin decides which binding is which role (`node-env.ts` `emitEnv`), the
 * composed text decides what that binding is called, and the slot table
 * decides which of our textures the role denotes. Each fact comes from its
 * own owner and they are joined here, so no PAL restates any of them.
 */
interface EnvResource {
    textureName: string;
    samplerName: string;
    source: string;
}

/**
 * The pin's four env bindings, by the role `emitEnv` allocates each for and
 * the `material_texture_slots` source that role denotes.
 */
const envResourceRoles = [
    {
        texture: "iblTexture",
        sampler: "iblSampler",
        source: "environment_cube",
    },
    { texture: "brdfLut", sampler: "brdfSampler", source: "brdf_lut" },
] as const;

/**
 * Records the names this graph gives the env bindings the pin allocated.
 *
 * The names are the pin's and identical across graphs, so a second graph
 * naming a binding differently is a pin change this fails on rather than
 * publishing two rows a PAL would resolve by whichever it found first.
 */
function collectEnvResources(
    composed: ComposedNodeMaterial,
    into: Map<string, EnvResource>,
): void {
    const env = composed.envBindings;
    if (!env) return;
    const names = new Map(
        variantBindings(composed.wgsl, composed.wgsl).map(
            (binding) => [binding.binding, binding.name] as const,
        ),
    );
    for (const role of envResourceRoles) {
        const textureName = names.get(env[role.texture]);
        const samplerName = names.get(env[role.sampler]);
        if (textureName === undefined || samplerName === undefined) {
            throw new Error(
                `Node graph declares no name at the env binding the pin ` +
                    `allocated for ${role.texture}.`,
            );
        }
        const found = into.get(role.source);
        if (
            found &&
            (found.textureName !== textureName ||
                found.samplerName !== samplerName)
        ) {
            throw new Error(
                `Node graphs name the ${role.source} pair differently ` +
                    `('${found.textureName}' and '${textureName}').`,
            );
        }
        into.set(role.source, { textureName, samplerName, source: role.source });
    }
}

/** One composed graph, plus the stem its two stages deploy under. */
export interface NodeVariantManifestEntry {
    /** The graph's index in the scene's reach order. */
    index: number;
    /** The deployed stem: `<stem>.native.wgsl` is the file. */
    vertexStem: string;
    fragmentStem: string;
    composed: ComposedNodeMaterial;
}

/** The caster row for one variant, or the absent one. */
function casterRow(variant: NodeVariantManifestEntry): string {
    const caster = variant.composed.esmCaster;
    if (!caster) return '{false, "", "", 0}';
    const stems = nodeCasterStageStems(variant.index);
    return (
        `{true, ${stringLiteral(stems.vertexStem)}, ` +
        `${stringLiteral(stems.fragmentStem)}, ${caster.paramsBinding}}`
    );
}

/** The deployed stems for one graph, both from the same module. */
export function nodeVariantStageStems(
    index: number,
): { vertexStem: string; fragmentStem: string } {
    return { vertexStem: `node-${index}.vert`, fragmentStem: `node-${index}.frag` };
}

/**
 * The stems the ESM caster module deploys under.
 *
 * A second module for the same graph, so it takes the same `node-` prefix
 * -- which is what puts it through the pin's own group scheme in the
 * register remap and publishes the `.slots` sidecar the SDL PAL binds by.
 */
export function nodeCasterStageStems(
    index: number,
): { vertexStem: string; fragmentStem: string } {
    return {
        vertexStem: `node-${index}-esm.vert`,
        fragmentStem: `node-${index}-esm.frag`,
    };
}

/** The pin's own node mesh block, as its composed module declares it. */
function nodeMeshStructBody(wgsl: string, label: string): string {
    const body = /struct MeshU\s*\{([\s\S]*?)\}/.exec(wgsl);
    if (!body) {
        throw new Error(
            `The composed node module ${label} no longer declares ` +
                "'struct MeshU'.",
        );
    }
    return body[1]!;
}

export function pinnedNodeVariantsHeader(
    provenance: string,
    variants: readonly NodeVariantManifestEntry[],
): string {
    if (variants.length === 0) {
        throw new Error("A node scene composed no graphs.");
    }
    // `buildMeshStruct` takes no arguments, so every graph declares the same
    // block and the PAL uploads one struct. Compared as the pin's own text
    // rather than as generated C++: the check is that the pin did not start
    // varying it, and the text is what would have varied.
    const meshBodies = variants.map((variant) =>
        nodeMeshStructBody(variant.composed.wgsl, `node-${variant.index}`)
    );
    for (const [index, body] of meshBodies.entries()) {
        if (body !== meshBodies[0]) {
            throw new Error(
                `Node material ${variants[index]!.index} declares a mesh ` +
                    "block the others do not; the PAL uploads one struct.",
            );
        }
    }
    const attributeRows: string[] = [];
    const textureRows: string[] = [];
    const shadowRows: string[] = [];
    const uniformFloats: number[] = [];
    const entries: string[] = [];
    const envResources = new Map<string, EnvResource>();
    for (const variant of variants) {
        const firstAttribute = attributeRows.length;
        for (const attribute of variant.composed.attributes) {
            attributeRows.push(
                `    {${attribute.location}, ${stringLiteral(attribute.name)}},`,
            );
        }
        const firstTexture = textureRows.length;
        for (const texture of variant.composed.textures) {
            textureRows.push(
                `    {${stringLiteral(texture.name)}, ` +
                    `${texture.texture}, ${texture.sampler}},`,
            );
        }
        const firstShadow = shadowRows.length;
        for (const binding of variant.composed.shadowBindings) {
            shadowRows.push(
                `    {${binding.lightIndex}, ${binding.texture}, ` +
                    `${binding.sampler}, ${binding.ubo}, ` +
                    `${stringLiteral(binding.textureName)}, ` +
                    `${stringLiteral(binding.samplerName)}, ` +
                    `${stringLiteral(binding.uboName)}, ` +
                    `${binding.shadowType === "pcf"}},`,
            );
        }
        const firstFloat = uniformFloats.length;
        uniformFloats.push(...variant.composed.uboFloats);
        const env = variant.composed.envBindings;
        const envRow = env
            ? `{true, ${env.iblTexture}, ${env.iblSampler}, ` +
                `${env.brdfLut}, ${env.brdfSampler}}`
            : "{false, 0, 0, 0, 0}";
        entries.push(
            `    {${stringLiteral(variant.vertexStem)}, ` +
                `${stringLiteral(variant.fragmentStem)}, ` +
                `${variant.composed.backFaceCulling}, ` +
                `${firstAttribute}, ${variant.composed.attributes.length}, ` +
                `${firstTexture}, ${variant.composed.textures.length}, ` +
                `${
                    variant.composed.uboBinding === null
                        ? "node_no_ubo"
                        : variant.composed.uboBinding
                }, ` +
                `${variant.composed.uboBytes}, ${firstFloat}, ` +
                `${envRow}, ` +
                `${firstShadow}, ` +
                `${variant.composed.shadowBindings.length}, ` +
                `${casterRow(variant)}},`,
        );
        collectEnvResources(variant.composed, envResources);
    }
    const envRows = [...envResources.values()].map(
        (resource) =>
            `    {${stringLiteral(resource.textureName)}, ` +
            `${stringLiteral(resource.samplerName)}, ` +
            `MaterialTextureSource::${resource.source}},`,
    );
    return `#pragma once

// ${provenance}

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>

#include <bblite/upstream/material_texture_slots.hpp>

namespace bbl::upstream {

/** One vertex input a composed node stage declares, at its own location. */
struct NodeVariantAttribute {
    std::uint32_t location;
    /** The pin's own attribute name; the PAL maps it onto our vertex. */
    std::string_view name;
};

inline constexpr std::array<
    NodeVariantAttribute,
    ${attributeRows.length}> node_variant_attributes{{
${attributeRows.join("\n")}
}};

/**
 * One texture pair a graph samples, at the bindings the pin's own pipeline
 * builder allocated for it.
 *
 * The name is the sanitized block name \`TextureBlock\` and
 * \`ImageSourceBlock\` bind under, which is also the key the scene's own
 * \`textures\` record is read by — so it is the join between a declared
 * binding and the image the scene supplied, exactly as it is upstream.
 */
struct NodeVariantTexture {
    std::string_view name;
    std::uint32_t texture;
    std::uint32_t sampler;
};

inline constexpr std::array<
    NodeVariantTexture,
    ${textureRows.length}> node_variant_textures{{
${textureRows.join("\n") || "    // No reached graph samples one."}
}};

/** A graph whose named inputs produced no uniform block. */
inline constexpr std::size_t node_no_ubo =
    std::numeric_limits<std::size_t>::max();

/**
 * The environment pair a graph reaching \`ReflectionBlock\` declares.
 *
 * \`node-env.ts\` allocates the four together and binds them from the scene's
 * own \`EnvironmentTextures\` — the same specular cube and BRDF LUT the
 * material families sample — so a PAL resolves them against what it holds
 * rather than owning anything new.
 */
struct NodeVariantEnvBindings {
    bool present;
    std::uint32_t ibl_texture;
    std::uint32_t ibl_sampler;
    std::uint32_t brdf_lut;
    std::uint32_t brdf_sampler;
};

/**
 * Which of our resources one env name denotes, by the slot table's source.
 *
 * The graph's names are the pin's own, so they do not match the PBR binding
 * names the slot rows carry and cannot be resolved by name -- the declared
 * \`source\` is the join key, exactly as it is for the Standard family's
 * \`standard_binding_resources\`. Resolving through it means which texture
 * serves a pinned name is decided once, in one table, for both backends.
 */
struct NodeBindingResource {
    std::string_view texture_name;
    std::string_view sampler_name;
    MaterialTextureSource source;
};

inline constexpr std::array<
    NodeBindingResource,
    ${envRows.length}> node_binding_resources{{
${envRows.join("\n") || "    // No reached graph declares one."}
}};

/**
 * One shadow light's three group-1 bindings, as emitShadow allocated
 * them: the node family continues the GRAPH's own binding run rather than
 * opening a group of its own.
 */
struct NodeVariantShadowBinding {
    std::size_t light_index;
    std::size_t texture;
    std::size_t sampler;
    std::size_t ubo;
    /** The names the emitter declared the three under. */
    std::string_view texture_name;
    std::string_view sampler_name;
    std::string_view ubo_name;
    /** Whether the map is compared rather than sampled. */
    bool comparison;
};

inline constexpr std::array<
    NodeVariantShadowBinding,
    ${shadowRows.length}> node_variant_shadow_bindings{{
${shadowRows.join("\n") || "    // No reached graph receives a shadow."}
}};

/**
 * The ESM caster module a graph composes when the scene casts from it.
 *
 * A second module of the SAME graph -- the pin re-compiles its bodies with
 * the depth code its own ESM view carries -- so it deploys under its own
 * stems and adds exactly one binding, the shadow-params block.
 */
struct NodeVariantCaster {
    bool present;
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    std::size_t params_binding;
};

struct NodeVariantEntry {
    /** The deployed stem of each stage; both name one module. */
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    /** The graph's own \`backFaceCulling\`. */
    bool back_face_culling;
    /** Half-open range into the attribute table above. */
    std::size_t first_attribute;
    std::size_t attribute_count;
    /** Half-open range into the texture table above. */
    std::size_t first_texture;
    std::size_t texture_count;
    /** The node UBO's group-1 binding, or \`node_no_ubo\`. */
    std::size_t ubo_binding;
    std::size_t ubo_bytes;
    /** Where this graph's block starts in the float table below. */
    std::size_t first_uniform_float;
    NodeVariantEnvBindings env;
    /** Half-open range into the shadow-binding table above. */
    std::size_t first_shadow_binding;
    std::size_t shadow_binding_count;
    /** The ESM caster module this graph also composed, when it casts. */
    NodeVariantCaster caster;
};

inline constexpr std::array<
    NodeVariantEntry,
    ${variants.length}> node_variants{{
${entries.join("\n")}
}};

/** The slot source one composed name denotes, or \`no_node_binding_source\`. */
inline constexpr MaterialTextureSource no_node_binding_source =
    static_cast<MaterialTextureSource>(-1);

inline constexpr MaterialTextureSource node_binding_source(
    std::string_view name) {
    for (const NodeBindingResource& row : node_binding_resources) {
        if (name == row.texture_name || name == row.sampler_name) {
            return row.source;
        }
    }
    return no_node_binding_source;
}

/** Whether a graph declares a uniform block at all. The binding and the byte
 *  count answer it together, so one predicate reads both. */
inline constexpr bool has_node_ubo(const NodeVariantEntry& entry) {
    return entry.ubo_binding != node_no_ubo && entry.ubo_bytes > 0;
}

/** Every graph's node UBO, as the floats the pin's own writer places.
 *  The graph's named inputs decide these and no reached scene changes one,
 *  so the block is a constant rather than a per-frame write. */
inline constexpr std::array<
    float,
    ${uniformFloats.length}> node_variant_uniform_floats{{
${uniformFloats.map((value) => `    ${floatLiteral(value)},`).join("\n")}
}};

${
        mirroredStructFromWgsl(
            "NodeMeshUniforms",
            meshBodies[0]!,
            "src/material/node/node-pipeline.ts buildMeshStruct",
        )
    }

} // namespace bbl::upstream
`;
}
