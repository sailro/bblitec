import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const modulePath = "src/physics/havok-events.ts";

/** The pinned event context owns deferred release and body resolution. */
export function lowerPhysicsEvents(
    context: LoweringContext,
    thin: boolean,
): string {
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "ensureHavokEventContext",
    );
    const initializer = context.variableInitializer(declaration, "context");
    if (!ts.isObjectLiteralExpression(initializer))
        return context.contractError(
            initializer,
            "Expected the Havok event context record.",
        );
    const binding = (
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
    ): PinnedBinding => ({ cpp, type });
    const bindings = new Map<string, PinnedBinding>([
        ["draining", binding("events.draining", "bool")],
        [
            "removed",
            { ...binding("events.removed"), absentCpp: "!events.removed" },
        ],
        ["deferred", { ...binding("deferred"), absentCpp: "!deferred" }],
        ["nativeId", binding("native_id", "scalar")],
        ["body", binding("body")],
        ["body._hkBody", binding("body.handle")],
        ["body._hkBody[0]", binding("body.handle.value", "scalar")],
        ["handle", { ...binding("handle"), absentCpp: "handle.value == 0" }],
        ["handle[0]", binding("handle.value", "scalar")],
        ["count", { ...binding("(*count)", "scalar"), absentCpp: "!count" }],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        ["Number", (args) => args[0]!],
        ["callback", (args) => `callback(${args.join(", ")})`],
        [
            "drop",
            (args) => `physics_events_drop(world, events, ${args.join(", ")})`,
        ],
        [
            "releaseRemoved",
            () => "physics_events_release_removed(world, events)",
        ],
        [
            "world._hknp.HP_Body_Release",
            (args) => `physics_release_native_body(world, ${args.join(", ")})`,
        ],
        ["bodiesByNativeId.clear", () => "events.bodies_by_native_id.clear()"],
    ]);
    const lowerStatements = (statements: readonly ts.Statement[]) =>
        lowerPinnedBody(file, statements, {
            bindings,
            calls,
            statement(statement, numeric, indent) {
                if (ts.isVariableStatement(statement)) {
                    const local = statement.declarationList.declarations[0]!;
                    if (local.name.getText(file) === "deferred") {
                        context.assertExpressionShape(
                            local.initializer!,
                            "removed",
                            "Deferred event body snapshot",
                        );
                        return [
                            `${indent}const auto deferred = std::move(events.removed);`,
                        ];
                    }
                    if (local.name.getText(file) === "count") {
                        context.assertExpressionShape(
                            local.initializer!,
                            "world._thin?.count(body)",
                            "Event instance count",
                        );
                        return [
                            `${indent}const std::optional<double> count = ${thin ? "thin_state(world, body.handle) ? std::optional<double>{static_cast<double>(thin_state(world, body.handle)->handles.size())} : std::nullopt" : "std::nullopt"};`,
                        ];
                    }
                    if (local.name.getText(file) === "handle") {
                        context.assertExpressionShape(
                            local.initializer!,
                            "world._thin!.instance(body, index)",
                            "Event instance identity",
                        );
                        return [
                            `${indent}const auto handle = ${thin ? `thin_state(world, body.handle)->handles.at(static_cast<std::size_t>(${numeric.expression(context.findNodes(local.initializer!, ts.isIdentifier).find((node) => node.text === "index")!)}))` : "pal::PhysicsBodyHandle{}"};`,
                        ];
                    }
                }
                if (ts.isExpressionStatement(statement)) {
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "removed = undefined",
                        )
                    )
                        return [`${indent}events.removed.reset();`];
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "(removed ??= []).push(body)",
                        )
                    )
                        return [
                            `${indent}(events.removed ? *events.removed : events.removed.emplace()).push_back(body);`,
                        ];
                }
                return undefined;
            },
            expression(expression, numeric) {
                if (ts.isArrayLiteralExpression(expression)) {
                    if (
                        context.expressionMatchesShape(
                            expression,
                            "[body, body._hkBody, 0]",
                        )
                    )
                        return "PhysicsBodyInstance{body, body.handle, 0}";
                    if (
                        context.expressionMatchesShape(
                            expression,
                            "[body, handle, index]",
                        )
                    )
                        return `PhysicsBodyInstance{body, handle, static_cast<double>(${numeric.expression(expression.elements[2]!)})}`;
                }
                if (
                    context.expressionMatchesShape(
                        expression,
                        "bodiesByNativeId.get(Number(nativeId)) ?? null",
                    )
                )
                    return "physics_event_lookup(events, native_id)";
                return undefined;
            },
            forOf(iterated, element) {
                return iterated === "deferred"
                    ? {
                          range: "*deferred",
                          bindings: new Map([[element, binding(element)]]),
                      }
                    : undefined;
            },
            returnValue: (expression, numeric) =>
                expression ? numeric.expression(expression) : "",
        });
    const closure = (name: string) => {
        const value = context.variableInitializer(declaration, name);
        if (!ts.isArrowFunction(value) || !ts.isBlock(value.body))
            return context.contractError(
                value,
                `Expected event helper ${name}.`,
            );
        return value.body.statements;
    };
    const methods = (name: string) => {
        const method = initializer.properties.find(
            (member) => member.name?.getText(file) === name,
        );
        if (!method || !ts.isMethodDeclaration(method) || !method.body)
            return context.contractError(
                initializer,
                `Expected event context method ${name}.`,
            );
        return method.body.statements;
    };
    // The two callbacks adapt Map storage; their iteration remains the pinned helper's.
    context.assertStatementShapes(
        declaration,
        closure("add"),
        `forEachInstance(body, (nativeId, resolved) => bodiesByNativeId.set(nativeId, resolved));`,
        "Event map insertion",
    );
    context.assertStatementShapes(
        declaration,
        closure("drop"),
        `forEachInstance(body, (nativeId) => { if (bodiesByNativeId.get(nativeId)?.[0] === body) { bodiesByNativeId.delete(nativeId); } });`,
        "Event map identity-checked removal",
    );
    return `
std::optional<PhysicsBodyInstance> physics_event_lookup(const PhysicsEventState& events, double native_id) {
    const auto found = events.bodies_by_native_id.find(static_cast<std::uint32_t>(native_id));
    return found == events.bodies_by_native_id.end() ? std::nullopt : std::optional<PhysicsBodyInstance>{found->second};
}
template <typename Callback>
void physics_events_for_each([[maybe_unused]] PhysicsWorld& world, const PhysicsBody& body, Callback callback) {
${lowerStatements(closure("forEachInstance"))}
}
void physics_events_add(PhysicsWorld& world, PhysicsEventState& events, const PhysicsBody& body) {
    physics_events_for_each(world, body, [&](auto native_id, const PhysicsBodyInstance& resolved) {
        events.bodies_by_native_id.insert_or_assign(static_cast<std::uint32_t>(native_id), resolved);
    });
}
void physics_events_drop(PhysicsWorld& world, PhysicsEventState& events, const PhysicsBody& body) {
    physics_events_for_each(world, body, [&](auto native_id, const PhysicsBodyInstance&) {
        const auto found = events.bodies_by_native_id.find(static_cast<std::uint32_t>(native_id));
        if (found != events.bodies_by_native_id.end() && found->second.body.handle.value == body.handle.value) events.bodies_by_native_id.erase(found);
    });
}
void physics_events_release_removed(PhysicsWorld& world, PhysicsEventState& events) {
${lowerStatements(closure("releaseRemoved"))}
}
${[
    ["begin", "void", ""],
    ["end", "void", ""],
    ["remove", "bool", ", const PhysicsBody& body"],
    ["resolve", "std::optional<PhysicsBodyInstance>", ", double native_id"],
    ["dispose", "void", ""],
]
    .map(
        ([name, result, parameters]) =>
            `${result} physics_events_${name}([[maybe_unused]] PhysicsWorld& world, PhysicsEventState& events${parameters}) {\n${lowerStatements(methods(name!))}\n}`,
    )
    .join("\n")}
void ensure_physics_events(PhysicsWorld& world) {
    if (world.events) return;
    world.events.emplace();
    for (const auto& body : world.bodies) physics_events_add(world, *world.events, body);
}`;
}

