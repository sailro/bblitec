import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    collectionBinding,
    type PinnedBinding,
    type PinnedCallSpelling,
} from "./pinned-numeric-lowerer.js";

const module = "src/scene/visibility.ts";

/** `bumpVisibilityEpoch`: the pin's visibility epoch is the native draw-list membership epoch. */
export function bumpVisibilityEpochCall(
    engine = "engine",
): readonly [string, PinnedCallSpelling] {
    return ["bumpVisibilityEpoch", () => `(++${engine}.draw_list_epoch)`];
}

/**
 * `subtree_visibility.hpp`: `setSubtreeVisible` and its `cascade`, lowered
 * once over a native node graph. A graph names its `Node`, its `engine`,
 * each node's `visible` slot and its `children` (a sized, indexable view);
 * the mesh graph here and the scene-node and glTF-node graphs all set
 * visibility through these.
 */
export function subtreeVisibilityHeader(context: LoweringContext): string {
    const lower = (name: string): string => {
        const { file, declaration } = context.functionDeclaration(module, name);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map<string, PinnedBinding>([
                ["node", { cpp: "node", type: "opaque" }],
                ["v", { cpp: "v", type: "bool" }],
                ["node.visible", { cpp: "graph.visible(node)", type: "bool" }],
                [
                    "node.children",
                    {
                        ...collectionBinding("graph.children(node)"),
                        materializeAlias: true,
                    },
                ],
            ]),
            calls: new Map([
                [
                    "cascade",
                    (args) =>
                        `subtree_visible_cascade(graph, ${args.join(", ")})`,
                ],
                bumpVisibilityEpochCall("graph.engine"),
            ]),
            returnValue: (expression, numeric) =>
                expression
                    ? numeric.expression(expression)
                    : context.contractError(
                          declaration,
                          "Expected the cascade's changed flag.",
                      ),
        });
    };
    return `#pragma once
#include <bblite/runtime.hpp>
#include <variant>
#include <vector>

namespace bbl::upstream {

inline const MeshHandle* visibility_mesh(const MeshHandle& node) { return &node; }
template <class... Kinds>
const MeshHandle* visibility_mesh(const std::variant<Kinds...>& node) {
    return std::get_if<MeshHandle>(&node);
}

// ${context.provenance(module, "cascade")}
template <class Graph>
bool subtree_visible_cascade(Graph& graph, const typename Graph::Node& node, bool v) {
    // The pin writes a disposed child too; once a later mesh holds its slot
    // nothing can observe that write, so a stale mesh is left alone.
    if (const MeshHandle* mesh = visibility_mesh(node); mesh && !current_mesh_record(graph.engine, *mesh)) return false;
${lower("cascade")}
}

// ${context.provenance(module, "setSubtreeVisible")}
template <class Graph>
void set_subtree_visible(Graph&& graph, const typename std::decay_t<Graph>::Node& node, bool v) {
${lower("setSubtreeVisible")}
}

// A mesh's children are meshes.
struct MeshVisibilityGraph {
    using Node = MeshHandle;
    Engine& engine;
    MeshVisibility& visible(MeshHandle mesh) { return ${recordAt("engine.meshes", "mesh")}.visible; }
    const std::vector<MeshHandle>& children(MeshHandle mesh) { return ${recordAt("engine.meshes", "mesh")}.children; }
};

} // namespace bbl::upstream
`;
}
