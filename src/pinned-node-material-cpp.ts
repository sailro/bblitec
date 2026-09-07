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
    pinnedShadowBindingRow,
    shadowBindingSlotOrNull,
    variantBindings,
} from "./pinned-pbr-variant-cpp.js";
import type {
    ComposedNodeAttribute,
    ComposedNodeGeometryView,
    ComposedNodeMaterial,
    ComposedNodeTextureBinding,
} from "./pinned-node-material.js";

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

/**
 * One graph's receiver rows, reflected out of its own composed text.
 *
 * The pin allocates the three binding NUMBERS per shadow light and declares
 * them under `shadowTex_N` / `shadowSamp_N` or `shadowComp_N` / `shadowInfo_N`.
 * Reading the rows back out of the module is what makes each one's TYPE and
 * stage visibility the pin's answer rather than this port's -- a PCF light
 * declares a depth texture and a comparison sampler where an ESM one declares
 * a float texture and a plain sampler -- and the numbers the pin allocated are
 * then checked against what it declared, so a graph whose emitter moved one
 * fails here instead of binding a neighbour's resource.
 */
function nodeShadowRows(composed: ComposedNodeMaterial): string[] {
    if (composed.shadowBindings.length === 0) return [];
    const reflected = new Map(
        variantBindings(composed.wgsl, composed.wgsl).map(
            (binding) => [binding.binding, binding] as const,
        ),
    );
    const rows: string[] = [];
    for (const light of composed.shadowBindings) {
        for (const binding of [light.texture, light.sampler, light.ubo]) {
            const entry = reflected.get(binding);
            const slot = entry
                ? shadowBindingSlotOrNull(entry.name)
                : null;
            if (!entry || !slot) {
                throw new Error(
                    "A node graph declares no shadow binding at " +
                        `${binding}, which the pin allocated for light ` +
                        `${light.lightIndex}.`,
                );
            }
            if (slot.light !== light.lightIndex) {
                throw new Error(
                    `A node graph's shadow binding '${entry.name}' names ` +
                        `light ${slot.light} at the binding the pin ` +
                        `allocated for ${light.lightIndex}.`,
                );
            }
            rows.push(pinnedShadowBindingRow(entry, slot));
        }
    }
    return rows;
}

/**
 * The native row for a graph's morph storage pair.
 *
 * `_morphBindings` owns the numbers, while the module owns the declarations.
 * Check that join once at generation so neither backend can silently bind a
 * neighbouring graph resource if the pin changes its names or resource kind.
 */
function nodeMorphRow(composed: ComposedNodeMaterial): string {
    const morph = composed.morphBindings;
    if (!morph) return "{false, 0, 0}";
    const reflected = new Map(
        variantBindings(composed.wgsl, "").map(
            (binding) => [binding.binding, binding] as const,
        ),
    );
    for (const [binding, name] of [
        [morph.deltas, "morphDeltas"],
        [morph.weights, "morph"],
    ] as const) {
        const entry = reflected.get(binding);
        if (!entry || entry.name !== name || entry.kind !== "storageBuffer") {
            throw new Error(
                `A node graph's ${name} binding ${binding} is not the ` +
                    "read-only storage buffer the pin allocated.",
            );
        }
    }
    return `{true, ${morph.deltas}, ${morph.weights}}`;
}