/** Snapshot and finally semantics from the pinned after-step block. */
export function lowerPhysicsAfterStep(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/physics/havok.ts",
        "_stepWorld",
    );
    const statement = declaration.body?.statements.find(
        (node) =>
            ts.isIfStatement(node) &&
            context.expressionMatchesShape(node.expression, "world._afterStep"),
    );
    if (!statement)
        return context.contractError(
            declaration,
            "Expected the after-step dispatch block.",
        );
    const body = lowerPinnedBody(file, [statement], {
        bindings: new Map<string, PinnedBinding>([
            [
                "world._afterStep",
                {
                    cpp: "world.after_step",
                    type: "opaque",
                    absentCpp: "world.after_step.empty()",
                },
            ],
            [
                "cbs.length",
                {
                    cpp: "static_cast<double>(callbacks.size())",
                    type: "scalar",
                },
            ],
            ["dt", { cpp: "dt", type: "scalar" }],
            ["world._disposed", { cpp: "world.disposed", type: "bool" }],
        ]),
        calls: new Map(),
        statement(node, _lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const local = node.declarationList.declarations[0];
                if (local?.name.getText(file) === "cbs") {
                    context.assertExpressionShape(
                        local.initializer!,
                        "world._afterStep.slice()",
                        "After-step callback snapshot",
                    );
                    return [
                        `${indent}const auto callbacks = world.after_step;`,
                    ];
                }
                if (local?.name.getText(file) === "events") {
                    context.assertExpressionShape(
                        local.initializer!,
                        "world._events",
                        "After-step event context snapshot",
                    );
                    return [
                        `${indent}auto* const events = world.events ? &*world.events : nullptr;`,
                    ];
                }
            }
            if (ts.isExpressionStatement(node)) {
                for (const operation of ["begin", "end"]) {
                    if (
                        context.expressionMatchesShape(
                            node.expression,
                            `events?.${operation}()`,
                        )
                    ) {
                        return [
                            `${indent}if (events) physics_events_${operation}(world, *events);`,
                        ];
                    }
                }
            }
            return undefined;
        },
        expression(expression, lowerer) {
            if (ts.isCallExpression(expression)) {
                const callee = context.unwrapExpression(expression.expression);
                if (
                    ts.isElementAccessExpression(callee) &&
                    callee.expression.getText(file) === "cbs"
                ) {
                    return `callbacks.at(static_cast<std::size_t>(${lowerer.expression(callee.argumentExpression)}))(static_cast<float>(${lowerer.expression(expression.arguments[0]!)}))`;
                }
            }
            return undefined;
        },
    });
    return `void physics_dispatch_after_step(PhysicsWorld& world, double dt) {\n${body}\n}`;
}

