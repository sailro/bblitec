import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedStatements } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** The non-mesh SceneNode removal tail and snapshot recursion, over retained handles. */
export function lowerSceneNodeRemoval(context: LoweringContext): string {
    const module = "src/scene/scene-remove.ts";
    const children = context.functionDeclaration(module, "removeChildren");
    const childBody = new PinnedNumericLowerer(children.file, {
        bindings: new Map<string, PinnedBinding>([
            ["scene", { cpp: "scene", type: "opaque" }],
            [
                "node.children",
                {
                    cpp: "scene_node_children(*scene.engine, node)",
                    type: "opaque",
                    materializeAlias: true,
                },
            ],
            [
                "kids?.length",
                { cpp: "static_cast<double>(kids.size())", type: "scalar" },
            ],
        ]),
        calls: new Map([
            [
                "removeFromScene",
                (args) => `remove_from_scene(${args.join(", ")})`,
            ],
        ]),
        forOf(iterated, element) {
            if (iterated !== "[...kids]") return undefined;
            return {
                range: "js::array_from_iterable<SceneNodeHandle>(kids)",
                bindings: new Map([
                    [element, { cpp: element, type: "opaque" }],
                ]),
            };
        },
    });
    const remove = context.functionDeclaration(module, "removeFromScene");
    const removeBody = new PinnedNumericLowerer(remove.file, {
        bindings: new Map<string, PinnedBinding>([
            ["scene", { cpp: "scene", type: "opaque" }],
            ["entity", { cpp: "node", type: "opaque" }],
        ]),
        calls: new Map([
            [
                "detachParent",
                (args) => `detach_scene_node_parent(*scene.engine, ${args[0]})`,
            ],
            [
                "removeChildren",
                (args) => `remove_scene_node_children(${args.join(", ")})`,
            ],
        ]),
    });
    // This specialization receives only TransformNode or synthetic root records;
    // native mesh dispatch uses the existing mesh retirement implementation.
    const absentFields = new Set([
        "entities",
        "_gpu",
        "material",
        "lightType",
        "fov",
        "nearPlane",
        "_shadowType",
        "_light",
    ]);
    for (const probe of context.findNodes(
        remove.declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.InKeyword,
    )) {
        if (
            !ts.isStringLiteral(probe.left) ||
            !absentFields.has(probe.left.text) ||
            !ts.isIdentifier(probe.right) ||
            probe.right.text !== "entity"
        )
            context.contractError(
                probe,
                "Unrepresented SceneNode removal discriminator.",
            );
        removeBody.bindLocal(probe, {
            cpp: "false",
            type: "bool",
            staticBoolean: false,
        });
    }
    return `// ${context.provenance(module, "removeFromScene, removeChildren")}
namespace {
void detach_scene_node_parent(Engine& engine, const SceneNodeHandle& node) {
    std::visit([&](const auto& concrete) {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, TransformNodeHandle>) {
            set_transform_node_parent(engine, concrete, {});
        } else if constexpr (std::is_same_v<Handle, AssetHandle>) {
            set_transform_node_parent(engine, engine.assets.at(concrete.value).root_node, {});
        } else {
            throw std::runtime_error("Mesh parent detachment belongs to mesh removal.");
        }
    }, node);
}
void remove_scene_node_children(Scene& scene, const SceneNodeHandle& node) {
${lowerPinnedStatements(childBody, children.declaration.body!.statements)}
}
void remove_scene_graph_node(Scene& scene, const SceneNodeHandle& node) {
${lowerPinnedStatements(removeBody, remove.declaration.body!.statements)}
}
}
void remove_from_scene(Scene& scene, const SceneNodeHandle& node) {
    require_scene_engine(scene);
    std::visit([&](const auto& concrete) {
        using Handle = std::decay_t<decltype(concrete)>;
        if constexpr (std::is_same_v<Handle, MeshHandle>) remove_from_scene(scene, concrete);
        else remove_scene_graph_node(scene, node);
    }, node);
}
`;
}