/** A group-1 binding the pin allocated, or the header's own absent value. */
function uboBindingLiteral(binding: number | null): string {
    return binding === null ? "node_no_ubo" : String(binding);
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

/** Whether any compiled node graph needs the native morph-buffer lifetime. */
export function nodeVariantsUseMorphStorage(
    variants: readonly NodeVariantManifestEntry[],
): boolean {
    return variants.some(
        (variant) => variant.composed.morphBindings !== null,
    );
}

/** The caster row for one variant, or the absent one. */
function casterRow(variant: NodeVariantManifestEntry): string {
    const caster = variant.composed.caster;
    if (!caster) return '{false, false, "", "", 0}';
    const stems = nodeCasterStageStems(
        variant.index,
        caster.kind,
    );
    return (
        `{true, ${caster.kind === "esm"}, ` +
        `${stringLiteral(stems.vertexStem)}, ` +
        `${stringLiteral(stems.fragmentStem)}, ` +
        `${caster.kind === "esm" ? caster.paramsBinding : 0}}`
    );
}

/** The deployed stems for one graph, both from the same module. */
export function nodeVariantStageStems(
    index: number,
): { vertexStem: string; fragmentStem: string } {
    return { vertexStem: `node-${index}.vert`, fragmentStem: `node-${index}.frag` };
}

/**
 * The stems a node caster module deploys under.
 *
 * A second module for the same graph, so it takes the same `node-` prefix
 * -- which is what puts it through the pin's own group scheme in the
 * register remap and publishes the `.slots` sidecar the SDL PAL binds by.
 */
export function nodeCasterStageStems(
    index: number,
    kind: "esm" | "pcf" = "esm",
): { vertexStem: string; fragmentStem: string } {
    return {
        vertexStem: `node-${index}-${kind}.vert`,
        fragmentStem: `node-${index}-${kind}.frag`,
    };
}

/**
 * The stems one graph's geometry-output module deploys under, per task.
 *
 * A third module of the same graph, under the same `node-` prefix and for the
 * same reason. Keyed by the task as well as the graph because the emit walks
 * the task's own attachment list -- two tasks over one graph are two modules.
 */
function nodeGeometryStageStems(
    index: number,
    taskIndex: number,
): { vertexStem: string; fragmentStem: string } {
    return {
        vertexStem: `node-${index}-geom${taskIndex}.vert`,
        fragmentStem: `node-${index}-geom${taskIndex}.frag`,
    };
}

/** One composed geometry view, with the graph and task it belongs to. */
export interface NodeGeometryVariantManifestEntry {
    /** The graph's index in `node_variants`. */
    variantIndex: number;
    vertexStem: string;
    fragmentStem: string;
    composed: ComposedNodeGeometryView;
}

/**
 * The tasks each graph composed a view for.
 *
 * One number rather than a per-graph count: composition hands every graph the
 * same task list, so a graph that composed a different number of views is a
 * composition bug this refuses rather than an index the header would have to
 * search around.
 */
function geometryTaskCount(
    geometryVariants: readonly NodeGeometryVariantManifestEntry[],
): number {
    const perGraph = new Map<number, number>();
    for (const variant of geometryVariants) {
        perGraph.set(
            variant.variantIndex,
            (perGraph.get(variant.variantIndex) ?? 0) + 1,
        );
    }
    const counts = new Set(perGraph.values());
    if (counts.size > 1) {
        throw new Error(
            "Node graphs composed geometry views for different numbers of " +
                `tasks (${[...counts].join(", ")}).`,
        );
    }
    return [...counts][0] ?? 0;
}

/** Every geometry view of every graph, in graph then task order. */
export function nodeGeometryVariants(
    variants: readonly NodeVariantManifestEntry[],
): readonly NodeGeometryVariantManifestEntry[] {
    return variants.flatMap((variant) =>
        variant.composed.geometryViews.map((composed) => ({
            variantIndex: variant.index,
            ...nodeGeometryStageStems(variant.index, composed.taskIndex),
            composed,
        })));
}

/**
 * The geometry-view table, or nothing at all for a scene composing none.
 *
 * Absent rather than empty because the ten shipped node scenes reach no
 * geometry task: an empty array here would move every byte after it in their
 * `node_variants.hpp`, and the neutrality proof for this arm is that it moved
 * nothing they emit. `BBLITE_NODE_GEOMETRY_VARIANTS` is what tells the PALs
 * which shape they are compiling against.
 */
function geometryTable(
    rows: readonly string[],
    tasks: number,
    graphs: number,
): string {
    if (rows.length === 0) return "";
    return `
/**
 * How many rows of \`node_variants\` above are graphs.
 *
 * The geometry views continue the same table after every graph, so this is
 * where they start -- and it is the bound the render plan's own
 * \`shader_variant\` is checked against, which \`node_variants.size()\` stopped
 * being once the views joined.
 */
inline constexpr std::size_t node_graph_count = ${graphs};

/**
 * One geometry-output view of a graph: the module
 * \`material/node/node-geometry-view.ts\` composes for ONE task's attachment
 * list.
 *
 * A third module of the same graph, beside the colour view and the caster --
 * but not a variation of either: \`ensureGeometryResources\` emits the graph
 * again from its \`GeometryTextureOutputBlock\` terminal, so the vertex
 * inputs, the texture pairs and the uniform block are the geometry emit's own.
 * They are a \`node_variants\` row of their own for exactly that reason: what
 * a compiled view declares is one row shape, so a bind site reads any view
 * the same way. This table carries only what a geometry view has and the
 * colour view has not, keyed by the pair that resolves it.
 */
struct NodeGeometryVariantEntry {
    /** The graph in \`node_variants\` this view was emitted from. */
    std::size_t variant;
    /** The task's own \`shader_index\`, the runtime's registration order. */
    std::size_t geometry_task;
    /**
     * \`NmeGeomParams\`' group-1 binding, or \`node_no_ubo\`.
     *
     * \`compileNodePipeline\` allocates it only when the emit raised
     * \`_needsGpUbo\` -- a NORMALIZED_VIEW_DEPTH or LINEAR_VELOCITY
     * attachment the graph left to the pin's own fallback -- so it is a
     * property of the attachment list and the graph together, never of the
     * task alone.
     */
    std::size_t geometry_params_binding;
    /** The colour targets this view's \`FragmentOutput\` writes. */
    std::size_t color_target_count;
};

inline constexpr std::array<
    NodeGeometryVariantEntry,
    ${rows.length}> node_geometry_variants{{
${rows.join("\n")}
}};

/** The \`node_variants\` row one geometry view was emitted into: the views
 *  follow the graphs in the order this table lists them. */
inline constexpr std::size_t node_geometry_entry(
    std::size_t geometry_variant) {
    return node_graph_count + geometry_variant;
}

// Which makes the two tables one join, so a build where they grew out of
// step -- and would resolve a neighbour's module for every geometry draw --
// fails here rather than at a draw.
static_assert(
    node_graph_count + node_geometry_variants.size() ==
        node_variants.size(),
    "Every node_variants row past the graphs is one composed geometry view.");

/** No geometry view of this graph was composed for that task. */
inline constexpr std::size_t node_no_geometry_variant =
    std::numeric_limits<std::size_t>::max();

/**
 * The geometry view one node draw resolves inside one task.
 *
 * Keyed by both because a graph drawn in two tasks composed two modules, and
 * a graph a task never draws composed none -- so a draw that reaches a task
 * with no row is a generation gap, and both backends refuse it by name rather
 * than falling back to the colour view's single-target pipeline.
 *
 * Every graph composes a view for every task the scene registered, so the
 * table is dense and this is an index rather than a scan -- it runs per node
 * draw, per frame. The row it lands on is checked against the pair asked for,
 * so a table that stopped being dense refuses instead of resolving a
 * neighbour's view.
 */
inline constexpr std::size_t node_geometry_tasks = ${tasks};

inline constexpr std::size_t node_geometry_variant_for(
    std::size_t variant,
    std::size_t geometry_task) {
    if (geometry_task >= node_geometry_tasks) {
        return node_no_geometry_variant;
    }
    const std::size_t index = variant * node_geometry_tasks + geometry_task;
    if (
        index >= node_geometry_variants.size() ||
        node_geometry_variants[index].variant != variant ||
        node_geometry_variants[index].geometry_task != geometry_task) {
        return node_no_geometry_variant;
    }
    return index;
}
`;
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
    // Derived from `variants`, but passed in: the same list decides the
    // `BBLITE_NODE_GEOMETRY_VARIANTS` define, the render plan's node arm and
    // the deployed modules, and one computed list is one predicate rather
    // than four that a later edit could desynchronise.
    geometryVariants: readonly NodeGeometryVariantManifestEntry[],
): string {
    if (variants.length === 0) {
        throw new Error("A node scene composed no graphs.");
    }
    // `buildMeshStruct` takes no arguments, so every graph declares the same
    // block and the PAL uploads one struct. Compared as the pin's own text
    // rather than as generated C++: the check is that the pin did not start
    // varying it, and the text is what would have varied. Every emitted
    // module joins, geometry views included -- they run the same builder.
    const meshBodies = [
        ...variants.map((variant) => ({
            label: `node-${variant.index}`,
            body: nodeMeshStructBody(
                variant.composed.wgsl,
                `node-${variant.index}`,
            ),
        })),
        ...geometryVariants.map((variant) => ({
            label: variant.fragmentStem,
            body: nodeMeshStructBody(
                variant.composed.wgsl,
                variant.fragmentStem,
            ),
        })),
    ];
    for (const { label, body } of meshBodies) {
        if (body !== meshBodies[0]!.body) {
            throw new Error(
                `Node module ${label} declares a mesh block the others do ` +
                    "not; the PAL uploads one struct.",
            );
        }
    }
    const attributeRows: string[] = [];
    const textureRows: string[] = [];
    const inputRows: string[] = variants.flatMap((variant) => variant.composed.inputs.map((input) =>
        `    {${variant.index}, ${stringLiteral(input.name)}, ${stringLiteral(input.type)}},`));
    const shadowRows: string[] = [];
    const uniformFloats: number[] = [];
    const entries: string[] = [];
    const envResources = new Map<string, EnvResource>();
    // Every compiled view contributes to the same three tables, so both loops
    // below append through one writer: the colour, caster and geometry views
    // of a graph are separate emits, and a row shape that drifted between
    // them would desynchronise the ranges silently.
    const pushViewRows = (composed: {
        attributes: readonly ComposedNodeAttribute[];
        textures: readonly ComposedNodeTextureBinding[];
        uboFloats: readonly number[];
    }): { firstAttribute: number; firstTexture: number; firstFloat: number } => {
        const firstAttribute = attributeRows.length;
        for (const attribute of composed.attributes) {
            attributeRows.push(
                `    {${attribute.location}, ${stringLiteral(attribute.name)}},`,
            );
        }
        const firstTexture = textureRows.length;
        for (const texture of composed.textures) {
            textureRows.push(
                `    {${stringLiteral(texture.name)}, ` +
                    `${texture.texture}, ${texture.sampler}},`,
            );
        }
        const firstFloat = uniformFloats.length;
        uniformFloats.push(...composed.uboFloats);
        return { firstAttribute, firstTexture, firstFloat };
    };
    for (const variant of variants) {
        const { firstAttribute, firstTexture, firstFloat } =
            pushViewRows(variant.composed);
        const firstShadow = shadowRows.length;
        const variantShadowRows = nodeShadowRows(variant.composed);
        shadowRows.push(...variantShadowRows);
        const env = variant.composed.envBindings;
        const envRow = env
            ? `{true, ${env.iblTexture}, ${env.iblSampler}, ` +
                `${env.brdfLut}, ${env.brdfSampler}}`
            : "{false, 0, 0, 0, 0}";
        const morphRow = nodeMorphRow(variant.composed);
        entries.push(
            `    {${stringLiteral(variant.vertexStem)}, ` +
                `${stringLiteral(variant.fragmentStem)}, ` +
                `${variant.composed.backFaceCulling}, ` +
                `${variant.composed.alphaBlending}, ` +
                `${firstAttribute}, ${variant.composed.attributes.length}, ` +
                `${firstTexture}, ${variant.composed.textures.length}, ` +
                `${uboBindingLiteral(variant.composed.uboBinding)}, ` +
                `${variant.composed.uboBytes}, ${firstFloat}, ` +
                `${envRow}, ` +
                `${morphRow}, ` +
                `${firstShadow}, ` +
                `${variantShadowRows.length}, ` +
                `${casterRow(variant)}},`,
        );
        collectEnvResources(variant.composed, envResources);
    }
    // The geometry views' rows continue the same three tables and
    // `node_variants` itself, AFTER every colour and caster row: a scene
    // composing none leaves all four exactly as they were, which is what
    // keeps the ten shipped node scenes' `node_variants.hpp` byte-identical.
    //
    // A geometry view is a compiled view like the other two, so it is a row
    // of the same shape and every bind site reads it the same way. The four
    // arms it does not have are stated as absent rather than left for a
    // per-view branch to remember: `ensureGeometryResources` refuses a
    // morph-target, environment or shadow-receiving geometry arm outright
    // (`pinned-node-material.ts` names it in the refusal), and a view is
    // never a caster. `ensureGeometryCompile` compiles at the pin's alpha
    // mode 0 and passes the GRAPH's own `backFaceCulling` through, which is
    // the pair the two remaining fields carry.
    const graphCount = entries.length;
    const geometryEntries = geometryVariants.map((variant) => {
        const graph = variants.find(
            (entry) => entry.index === variant.variantIndex,
        );
        if (!graph) {
            throw new Error(
                `A composed node geometry view names graph ` +
                    `${variant.variantIndex}, which the scene did not reach.`,
            );
        }
        const { firstAttribute, firstTexture, firstFloat } =
            pushViewRows(variant.composed);
        entries.push(
            `    {${stringLiteral(variant.vertexStem)}, ` +
                `${stringLiteral(variant.fragmentStem)}, ` +
                `${graph.composed.backFaceCulling}, ` +
                `false, ` +
                `${firstAttribute}, ${variant.composed.attributes.length}, ` +
                `${firstTexture}, ${variant.composed.textures.length}, ` +
                `${uboBindingLiteral(variant.composed.uboBinding)}, ` +
                `${variant.composed.uboBytes}, ${firstFloat}, ` +
                `{false, 0, 0, 0, 0}, ` +
                `{false, 0, 0}, ` +
                `${shadowRows.length}, ` +
                `0, ` +
                `{false, false, "", "", 0}},`,
        );
        return (
            `    {${variant.variantIndex}, ` +
            `${variant.composed.taskIndex}, ` +
            `${uboBindingLiteral(variant.composed.geometryParamsBinding)}, ` +
            `${variant.composed.colorTargetCount}},`
        );
    });
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
// PinnedShadowBinding and its two enums: the receiver row shape every
// family shares.
#include <bblite/upstream/pinned_variant_bindings.hpp>

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

/** Factory input objects retain identity independently of the shared graph. */
struct NodeVariantInput {
    std::uint32_t variant;
    std::string_view name;
    std::string_view type;
};

inline constexpr std::array<NodeVariantInput, ${inputRows.length}> node_variant_inputs{{
${inputRows.join("\n")}
}};

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
 * The storage buffers declared by \`MorphTargetsBlock\`, at the exact group-1
 * bindings allocated by the pin's node pipeline.
 */
struct NodeVariantMorphBindings {
    bool present;
    std::uint32_t deltas_binding;
    std::uint32_t weights_binding;
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
 * The receiver rows of every reached graph, in the shared shape.
 *
 * \`emitShadow\` continues the GRAPH's own group-1 binding run rather than
 * opening a group of its own -- that is the whole difference from the two
 * composed families -- but the rows themselves are the same three per light
 * under the same names, so they are reflected out of the composed text and
 * bound through the per-row builders both backends already have.
 */
inline constexpr std::array<
    PinnedShadowBinding,
    ${shadowRows.length}> node_shadow_bindings{{
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
    bool esm;
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    std::size_t params_binding;
};

/** The two stems one compiled view deploys under. */
struct NodeVariantStems {
    std::string_view vertex;
    std::string_view fragment;
};

struct NodeVariantEntry {
    /** The deployed stem of each stage; both name one module. */
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    /** The graph's own \`backFaceCulling\`. */
    bool back_face_culling;
    /** The pin's alpha mode 2: src-alpha / one-minus-src-alpha. */
    bool alpha_blending;
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
    NodeVariantMorphBindings morph;
    /** Half-open range into the shadow-binding table above. */
    std::size_t first_shadow_binding;
    std::size_t shadow_binding_count;
    /** The ESM caster module this graph also composed, when it casts. */
    NodeVariantCaster caster;
};

inline constexpr std::array<
    NodeVariantEntry,
    ${entries.length}> node_variants{{
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
${
        geometryTable(
            geometryEntries,
            geometryTaskCount(geometryVariants),
            graphCount,
        )
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
            meshBodies[0]!.body,
            "src/material/node/node-pipeline.ts buildMeshStruct",
        )
    }

} // namespace bbl::upstream
`;
}
