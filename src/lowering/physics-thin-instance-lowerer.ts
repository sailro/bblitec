import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { lowerQuatFromRotationBasis } from "./pinned-mat4-decompose.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const modulePath = "src/physics/havok-thin-instances.ts";

/** Thin matrices and Havok handles use native storage; the pinned bodies own the arithmetic and loops. */
export function lowerPhysicsThinInstances(context: LoweringContext, floatingOrigin: boolean) {
    const calls = pinnedNumericMathCallsWithHypot();
    calls.set("_quatFromRotationBasis", args => `thin_quat_from_basis(${args.join(", ")})`);
    const quat = lowerQuatFromRotationBasis(context, calls, "thin_quat_from_basis", "std::array<double, 4>", false, false);
    const transform = lowerPinnedFunction(context, modulePath, "thinInstanceTransform", [
        { pinned: "matrices", cpp: "matrices", kind: "matrix", annotation: "Float32Array | Float64Array", cppType: "std::vector<float>" },
        { pinned: "index", cpp: "index", kind: "number" },
        { pinned: "transform", cpp: "transform", kind: "record", annotation: "NativeTransform", cppType: "pal::PhysicsTransform", mutableRecord: true },
        { pinned: "rotation", cpp: "rotation", kind: "record", annotation: "Quat", cppType: "std::array<double, 4>", mutableRecord: true },
    ], {
        cppName: "thin_instance_transform", calls,
        memberBindings: new Map<string, PinnedBinding>([
            ["transform[0]", { cpp: "transform.position", type: "f64-buffer" }],
            ["transform[1]", { cpp: "transform.rotation", type: "f64-buffer" }],
            ...["x", "y", "z", "w"].map((axis, i): [string, PinnedBinding] => [`rotation.${axis}`, { cpp: `rotation[${i}]`, type: "scalar" }]),
        ]),
        returns: { type: "pal::PhysicsTransform&", value: (_lowerer, expression) => {
            if (!expression) return context.contractError(context.functionDeclaration(modulePath, "thinInstanceTransform").declaration, "Expected transform identity.");
            context.assertExpressionShape(expression, "transform", "Thin transform result identity");
            return "transform";
        } },
    });
    const numericNames = ["off", "tx", "ty", "tz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"];
    const compose = lowerPinnedFunction(context, "src/math/compose-mat4-into-buffer.ts", "composeMat4IntoBuffer", [
        { pinned: "dst", cpp: "dst", kind: "mat4", cppType: "std::vector<float>", mutableRecord: true },
        ...numericNames.map(pinned => ({ pinned, cpp: pinned, kind: "number" as const })),
    ], { cppName: "thin_compose_matrix", returns: "void" });
    const { file, declaration } = context.functionDeclaration(modulePath, "createHavokThinInstanceContext");
    const result = context.returnObject(declaration);
    const method = (name: string): ts.MethodDeclaration => {
        const member = result.properties.find(p => p.name?.getText(file) === name);
        if (!member || !ts.isMethodDeclaration(member) || !member.body) return context.contractError(result, `Expected thin context method '${name}'.`);
        return member;
    };
    const binding = (cpp: string, type: PinnedBinding["type"] = "opaque"): PinnedBinding => ({ cpp, type });
    const stateBindings = (): Map<string, PinnedBinding> => new Map([
        ["body", binding("body")],
        ["body._hkBody", binding("body.handle")],
        ["body.node", binding("body.node")],
        ["body.node.position", binding("physics_node_pose(*world.engine, body.node).position", "vec3")],
        ["body.node.rotationQuaternion", binding("physics_node_pose(*world.engine, body.node).rotation")],
        ...["x", "y", "z", "w"].map((axis): [string, PinnedBinding] => [`body.node.rotationQuaternion.${axis}`, binding(`physics_node_pose(*world.engine, body.node).rotation.${axis}`, "scalar")]),
        ["state", { ...binding("state"), absentCpp: "state == nullptr" }],
        ["state[1]", binding("state->handles")],
        ["state[1].length", binding("static_cast<double>(state->handles.size())", "scalar")],
        ["state[3]", binding("state->transform")],
        ["state[4]", binding("state->rotation")],
        ["state[3][0]", binding("state->transform.position", "f64-buffer")],
        ["state[3][1]", binding("state->transform.rotation", "f64-buffer")],
        ["transform[0]", binding("state->transform.position", "f64-buffer")],
        ["transform[1]", binding("state->transform.rotation", "f64-buffer")],
        ["mesh", binding("body.node")],
        ["mesh.thinInstances!.matrices", binding("thin_matrices(world, body.node)", "f32")],
        ["(body.node as Mesh).thinInstances!.matrices", binding("thin_matrices(world, body.node)", "f32")],
        ["handles", binding("state->handles")],
        ["handles.length", binding("static_cast<double>(state->handles.size())", "scalar")],
        ["nativeTransform[0]", binding("nativeTransform.position", "f64-buffer")],
        ["nativeTransform[1]", binding("nativeTransform.rotation", "f64-buffer")],
    ]);
    const methodCalls = new Map(calls);
    methodCalls.set("thinInstanceTransform", args => `thin_instance_transform(${args.join(", ")})`);
    methodCalls.set("composeMat4IntoBuffer", args => `thin_compose_matrix(${args.join(", ")})`);
    methodCalls.set("flushThinInstances", args => `flush_thin_instances(*world.engine, MeshHandle{${args[0]}.value})`);
    methodCalls.set("raw.HP_Body_SetQTransform", args => `pal::physics_body_set_transform(${args.join(", ")})`);
    methodCalls.set("raw.HP_Body_SetTargetQTransform", args => `pal::physics_body_set_target_transform(${args.join(", ")})`);
    const sync = (name: "from" | "to" | "target"): string => {
        const member = method(name);
        const bindings = stateBindings();
        const body = lowerPinnedBody(file, member.body!.statements, {
            bindings, calls: methodCalls,
            statement(statement, lowerer, indent) {
                if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
                const local = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(local.name) || !local.initializer) return undefined;
                if (local.name.text === "state") {
                    context.assertExpressionShape(local.initializer, "states.get(body._hkBody)", "Thin state identity");
                    return [`${indent}auto* state = thin_state(world, body.handle);`];
                }
                if (local.name.text === "nativeTransform") {
                    context.assertExpressionShape(local.initializer, "raw.HP_Body_GetQTransform(handles[i])[1]", "Native transform read");
                    return [`${indent}const auto nativeTransform = pal::physics_body_get_transform(state->handles.at(static_cast<std::size_t>(${lowerer.expression(ts.factory.createIdentifier("i"))})));`];
                }
                return undefined;
            },
            expression(expression, lowerer) {
                if (ts.isElementAccessExpression(expression)) {
                    const owner = expression.expression.getText(file);
                    if (owner === "state[1]" || owner === "handles") return `state->handles.at(static_cast<std::size_t>(${lowerer.expression(expression.argumentExpression)}))`;
                }
                return undefined;
            },
            forOf: (iterated, element) => iterated === "state[1]" ? {
                range: "state->handles", bindings: new Map([[element, binding(element)]]),
            } : undefined,
            returnValue: (expression, lowerer) => expression ? lowerer.expression(expression) : "",
        });
        return `bool thin_${name}(PhysicsWorld& world, const PhysicsBody& body) {\n${body}\n}`;
    };
    const validate = context.variableInitializer(declaration, "validate");
    if (!ts.isArrowFunction(validate) || !ts.isBlock(validate.body)) return context.contractError(validate, "Expected thin validation body.");
    const validateBody = lowerPinnedBody(file, validate.body.statements, {
        bindings: new Map([
            ["node", binding("node")],
            ["(node as Mesh).thinInstances", { ...binding("thin_mesh(world, node)"), absentCpp: "thin_mesh(world, node) == nullptr" }],
            ["thin.count", binding("thin_mesh(world, node)->instance_count", "index")],
            ["world._fo", floatingOrigin ? { ...binding("world.fo"), absentCpp: "!world.fo" } : absentBinding()],
        ]), calls,
    });
    // The object/tuple allocation is a storage boundary. Its loop and every solver call are translated below.
    const create = method("create");
    const createBindings = new Map<string, PinnedBinding>([
        ["node", binding("node")], ["motionType", binding("motion_type", "scalar")], ["startsAsleep", binding("starts_asleep", "bool")],
        ["mesh.thinInstances", { ...binding("thin_mesh(world, node)"), absentCpp: "thin_mesh(world, node) == nullptr" }],
        ["thin.count", binding("thin_mesh(world, node)->instance_count", "index")],
        ["thin.matrices", binding("thin_matrices(world, node)", "f32")],
        ["handles.length", binding("static_cast<double>(state.handles.size())", "scalar")],
        ["handles", binding("state.handles")], ["transform", binding("state.transform")], ["rotation", binding("state.rotation")],
        ["handle", binding("native_handle")], ["hkMotion", binding("hk_motion")], ["hkWorld", binding("world.handle")],
        ["body", binding("state.body")],
        ...["STATIC", "ANIMATED"].map((name): [string, PinnedBinding] => [`PhysicsMotionType.${name}`, binding(`PhysicsMotionType::${name}`, "scalar")]),
        ...Object.entries({ STATIC: "immovable", KINEMATIC: "node_driven", DYNAMIC: "simulated" }).map(([name, cpp]): [string, PinnedBinding] => [`raw.MotionType.${name}`, binding(`pal::PhysicsMotionType::${cpp}`, "scalar")]),
    ]);
    const createCalls = new Map(methodCalls);
    createCalls.set("validate", args => `thin_validate(world, ${args.join(", ")})`);
    createCalls.set("raw.HP_Body_SetMotionType", args => `pal::physics_body_set_motion_type(${args.join(", ")})`);
    createCalls.set("raw.HP_World_AddBody", args => `pal::physics_world_add_body(${args.join(", ")})`);
    const createBody = lowerPinnedBody(file, create.body!.statements, {
        bindings: createBindings, calls: createCalls,
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const local = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(local.name) || !local.initializer) return undefined;
                const storage: Record<string, readonly [string, string]> = {
                    handles: ["new Array<any>(thin.count)", ""],
                    transform: ["[[0, 0, 0], [0, 0, 0, 1]]", "state.transform = {{0, 0, 0}, {0, 0, 0, 1}};"],
                    rotation: ["{ x: 0, y: 0, z: 0, w: 1 }", "state.rotation = {0, 0, 0, 1};"],
                    handle: ["raw.HP_Body_Create()[1]", "const auto native_handle = pal::physics_body_create();"],
                    body: ["{ _hkBody: handles[0], _shape: null, _preStep: false, _prestepType: PhysicsPrestepType.TELEPORT, _world: world, node, motionType }", "state.body = PhysicsBody{}; state.body.handle = state.handles.at(0); state.body.owner = owner; state.body.node = node; state.body.motion_type = motion_type;"],
                };
                const entry = storage[local.name.text];
                if (entry) {
                    context.assertExpressionShape(local.initializer, entry[0], "Thin native storage");
                    if (local.name.text === "handles") {
                        if (!ts.isNewExpression(local.initializer) || !local.initializer.arguments?.[0]) return context.contractError(local, "Expected thin handle allocation length.");
                        return [`${indent}ThinPhysicsState state{}; state.handles.resize(static_cast<std::size_t>(${lowerer.expression(local.initializer.arguments[0])}));`];
                    }
                    return [`${indent}${entry[1]}`];
                }
                if (local.name.text === "hkMotion") return [`${indent}const auto hk_motion = ${lowerer.expression(local.initializer)};`];
            }
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(file) === "states.set") {
                context.assertExpressionShape(statement.expression, "states.set(handles[0], [body, handles, new Array<any>(handles.length), transform, rotation])", "Thin state ownership");
                return [`${indent}const auto body = state.body;`, `${indent}world.thin_states.emplace(body.handle.value, std::move(state));`];
            }
            if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && ts.isElementAccessExpression(statement.expression.left) && statement.expression.left.expression.getText(file) === "handles") {
                const assignment = statement.expression;
                if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isElementAccessExpression(assignment.left)) return undefined;
                return [`${indent}state.handles.at(static_cast<std::size_t>(${lowerer.expression(assignment.left.argumentExpression)})) = ${lowerer.expression(assignment.right)};`];
            }
            return undefined;
        },
        returnValue: expression => {
            if (!expression || expression.kind === ts.SyntaxKind.Identifier && expression.getText(file) === "undefined") return "std::nullopt";
            context.assertExpressionShape(expression, "body", "Thin created body identity");
            return "body";
        },
    });
    const facadeLoop = declaration.body!.statements.find(ts.isForOfStatement);
    if (!facadeLoop || !ts.isBlock(facadeLoop.statement)) return context.contractError(declaration, "Expected the thin facade setter table.");
    context.assertExpressionShape(facadeLoop.expression, '["HP_Body_SetShape", "HP_Body_SetMassProperties", "HP_Body_ApplyImpulse", "HP_Body_SetLinearVelocity", "HP_Body_SetAngularVelocity", "HP_Body_SetMotionType", "HP_Body_SetTargetQTransform", "HP_Body_SetEventMask"]', "Thin facade setters");
    const assignment = facadeLoop.statement.statements[0];
    if (!assignment || !ts.isExpressionStatement(assignment) || !ts.isBinaryExpression(assignment.expression) || !ts.isArrowFunction(assignment.expression.right) || !ts.isBlock(assignment.expression.right.body)) return context.contractError(facadeLoop, "Expected thin facade setter body.");
    const fanout = lowerPinnedBody(file, assignment.expression.right.body.statements, {
        bindings: new Map([["state", { ...binding("state"), absentCpp: "state == nullptr" }]]), calls,
        statement(statement, _lowerer, indent) {
            if (ts.isVariableStatement(statement)) {
                const local = statement.declarationList.declarations[0];
                if (local?.name.getText(file) === "state") {
                    context.assertExpressionShape(local.initializer!, "states.get(handle)", "Thin facade identity");
                    return [`${indent}auto* state = thin_state(world, handle);`];
                }
                context.assertStatementShapes(statement, [statement], "let result;", "Unused native status carrier");
                return [];
            }
            if (ts.isExpressionStatement(statement)) {
                context.assertExpressionShape(statement.expression, "result = raw[name](nativeHandle, ...args)", "Thin facade operation");
                return [`${indent}operation(nativeHandle);`];
            }
            return undefined;
        },
        forOf: (iterated, element) => iterated === "state[1]" ? { range: "state->handles", bindings: new Map([[element, binding(element)]]) } : undefined,
        returnValue(expression) {
            if (!expression) return context.contractError(assignment, "Expected native status return.");
            if (context.expressionMatchesShape(expression, "raw[name](handle, ...args)")) return "operation(handle)";
            context.assertExpressionShape(expression, "result", "Thin facade status result");
            return "";
        },
    });
    const resolve = method("resolve");
    const resolveBody = lowerPinnedBody(file, resolve.body!.statements, {
        bindings: new Map([
            ["nativeId", binding("native_id", "scalar")],
            ["state[1].length", binding("static_cast<double>(state.handles.size())", "scalar")],
            ["handle[0]", binding("handle.value", "scalar")],
        ]), calls: new Map([...calls, ["Number", args => args[0]!]]),
        forOf: (iterated, element) => iterated === "states.values()" ? {
            range: "world.thin_states | std::views::values", bindings: new Map([[element, binding(element)]]),
        } : undefined,
        statement(statement, lowerer, indent) {
            if (ts.isVariableStatement(statement)) {
                const local = statement.declarationList.declarations[0]!;
                if (local.name.getText(file) === "handle") {
                    context.assertExpressionShape(local.initializer!, "state[1][i]!", "Thin native handle identity");
                    return [`${indent}const auto handle = state.handles.at(static_cast<std::size_t>(${lowerer.expression(ts.factory.createIdentifier("i"))}));`];
                }
            }
            return undefined;
        },
        returnValue(expression, lowerer) {
            if (expression?.kind === ts.SyntaxKind.NullKeyword) return "std::nullopt";
            if (!expression) return context.contractError(resolve, "Thin resolution requires a result.");
            context.assertExpressionShape(expression, "[state[0], (state[2][i] ??= [handle[0]]), i]", "Thin resolution identity and index");
            return `PhysicsBodyInstance{state.body, handle, static_cast<double>(${lowerer.expression(ts.factory.createIdentifier("i"))})}`;
        },
    });
    const kinematics = (name: "com" | "matrix") => {
        const member = method(name);
        const body = lowerPinnedBody(file, member.body!.statements, {
            bindings: new Map([
                ["body", binding("body")], ["body._hkBody", binding("body.handle")],
                ["nativeBody", binding("native_body")], ["localCenter", binding("local_center", "f64-buffer")],
                ["transform[0]", binding("transform.position", "f64-buffer")],
                ["transform[1]", binding("transform.rotation", "f64-buffer")],
            ]),
            calls: new Map([...calls, ["states.has", args => `(thin_state(world, ${args[0]}) != nullptr)`],
                ["composeMat4", args => `thin_compose_value(${args.join(", ")})`]]),
            statement(statement, _lowerer, indent) {
                if (!ts.isVariableStatement(statement)) return undefined;
                const local = statement.declarationList.declarations[0]!;
                if (local.name.getText(file) !== "transform") return undefined;
                context.assertExpressionShape(local.initializer!, "raw.HP_Body_GetQTransform(nativeBody)[1]", "Thin kinematic transform transport");
                return [`${indent}const auto transform = pal::physics_body_get_transform(native_body);`];
            },
            returnValue(expression, lowerer) {
                if (!expression || ts.isIdentifier(expression) && expression.text === "undefined") return "std::nullopt";
                if (name === "com") {
                    if (!ts.isObjectLiteralExpression(expression)) return context.contractError(expression, "Thin center must be a vector record.");
                    return `Vec3d{${["x", "y", "z"].map(axis => lowerer.expression(context.propertyInitializer(expression, axis))).join(", ")}}`;
                }
                return lowerer.expression(expression);
            },
        });
        return `std::optional<${name === "com" ? "Vec3d" : "std::vector<float>"}> thin_${name}(PhysicsWorld& world, const PhysicsBody& body, pal::PhysicsBodyHandle native_body${name === "com" ? ", const std::array<double, 3>& local_center" : ""}) {\n${body}\n}`;
    };
    const composeValue = lowerPinnedFunction(context, "src/math/compose-mat4.ts", "composeMat4", numericNames.slice(1).map(pinned => ({ pinned, cpp: pinned, kind: "number" as const })), {
        cppName: "thin_compose_value", returns: { type: "std::vector<float>", value: () => "out" },
        localStorage: [{ pinned: "out", initializer: "allocateMat4()", binding: { cpp: "out", type: "f32" }, declaration: "std::vector<float> out(16);" }],
        calls: new Map([["composeMat4IntoBuffer", args => `thin_compose_matrix(${args.join(", ")})`]]),
    });
    return {
        state: `struct ThinPhysicsState { PhysicsBody body; std::vector<pal::PhysicsBodyHandle> handles; pal::PhysicsTransform transform; std::array<double, 4> rotation; };`,
        helpers: `${quat}\n${transform}\n${compose}
MeshRecord* thin_mesh(PhysicsWorld& world, PhysicsNodeRef node) {
    if (node.kind != PhysicsNodeKind::mesh) return nullptr;
    auto& mesh = world.engine->meshes.at(node.value);
    return mesh.thin_instanced ? &mesh : nullptr;
}
std::vector<float>& thin_matrices(PhysicsWorld& world, PhysicsNodeRef node) {
    auto* mesh = thin_mesh(world, node);
    if (!mesh || !mesh->instance_source) throw std::runtime_error("Thin-instance matrix storage is absent.");
    return *mesh->instance_source;
}
ThinPhysicsState* thin_state(PhysicsWorld& world, pal::PhysicsBodyHandle handle) {
    const auto found = world.thin_states.find(handle.value);
    return found == world.thin_states.end() ? nullptr : &found->second;
}
template <typename Operation>
void thin_for_each(PhysicsWorld& world, pal::PhysicsBodyHandle handle, Operation operation) {
${fanout}
}
void thin_validate(PhysicsWorld& world, PhysicsNodeRef node) {
${validateBody}
}
std::optional<PhysicsBody> thin_create(PhysicsWorld& world, const std::weak_ptr<PhysicsWorld>& owner, PhysicsNodeRef node, PhysicsMotionType motion_type, bool starts_asleep) {
${createBody}
}
${sync("from")}
${sync("to")}
${sync("target")}
std::optional<PhysicsBodyInstance> thin_resolve(PhysicsWorld& world, double native_id) {
${resolveBody}
}
${composeValue}
${kinematics("com")}
${kinematics("matrix")}`,
    };
}
