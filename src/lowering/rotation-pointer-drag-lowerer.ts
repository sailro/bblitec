/** Source-translated plane-rotation drag; retained native handles replace node identities. */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction, lowerObjectComponents } from "./pinned-function-lowerer.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";
import { PINNED_DECOMPOSE_ROTATION } from "./pinned-mat4-decompose.js";

const MATH = "src/gizmo/gizmo-math.ts";
const ROTATION = "src/gizmo/plane-rotation-gizmo.ts";

export function lowerRotationPointerDrag(context: LoweringContext): string {
    const calls = new Map(pinnedNumericMathCallsWithHypot());
    for (const [source, native] of [
        ["dotVec3", "drag_dot"], ["crossVec3", "drag_cross"],
        ["signedAngleAroundNormal", "drag_signed_angle"], ["quatMul", "quat_mul"],
        ["quatNormalize", "quat_normalize"], ["quatFromAxisAngle", "quat_from_axis_angle"],
        ["rotationQuatFromMatrix", "drag_parent_rotation"],
    ]) calls.set(source!, args => `${native}(${args.join(", ")})`);
    const parameters = (names: string[]) => names.map(name => ({
        pinned: name, cpp: name, kind: "record" as const, cppType: "Vec3d", annotation: "Vec3",
        binding: { cpp: name, type: "vec3" as const },
    }));
    const cross = lowerPinnedFunction(context, "src/math/cross-vec3.ts", "crossVec3", parameters(["a", "b"]), {
        cppName: "drag_cross", calls, returns: { type: "Vec3d", value: (lowerer, expression) =>
            `Vec3d{${lowerObjectComponents(context, lowerer, expression!, ["x", "y", "z"]).join(", ")}}` },
    });
    const angle = lowerPinnedFunction(context, MATH, "signedAngleAroundNormal", parameters(["a", "b", "normal"]), {
        cppName: "drag_signed_angle", calls, callShapes: new Map([["crossVec3", "vec3"]]), returns: "double",
    });
    const tupleCalls = new Map(["quatMul", "quatNormalize", "quatFromAxisAngle", "worldRotationToLocal", "rotationQuatFromMatrix"].map(name => [name, 4]));
    const worldLocal = context.functionDeclaration(MATH, "worldRotationToLocal");
    const localStatements = [...worldLocal.declaration.body!.statements];
    const parentQuaternion = localStatements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations[0]?.name.getText(worldLocal.file) === "pq");
    if (parentQuaternion < 0) context.contractError(worldLocal.declaration, "Expected the parent quaternion conjugation.");
    const localLowerer = new PinnedNumericLowerer(worldLocal.file, {
        calls, fixedTupleCalls: tupleCalls,
        bindings: new Map<string, PinnedBinding>([
            ["parent.worldMatrix", { cpp: "(*parent)", type: "f32" }],
            ["invPq", { cpp: "invPq", type: "f64-buffer" }],
            ...["dqx", "dqy", "dqz", "dqw"].map(name => [name, { cpp: name, type: "scalar" }] as [string, PinnedBinding]),
        ]), returnValue: expression => localLowerer.expression(expression!),
    });
    const factory = context.functionDeclaration(ROTATION, "createPlaneRotationGizmo");
    let callback: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(factory.file) === "drag.onDrag.add" &&
            node.arguments[0] && ts.isArrowFunction(node.arguments[0])) callback = node.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(factory.declaration);
    if (!factory.declaration.getText(factory.file).includes('"setAttribute" in canvas')) {
        context.contractError(factory.declaration, "Expected host canvas auto-registration for rotation input.");
    }
    if (!callback || !ts.isBlock(callback.body)) context.contractError(factory.declaration, "Missing plane rotation drag callback.");
    const body = [...callback.body.statements];
    const begin = body.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText(factory.file) === "nx");
    const end = body.findIndex(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(factory.file) === "rq.set");
    if (begin < 0 || end <= begin) context.contractError(callback, "Missing plane rotation quaternion update.");
    const quaternion = body.find(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations[0]?.name.getText(factory.file) === "rq") as ts.VariableStatement | undefined;
    if (quaternion?.declarationList.declarations[0]?.initializer?.getText(factory.file) !== "node.rotationQuaternion") {
        context.contractError(callback, "Expected rotation drag to write the attached node quaternion.");
    }
    calls.set("worldRotationToLocal", args => `drag_local_rotation(engine, ${args.join(", ")})`);
    calls.set("rq.set", args => `set_mesh_rotation_quaternion(engine, handle, Vec4{${args.map(arg => `static_cast<float>(${arg})`).join(", ")}}, true)`);
    const lowerer = new PinnedNumericLowerer(factory.file, {
        calls, fixedTupleCalls: tupleCalls, vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        bindings: new Map<string, PinnedBinding>([
            ["wm", { cpp: "wm", type: "f32" }], ["node", { cpp: "node", type: "scalar" }],
            ["lastDragPoint", { cpp: "lastDragPoint", type: "vec3" }],
            ["event.dragPlanePoint", { cpp: "hit", type: "vec3" }],
            ...["x", "y", "z"].map(lane => [`event.dragPlanePoint.${lane}`, { cpp: `hit.${lane}`, type: "scalar" }] as [string, PinnedBinding]),
            ["planeNormal", { cpp: "normal", type: "vec3" }],
            ...["x", "y", "z", "w"].map(lane => [`rq.${lane}`, { cpp: `static_cast<double>(node.rotation_quaternion.${lane})`, type: "scalar" }] as [string, PinnedBinding]),
        ]),
    });
    const translated = body.slice(begin, end + 1).filter(statement => !(ts.isVariableStatement(statement) &&
        statement.declarationList.declarations[0]?.name.getText(factory.file) === "rq"))
        .flatMap(statement => lowerer.statement(statement, "    ")).join("\n");
    const localBody = localStatements.slice(parentQuaternion).flatMap(statement => {
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText(worldLocal.file) === "invPq") {
            const expression = statement.declarationList.declarations[0].initializer!;
            if (!ts.isArrayLiteralExpression(expression) || expression.elements.length !== 4) context.contractError(expression, "Expected the inverse parent quaternion tuple.");
            return [`    const std::array<double, 4> invPq{${expression.elements.map(item => localLowerer.expression(item)).join(", ")}};`];
        }
        return localLowerer.statement(statement, "    ");
    }).join("\n");
    return `
${cross}
${angle}
std::array<double, 4> drag_parent_rotation(const std::array<float, 16>& world) {
    const auto q = ${PINNED_DECOMPOSE_ROTATION}(world);
    return {q.x, q.y, q.z, q.w};
}
// ${context.provenance(MATH, "worldRotationToLocal")}
std::array<double, 4> drag_local_rotation(Engine& engine, const MeshRecord& node,
    double dqx, double dqy, double dqz, double dqw) {
    std::optional<std::array<float, 16>> parent;
    if (node.parent.value < engine.meshes.size()) parent = upstream::mesh_world_matrix(engine, engine.meshes[node.parent.value]);
    else if (node.transform_parent.value < engine.transform_nodes.size()) parent = upstream::transform_node_world(engine, node.transform_parent);
    if (!parent) return {dqx, dqy, dqz, dqw};
${localBody}
}
// ${context.provenance(ROTATION, "createPlaneRotationGizmo", "onDrag quaternion update")}
void drag_rotate(Engine& engine, MeshHandle handle, Vec3d lastDragPoint, const Vec3d& hit, const Vec3d& normal) {
    auto& node = engine.meshes[handle.value];
    const auto wm = upstream::mesh_world_matrix(engine, node);
${translated}
}
`;
}
