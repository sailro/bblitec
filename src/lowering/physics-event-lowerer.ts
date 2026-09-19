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
    const lower = (name: string, returns: string, parameters = "") => {
        const method = initializer.properties.find(
            (member) => member.name?.getText(file) === name,
        );
        if (!method || !ts.isMethodDeclaration(method) || !method.body)
            return context.contractError(
                initializer,
                `Expected event context method ${name}.`,
            );
        const body = lowerPinnedBody(file, method.body.statements, {
            bindings: new Map([
                ["draining", binding("world.events->draining", "bool")],
                [
                    "removed",
                    {
                        ...binding("world.events->removed"),
                        absentCpp: "!world.events->removed",
                    },
                ],
                [
                    "deferred",
                    { ...binding("deferred"), absentCpp: "!deferred" },
                ],
                [
                    "thinBody",
                    { ...binding("thin_body"), absentCpp: "!thin_body" },
                ],
                ["nativeId", binding("native_id", "scalar")],
                ["body", binding("body")],
                ["body._hkBody", binding("body.handle")],
                ["body._hkBody[0]", binding("body.handle.value", "scalar")],
            ]),
            calls: new Map<string, (args: readonly string[]) => string>([
                ["Number", (args) => args[0]!],
                [
                    "world._hknp.HP_Body_Release",
                    (args) =>
                        `physics_release_native_body(world, ${args.join(", ")})`,
                ],
                ["context.end", () => "physics_events_end(world)"],
            ]),
            statement(statement, _lowerer, indent) {
                if (ts.isVariableStatement(statement)) {
                    const local = statement.declarationList.declarations[0];
                    if (local?.name.getText(file) === "deferred") {
                        context.assertExpressionShape(
                            local.initializer!,
                            "removed",
                            "Deferred event body snapshot",
                        );
                        return [
                            `${indent}const auto deferred = std::move(world.events->removed);`,
                        ];
                    }
                    if (local?.name.getText(file) === "thinBody") {
                        context.assertExpressionShape(
                            local.initializer!,
                            "world._thin?.resolve(nativeId)",
                            "Thin event resolution",
                        );
                        return [
                            `${indent}const auto thin_body = ${thin ? "thin_resolve(world, native_id)" : "std::optional<PhysicsBodyInstance>{}"};`,
                        ];
                    }
                }
                if (ts.isExpressionStatement(statement)) {
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "removed = undefined",
                        )
                    ) {
                        return [`${indent}world.events->removed.reset();`];
                    }
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "(removed ??= []).push(body)",
                        )
                    ) {
                        return [
                            `${indent}(world.events->removed ? *world.events->removed : world.events->removed.emplace()).push_back(body);`,
                        ];
                    }
                }
                return undefined;
            },
            forOf(iterated, element) {
                const range =
                    iterated === "world._bodies"
                        ? "world.bodies"
                        : iterated === "removed"
                          ? "*world.events->removed"
                          : iterated === "deferred"
                            ? "*deferred"
                            : undefined;
                return range
                    ? {
                          range,
                          bindings: new Map([[element, binding(element)]]),
                      }
                    : undefined;
            },
            returnValue(expression, lowerer) {
                if (!expression) return "";
                if (expression.kind === ts.SyntaxKind.NullKeyword)
                    return "std::nullopt";
                if (ts.isArrayLiteralExpression(expression)) {
                    context.assertExpressionShape(
                        expression,
                        "[body, body._hkBody, 0]",
                        "Ordinary event body identity",
                    );
                    return "PhysicsBodyInstance{body, body.handle, 0}";
                }
                return lowerer.expression(expression);
            },
        });
        return `${returns} physics_events_${name}(PhysicsWorld& world${parameters}) {\n${body}\n}`;
    };
    return [
        lower("begin", "void"),
        lower("end", "void"),
        lower("remove", "bool", ", const PhysicsBody& body"),
        lower(
            "resolve",
            "std::optional<PhysicsBodyInstance>",
            ", double native_id",
        ),
        lower("dispose", "void"),
    ].join("\n");
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
                        `${indent}const bool events = world.events.has_value();`,
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
                            `${indent}if (events) physics_events_${operation}(world);`,
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
        booleanOr: true,
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
    return { guard: lowerer.expression(missing), fields };
}