/** Decode the PAL contact record; the source owns event fields and separation arithmetic. */
export function lowerPhysicsCollisionInfo(context: LoweringContext): {
    guard: string;
    fields: string;
    dispatchBody: string;
} {
    const { file, declaration } = context.functionDeclaration(
        "src/physics/havok-collision.ts",
        "onPhysicsCollision",
    );
    const info = context.variableInitializer(declaration, "info");
    if (!ts.isObjectLiteralExpression(info))
        return context.contractError(
            info,
            "Expected the collision event record.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["bodyA", { cpp: "body_a", type: "opaque", absentCpp: "!body_a" }],
        ["bodyB", { cpp: "body_b", type: "opaque", absentCpp: "!body_b" }],
        ["bodyA[0]", { cpp: "body_a->body", type: "opaque" }],
        ["bodyB[0]", { cpp: "body_b->body", type: "opaque" }],
        ["bodyA[2]", { cpp: "body_a->index", type: "scalar" }],
        ["bodyB[2]", { cpp: "body_b->index", type: "scalar" }],
        ["pointA", { cpp: "point_a", type: "vec3" }],
        ["pointB", { cpp: "point_b", type: "vec3" }],
        ["normal", { cpp: "normal", type: "vec3" }],
        ["type", { cpp: "event.type", type: "opaque" }],
        [
            "startedValue",
            { cpp: "pal::PhysicsCollisionEventType::started", type: "opaque" },
        ],
        [
            "continuedValue",
            {
                cpp: "pal::PhysicsCollisionEventType::continued",
                type: "opaque",
            },
        ],
        ["floatBuf[offB + 13 + 3]", { cpp: "event.impulse", type: "scalar" }],
    ]);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),

        expression(expression) {
            if (
                ts.isStringLiteral(expression) &&
                ["STARTED", "CONTINUED", "FINISHED"].includes(expression.text)
            )
                return `PhysicsCollisionType::${expression.text}`;
            return undefined;
        },
    });
    let missing: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (
            ts.isIfStatement(node) &&
            context.expressionMatchesShape(node.expression, "!bodyA || !bodyB")
        )
            missing = node.expression;
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    if (!missing)
        return context.contractError(
            declaration,
            "Expected collision-body resolution guard.",
        );
    const fields = [
        ["type", "type"],
        ["point", "point"],
        ["normal", "normal"],
        ["impulse", "impulse"],
        ["collider", "collider"],
        ["colliderIndex", "collider_index"],
        ["collidedAgainst", "collided_against"],
        ["collidedAgainstIndex", "collided_against_index"],
        ["distance", "distance"],
    ]
        .map(
            ([pinned, cpp]) =>
                `.${cpp} = ${lowerer.expression(context.propertyInitializer(info, pinned!))}`,
        )
        .join(",\n                    ");
    const dispatch = context
        .findNodes(declaration, ts.isForStatement)
        .find((statement) =>
            context
                .findNodes(statement, ts.isCallExpression)
                .some((call) =>
                    context.expressionMatchesShape(
                        call,
                        "collision.callbacks[index]!(info)",
                    ),
                ),
        );
    if (!dispatch)
        return context.contractError(
            declaration,
            "Expected shared collision observer dispatch.",
        );
    const dispatchBody = lowerPinnedBody(file, [dispatch], {
        bindings: new Map([
            ["callbackCount", { cpp: "callback_count", type: "scalar" }],
            ["world._disposed", { cpp: "world.disposed", type: "bool" }],
        ]),
        calls: new Map(),
        expression(expression, numeric) {
            if (!ts.isCallExpression(expression)) return undefined;
            const callee = context.unwrapExpression(expression.expression);
            if (
                !ts.isElementAccessExpression(callee) ||
                callee.expression.getText(file) !== "collision.callbacks"
            )
                return undefined;
            context.assertExpressionShape(
                expression.arguments[0]!,
                "info",
                "Shared collision event identity",
            );
            return `([&]() { auto observer = world.collision_callbacks.at(static_cast<std::size_t>(${numeric.expression(callee.argumentExpression)})); observer(info); }())`;
        },
    });
    return { guard: lowerer.expression(missing), fields, dispatchBody };
}
