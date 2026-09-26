import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedCallSpelling,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { lowerObjectComponents } from "./pinned-function-lowerer.js";
import { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";

/** Public controls share the raw native-module transport and retain their source bodies. */
export function lowerPhysicsBodyControls(context: LoweringContext): string {
    const module = "src/physics/havok.ts";
    const bindings = new Map<string, PinnedBinding>([
        ["body._hkBody", { cpp: "physics_native_body(body)", type: "opaque" }],
        ["shape._hkShape", { cpp: "shape.handle", type: "opaque" }],
    ]);
    for (const record of ["velocity", "position", "rotation"])
        for (const lane of record === "rotation"
            ? ["x", "y", "z", "w"]
            : ["x", "y", "z"])
            bindings.set(`${record}.${lane}`, {
                cpp: `${record}.${lane}`,
                type: "scalar",
            });
    const calls = new Map<string, PinnedCallSpelling>([
        [
            "world._hknp.HP_Body_SetLinearVelocity",
            (args) =>
                `static_cast<void>(physics_native_set_linear_velocity(${args.join(", ")}))`,
        ],
        [
            "world._hknp.HP_Body_SetAngularVelocity",
            (args) =>
                `static_cast<void>(physics_native_set_angular_velocity(${args.join(", ")}))`,
        ],
        [
            "world._hknp.HP_Body_SetQTransform",
            (args) =>
                `static_cast<void>(physics_native_set_transform(${args.join(", ")}))`,
        ],
        [
            "world._hknp.HP_Shape_Release",
            (args) => `pal::physics_shape_release(${args.join(", ")})`,
        ],
        [
            "body.node.position.set",
            (args) =>
                `physics_mutate_node(world, body, [&](auto& record) { record.position = Vec3d{${args.join(", ")}}; })`,
        ],
        [
            "body.node.rotationQuaternion.set",
            (args) =>
                `physics_mutate_node(world, body, [&](auto& record) { record.rotation_quaternion = Vec4{${args.map((arg) => `static_cast<float>(${arg})`).join(", ")}}; record.has_rotation_quaternion = true; })`,
        ],
    ]);
    const lower = (name: string) => {
        const { file, declaration } = context.functionDeclaration(module, name);
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings,
            calls,
            expression(node, numeric) {
                if (
                    context.expressionMatchesShape(
                        node,
                        "world._thin?.count(body) !== undefined",
                    )
                )
                    return "physics_thin_count(world, body).has_value()";
                if (ts.isArrayLiteralExpression(node))
                    return `${node.elements.some(ts.isArrayLiteralExpression) ? "PhysicsNativeTransform" : "js::Array<double>"}{${node.elements.map((element) => numeric.expression(element)).join(", ")}}`;
                return undefined;
            },
        });
    };
    const getter = (kind: "Linear" | "Angular") => {
        const name = `getPhysicsBody${kind}Velocity`;
        const { file, declaration } = context.functionDeclaration(module, name);
        context.assertStatementInventory(
            declaration,
            declaration.body!.statements,
            name,
            "native velocity result projection",
            ["variable statement", "return statement"],
        );
        const initializer = context.variableInitializer(declaration, "v");
        context.assertExpressionShape(
            initializer,
            `world._hknp.HP_Body_Get${kind}Velocity(body._hkBody)[1]`,
            "Native velocity result",
        );
        const numeric = new PinnedNumericLowerer(file, {
            bindings: new Map([["v", { cpp: "velocity", type: "f64-list" }]]),
            calls: new Map(),
        });
        return `// ${context.provenance(module, name)}
Vec3d get_physics_body_${kind.toLowerCase()}_velocity(PhysicsWorldHandle handle, PhysicsBody body) {
    const auto& live = physics_body_record(physics_world_record(handle), body);
    const auto velocity = pal::physics_body_get_${kind.toLowerCase()}_velocity(live.handle);
    return Vec3d{${lowerObjectComponents(context, numeric, context.returnObject(declaration), ["x", "y", "z"]).join(", ")}};
}`;
    };
    return `template<class Operation>
void physics_mutate_node(PhysicsWorldHandle world, PhysicsBody body, Operation operation) {
    auto& engine = *physics_world_record(world).engine;
    std::visit([&](const auto& node) {
        if constexpr(std::is_same_v<std::decay_t<decltype(node)>, MeshHandle>) {
            operation(${recordAt("engine.meshes", "node")}); mark_mesh_dirty(engine, node);
        } else {
            operation(${recordAt("engine.transform_nodes", "node")}); mark_transform_node_dirty(engine, node);
        }
    }, body.node);
}
// ${context.provenance(module, "setPhysicsBodyLinearVelocity")} / setPhysicsBodyAngularVelocity
void set_physics_body_velocity([[maybe_unused]] PhysicsWorldHandle world, PhysicsBody body, Vec3d velocity, bool angular) {
    if(angular) {
${lower("setPhysicsBodyAngularVelocity")}
    } else {
${lower("setPhysicsBodyLinearVelocity")}
    }
}
// ${context.provenance(module, "setPhysicsBodyTransform")}
void set_physics_body_transform(PhysicsWorldHandle world, PhysicsBody body, Vec3d position, Vec4d rotation) {
${lower("setPhysicsBodyTransform")}
}
// ${context.provenance(module, "releasePhysicsShape")}
void release_physics_shape([[maybe_unused]] PhysicsWorldHandle world, PhysicsShape shape) {
${lower("releasePhysicsShape")}
}
${getter("Linear")}
${getter("Angular")}
`;
}
