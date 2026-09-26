import type ts from "typescript";
import type { DataType } from "./data-types.js";
import type { HandleKind } from "./data-types/model.js";
import type { LoweringServices } from "./lowering-services.js";
import type { PropertyContext } from "./properties.js";
import { argumentAt } from "./syntax.js";
import { valueForKind, type Value } from "./types.js";

interface PhysicsCallContext
    extends
        PropertyContext,
        Pick<
            LoweringServices,
            | "compileValue"
            | "compileNumber"
            | "expectKind"
            | "expectArgumentCount"
            | "bindings"
            | "dataLowerer"
            | "dataTypes"
            | "captureEmittedLines"
        > {}

const numbers: DataType = { kind: "vector", element: { kind: "number" } };
const transform: DataType = { kind: "product", elements: [numbers, numbers] };
const nativeBody: DataType = { kind: "handle", handle: "physics-native-body" };

function handle(kind: HandleKind, cpp: string, owner: Value): Value {
    return valueForKind(kind, {
        cpp,
        dataType: { kind: "handle", handle: kind },
        ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
    });
}

/** Private Lite records remain typed transports across the solver boundary. */
export function readPhysicsProperty(
    context: PropertyContext,
    owner: Value,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const property = expression.name.text;
    if (owner.kind === "physics-body") {
        if (property === "_world")
            return handle(
                "physics-world",
                `bbl::upstream::physics_body_world(${owner.cpp})`,
                owner,
            );
        if (property === "_hkBody")
            return handle(
                "physics-native-body",
                `bbl::upstream::physics_native_body(${owner.cpp})`,
                owner,
            );
        if (property === "node")
            return {
                ...handle(
                "scene-node",
                `bbl::upstream::physics_body_node(${owner.cpp})`,
                owner,
                ),
                engineCpp:
                    owner.engineCpp ??
                    `(*bbl::upstream::physics_world_state(bbl::upstream::physics_body_world(${owner.cpp})).engine)`,
            };
    }
    if (owner.kind === "physics-world") {
        if (property === "_bodies")
            return handle("physics-body-list", owner.cpp, owner);
        if (property === "_hknp")
            return handle("physics-module", owner.cpp, owner);
        if (property === "_thin") {
            context.reachFeature("physics:thin-instances", expression);
            return {
                kind: "data",
                cpp: `([&]() -> bbl::js::Nullable<bbl::upstream::PhysicsWorldHandle> { const auto world = ${owner.cpp}; if (bbl::upstream::physics_world_state(world).thin_enabled) return world; return std::nullopt; }())`,
                dataType: {
                    kind: "optional",
                    undefinedOnly: true,
                    inner: { kind: "handle", handle: "physics-thin-context" },
                },
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
    }
    if (owner.kind === "physics-module" && property === "ActivationState") {
        // Havok's external enum is part of this platform transport's ABI.
        return {
            kind: "record",
            cpp: "",
            recordProperties: {
                ACTIVE: { kind: "number", cpp: "0.0", staticNumber: 0 },
                INACTIVE: { kind: "number", cpp: "1.0", staticNumber: 1 },
            },
        };
    }
    if (owner.kind === "physics-body-list" && property === "length")
        return {
            kind: "number",
            cpp: `static_cast<double>(bbl::upstream::physics_world_state(${owner.cpp}).bodies.size())`,
        };
    if (owner.kind === "scene-node" && property === "name") {
        const engine = context.requireEngine(owner, expression);
        return {
            kind: "string",
            dataType: { kind: "string" },
            cpp: `std::visit([&](const auto& node) -> std::string { using T = std::decay_t<decltype(node)>; if constexpr (std::is_same_v<T, bbl::MeshHandle>) return ${engine}.meshes.at(node.value).scene_node_name; else if constexpr (std::is_same_v<T, bbl::TransformNodeHandle>) return ${engine}.transform_nodes.at(node.value).name; else return ${engine}.transform_nodes.at(${engine}.assets.at(node.value).root_node.value).name; }, ${owner.cpp})`,
        };
    }
}

const rawCalls = new Map<
    string,
    { name: string; args: readonly DataType[]; result?: DataType }
>([
    [
        "HP_Body_GetQTransform",
        {
            name: "physics_native_get_transform",
            args: [],
            result: {
                kind: "product",
                elements: [{ kind: "number" }, transform],
            },
        },
    ],
    [
        "HP_Body_GetLinearVelocity",
        {
            name: "physics_native_get_linear_velocity",
            args: [],
            result: {
                kind: "product",
                elements: [{ kind: "number" }, numbers],
            },
        },
    ],
    [
        "HP_Body_SetQTransform",
        { name: "physics_native_set_transform", args: [transform] },
    ],
    [
        "HP_Body_SetLinearVelocity",
        { name: "physics_native_set_linear_velocity", args: [numbers] },
    ],
    [
        "HP_Body_SetAngularVelocity",
        { name: "physics_native_set_angular_velocity", args: [numbers] },
    ],
    [
        "HP_Body_ApplyImpulse",
        { name: "physics_native_apply_impulse", args: [numbers, numbers] },
    ],
]);

/** Called transactionally: ordinary arrays and local methods keep their dispatch. */
export function compilePhysicsMethodCall(
    context: PhysicsCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
): Value | undefined {
    const method = callee.name.text;
    if (
        !rawCalls.has(method) &&
        ![
            "HP_Body_SetActivationState",
            "count",
            "instance",
            "includes",
        ].includes(method)
    )
        return;
    const value = context.compileValue(callee.expression);
    const kind =
        value.dataType?.kind === "optional" &&
        value.dataType.inner.kind === "handle"
            ? value.dataType.inner.handle
            : value.kind;
    if (
        ![
            "physics-module",
            "physics-thin-context",
            "physics-body-list",
        ].includes(kind)
    )
        return;
    const receiver = context.bindings.pinValueToTemporary(
        value,
        "physics_receiver",
        callee.expression,
    );
    if (callee.questionDotToken && receiver.dataType?.kind === "optional") {
        const narrowed = context.dataLowerer.narrowOptional(
            receiver,
            callee.expression,
            true,
        );
        let result: Value | undefined;
        const lines = context.captureEmittedLines(() => {
            result = compileReceiverCall(context, call, callee, narrowed);
        });
        if (!result) return;
        const type = result.dataType;
        if (type?.kind !== "optional")
            context.fail(
                call,
                "Optional physics calls require an optional result.",
            );
        return {
            ...result,
            cpp: `([&]() -> ${context.dataTypes.cppType(type)} { if (!(${receiver.cpp}).has_value()) return std::nullopt; ${lines.join("\n")} return ${result.cpp}; }())`,
        };
    }
    return compileReceiverCall(
        context,
        call,
        callee,
        context.dataLowerer.narrowOptional(receiver, callee.expression),
    );
}

function compileReceiverCall(
    context: PhysicsCallContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    receiver: Value,
): Value | undefined {
    const method = callee.name.text;
    context.reachJsData();
    if (receiver.kind === "physics-body-list" && method === "includes") {
        context.expectArgumentCount(call, 1, 1);
        const body = context.dataLowerer.compileForSink(argumentAt(call, 0), {
            kind: "handle",
            handle: "physics-body",
        });
        return {
            kind: "boolean",
            cpp: `(bbl::js::array_index_of(bbl::upstream::physics_world_state(${receiver.cpp}).bodies, ${body}) >= 0.0)`,
        };
    }
    if (
        receiver.kind === "physics-thin-context" &&
        (method === "count" || method === "instance")
    ) {
        context.expectArgumentCount(
            call,
            method === "count" ? 1 : 2,
            method === "count" ? 1 : 2,
        );
        const bodyType: DataType = {
            kind: "handle",
            handle: "physics-body",
        };
        const bodyExpression = argumentAt(call, 0);
        const body = context.bindings.pinValueToTemporary(
            context.dataLowerer.leafValue(
                context.dataLowerer.compileForSink(bodyExpression, bodyType),
                bodyType,
            ),
            "physics_body_argument",
            bodyExpression,
        ).cpp;
        const index =
            method === "instance"
                ? `, ${context.compileNumber(argumentAt(call, 1), "double")}`
                : "";
        const type: DataType = {
            kind: "optional",
            undefinedOnly: true,
            inner: method === "count" ? { kind: "number" } : nativeBody,
        };
        const cppType = context.dataTypes.cppType(type);
        return {
            kind: "data",
            cpp: `([](const auto& value) -> ${cppType} { return value ? ${cppType}{*value} : ${cppType}{}; })(bbl::upstream::physics_thin_${method}(${receiver.cpp}, ${body}${index}))`,
            dataType: type,
        };
    }
    if (receiver.kind !== "physics-module") return;
    const descriptor = rawCalls.get(method);
    if (!descriptor && method !== "HP_Body_SetActivationState") return;
    const count = descriptor ? descriptor.args.length + 1 : 2;
    context.expectArgumentCount(call, count, count);
    const bodyExpression = argumentAt(call, 0);
    const body = context.dataLowerer.narrowOptional(
        context.compileValue(bodyExpression),
        bodyExpression,
        true,
    );
    context.expectKind(body, "physics-native-body", bodyExpression);
    const savedBody = context.bindings.pinValueToTemporary(
        body,
        "physics_native_body",
        bodyExpression,
    );
    if (method === "HP_Body_SetActivationState")
        return {
            kind: "number",
            cpp: `bbl::upstream::physics_native_set_active(${savedBody.cpp}, (${context.compileNumber(argumentAt(call, 1), "double")}) == 0.0)`,
            dataType: { kind: "number" },
        };
    const args = descriptor!.args.map((type, index) => {
        const expression = argumentAt(call, index + 1);
        if (type === transform) {
            const value = context.compileValue(expression);
            if (
                value.dataType?.kind === "vector" &&
                value.dataType.element.kind === "vector" &&
                value.dataType.element.element.kind === "number"
            ) {
                const saved = context.bindings.pinValueToTemporary(
                    value,
                    "physics_transform",
                    expression,
                );
                return `bbl::upstream::PhysicsNativeTransform{${saved.cpp}.at(0), ${saved.cpp}.at(1)}`;
            }
            const cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                type,
                expression,
            );
            return context.bindings.pinValueToTemporary(
                context.dataLowerer.leafValue(cpp, type),
                "physics_argument",
                expression,
            ).cpp;
        }
        const cpp = context.dataLowerer.compileForSink(expression, type);
        return context.bindings.pinValueToTemporary(
            context.dataLowerer.leafValue(cpp, type),
            "physics_argument",
            expression,
        ).cpp;
    });
    const result = descriptor!.result ?? ({ kind: "number" } as const);
    return context.dataLowerer.leafValue(
        `bbl::upstream::${descriptor!.name}(${[savedBody.cpp, ...args].join(", ")})`,
        result,
    );
}
