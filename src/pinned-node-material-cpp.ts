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
import { mirroredStructFromWgsl } from "./pinned-pbr-variant-cpp.js";
import type { ComposedNodeMaterial } from "./pinned-node-material.js";

/** One composed graph, plus the stem its two stages deploy under. */
export interface NodeVariantManifestEntry {
    /** The graph's index in the scene's reach order. */
    index: number;
    /** The deployed stem: `<stem>.native.wgsl` is the file. */
    vertexStem: string;
    fragmentStem: string;
    composed: ComposedNodeMaterial;
}

/** The deployed stems for one graph, both from the same module. */
export function nodeVariantStageStems(
    index: number,
): { vertexStem: string; fragmentStem: string } {
    return { vertexStem: `node-${index}.vert`, fragmentStem: `node-${index}.frag` };
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
    const uniformFloats: number[] = [];
    const entries: string[] = [];
    for (const variant of variants) {
        const firstAttribute = attributeRows.length;
        for (const attribute of variant.composed.attributes) {
            attributeRows.push(
                `    {${attribute.location}, ${stringLiteral(attribute.name)}},`,
            );
        }
        const firstFloat = uniformFloats.length;
        uniformFloats.push(...variant.composed.uboFloats);
        entries.push(
            `    {${stringLiteral(variant.vertexStem)}, ` +
                `${stringLiteral(variant.fragmentStem)}, ` +
                `${variant.composed.backFaceCulling}, ` +
                `${firstAttribute}, ${variant.composed.attributes.length}, ` +
                `${
                    variant.composed.uboBinding === null
                        ? "node_no_ubo"
                        : variant.composed.uboBinding
                }, ` +
                `${variant.composed.uboBytes}, ${firstFloat}},`,
        );
    }
    return `#pragma once

// ${provenance}

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>

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

/** A graph whose named inputs produced no uniform block. */
inline constexpr std::size_t node_no_ubo =
    std::numeric_limits<std::size_t>::max();

struct NodeVariantEntry {
    /** The deployed stem of each stage; both name one module. */
    std::string_view vertex_stem;
    std::string_view fragment_stem;
    /** The graph's own \`backFaceCulling\`. */
    bool back_face_culling;
    /** Half-open range into the attribute table above. */
    std::size_t first_attribute;
    std::size_t attribute_count;
    /** The node UBO's group-1 binding, or \`node_no_ubo\`. */
    std::size_t ubo_binding;
    std::size_t ubo_bytes;
    /** Where this graph's block starts in the float table below. */
    std::size_t first_uniform_float;
};

inline constexpr std::array<
    NodeVariantEntry,
    ${variants.length}> node_variants{{
${entries.join("\n")}
}};

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
