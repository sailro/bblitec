import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerMat4InvertCpp, lowerPinnedFunction, type PinnedFunctionParameter } from "./pinned-function-lowerer.js";
import { lowerMat4DecomposeFull } from "./pinned-mat4-decompose.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const modulePath = "src/physics/havok.ts";

export function lowerPhysicsContainer(context: LoweringContext): { header: string; helpers: string; source: string } {
    const add = context.functionDeclaration(modulePath, "addPhysicsShapeChild").declaration;
    context.assertStatementInventory(add, add.body!.statements, "addPhysicsShapeChild",
        "optional transforms and the PAL tuple projection", [
            "variable statement", "variable statement", "variable statement", "expression statement",
        ]);
    for (const shape of [
        "translation ?? { x: 0, y: 0, z: 0 }",
        "rotation ?? { x: 0, y: 0, z: 0, w: 1 }",
        "scale ?? { x: 1, y: 1, z: 1 }",
        "world._hknp.HP_Shape_AddChild(container._hkShape, child._hkShape, [[t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [s.x, s.y, s.z]])",
    ]) {
        if (!context.hasNode(add, node => (ts.isBinaryExpression(node) || ts.isCallExpression(node)) && context.expressionMatchesShape(node, shape))) {
            context.contractError(add, `Physics container projection changed: ${shape}`);
        }
    }
    const parameters: PinnedFunctionParameter[] = [
        ["world", "PhysicsWorld", "PhysicsWorldHandle"],
        ["container", "PhysicsShape", "PhysicsShape"],
        ["parentNode", "SceneNode", "PhysicsNodeRef"],
        ["child", "PhysicsShape", "PhysicsShape"],
        ["childNode", "SceneNode", "PhysicsNodeRef"],
    ].map(([pinned, annotation, cppType]) => ({
        pinned: pinned!, cpp: pinned!, kind: "record", annotation: annotation!, cppType: cppType!,
        binding: {cpp: pinned!, type: "opaque"},
    }));
    const fromParent = lowerPinnedFunction(context, modulePath, "addPhysicsShapeChildFromParent", parameters, {
        cppName: "pinned_add_physics_child_from_parent", returns: "void",
        leadingParameters: ["const Engine& engine"],
        memberBindings: new Map<string, PinnedBinding>([
            ["parentNode.worldMatrix", {cpp: "physics_node_world(engine, parentNode)", type: "f32"}],
            ["childNode.worldMatrix", {cpp: "physics_node_world(engine, childNode)", type: "f32"}],
        ]),
        nullableMatrixCalls: new Set(["mat4Invert"]),
        matrixCalls: new Set(["mat4Multiply"]),
        recordCalls: new Map([["mat4Decompose", ["translation", "rotation", "scale"]]]),
        calls: new Map([
            ["mat4Invert", args => `mat4_invert(${args[0]})`],
            ["mat4Multiply", args => `physics_matrix_product(${args.join(", ")})`],
            ["mat4Decompose", args => `pinned_parent_mat4_decompose(${args[0]})`],
            ["addPhysicsShapeChild", args => `(static_cast<void>(${args[0]}), pal::physics_shape_add_child(` +
                `${args[1]}.handle, ${args[2]}.handle, {{${args[3]}.x, ${args[3]}.y, ${args[3]}.z}, ` +
                `{${args[4]}.x, ${args[4]}.y, ${args[4]}.z, ${args[4]}.w}}, ` +
                `{${args[5]}.x, ${args[5]}.y, ${args[5]}.z}))`],
        ]),
    });
    return {
        header: `
PhysicsShape create_physics_container_shape(PhysicsWorldHandle world);
void add_physics_shape_child_from_parent(PhysicsWorldHandle world, PhysicsShape container,
    PhysicsNodeRef parent, PhysicsShape child, PhysicsNodeRef node);
`,
        helpers: `
${lowerMat4InvertCpp(context)}
${lowerMat4DecomposeFull(context)}
std::array<float, 16> physics_matrix_product(const std::array<float, 16>& a, const std::array<float, 16>& b) {
    std::array<float, 16> result{};
    mat4_multiply_into(result, 0, a, 0, b, 0);
    return result;
}
std::array<float, 16> physics_node_world(const Engine& engine, PhysicsNodeRef node) {
    if (node.kind == PhysicsNodeKind::mesh) return mesh_world_matrix(engine, engine.meshes.at(node.value));
    if (node.value >= engine.transform_nodes.size()) throw std::runtime_error("Physics child placement requires a live node.");
    return transform_node_world(engine, TransformNodeHandle{node.value});
}
${fromParent}
`,
        source: `
PhysicsShape create_physics_container_shape(PhysicsWorldHandle world) {
    static_cast<void>(physics_world_record(world));
    return PhysicsShape{pal::physics_shape_create_container()};
}
void add_physics_shape_child_from_parent(PhysicsWorldHandle world, PhysicsShape container,
    PhysicsNodeRef parent, PhysicsShape child, PhysicsNodeRef node) {
    pinned_add_physics_child_from_parent(*physics_world_record(world).engine, world, container, parent, child, node);
}
`,
    };
}
