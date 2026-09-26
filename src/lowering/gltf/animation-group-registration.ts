import ts from "typescript";
import type { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** Source public group-list ownership; the task's update is transported by the ordered registry. */
export function lowerAnimationGroupRegistration(
    context: LoweringContext,
): string {
    const module = "src/animation/animation-group-task.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "addAnimationGroup",
    );
    const statements = declaration.body!.statements;
    const task = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (variable) =>
                    ts.isIdentifier(variable.name) &&
                    variable.name.text === "task",
            ),
    );
    if (task < 0)
        context.contractError(
            declaration,
            "Expected source animation task construction boundary.",
        );
    const ownerIndex = statements.findIndex(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "groupInternal._animationManager = manager",
            ),
    );
    const owner = statements[ownerIndex];
    if (!owner || ownerIndex <= task || !ts.isExpressionStatement(owner))
        context.contractError(
            declaration,
            "Expected ordered animation group and owner publication.",
        );
    context.assertExpressionShape(
        owner.expression,
        "groupInternal._animationManager = manager",
        "Animation group owner publication",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["manager", { cpp: "manager", type: "opaque", staticBoolean: true }],
        ["owner", { cpp: "owner", type: "opaque", absentCpp: "!owner" }],
        [
            "groupInternal._animationManager",
            { cpp: "registration", type: "opaque" },
        ],
        ["group.name", { cpp: "name", type: "opaque" }],
        [
            "groupInternal._animationOrderManager",
            { cpp: "order_state.manager.lock()", type: "opaque" },
        ],
        [
            "groupInternal._animationOrder",
            { cpp: "order_state.order", type: "scalar" },
        ],
        [
            "managerInternal._nextAnimationGroupOrder",
            { cpp: "manager->next_group_order", type: "scalar" },
        ],
        [
            "groups.length",
            {
                cpp: "static_cast<double>(manager->ordered_groups.size())",
                type: "scalar",
            },
        ],
    ]);
    const body = lowerPinnedBody(
        file,
        [
            ...statements.slice(0, task),
            ...statements.slice(task + 1, ownerIndex + 1),
        ],
        {
            bindings,
            calls: new Map(),

            expression(node, lowerer) {
                if (
                    context.expressionMatchesShape(
                        node,
                        "managerInternal._nextAnimationGroupOrder ?? 0",
                    )
                )
                    return "manager->next_group_order";
                if (
                    context.expressionMatchesShape(
                        node,
                        "((groups[groupIndex - 1] as AnimationGroupTaskGroup)._animationOrder ?? -1)",
                    )
                )
                    return `order_at(${lowerer.expression(context.findNodes(node, ts.isElementAccessExpression)[0]!.argumentExpression)})`;
                if (ts.isTemplateExpression(node)) {
                    const parts = [
                        `std::string(${JSON.stringify(node.head.text)})`,
                    ];
                    for (const span of node.templateSpans) {
                        context.assertExpressionShape(
                            span.expression,
                            "group.name",
                            "Animation ownership error name",
                        );
                        parts.push("name", JSON.stringify(span.literal.text));
                    }
                    return `(${parts.join(" + ")})`;
                }
                return undefined;
            },
            statement(statement, lowerer, indent) {
                if (ts.isThrowStatement(statement)) {
                    const error = statement.expression;
                    if (
                        !ts.isNewExpression(error) ||
                        !ts.isIdentifier(error.expression) ||
                        error.expression.text !== "Error" ||
                        error.arguments?.length !== 1
                    )
                        context.contractError(
                            statement,
                            "Expected source animation ownership Error construction.",
                        );
                    return [
                        `${indent}throw std::runtime_error(${lowerer.expression(error.arguments[0]!)});`,
                    ];
                }
                if (
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.length === 1
                ) {
                    const variable = statement.declarationList.declarations[0]!;
                    if (
                        !ts.isIdentifier(variable.name) ||
                        !variable.initializer
                    )
                        return undefined;
                    if (variable.name.text === "groupInternal") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "group as AnimationGroupTaskGroup",
                            "Animation registry group identity",
                        );
                        return [];
                    }
                    if (variable.name.text === "managerInternal") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "manager as AnimationGroupTaskManager",
                            "Animation order manager identity",
                        );
                        return [];
                    }
                    if (variable.name.text === "groups") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "getMutableAnimationGroups(manager)",
                            "Animation group registry identity",
                        );
                        return [];
                    }
                    if (variable.name.text === "owner") {
                        context.assertExpressionShape(
                            variable.initializer,
                            "groupInternal._animationManager",
                            "Animation registry owner identity",
                        );
                        return [
                            `${indent}const auto owner = registration.lock();`,
                        ];
                    }
                }
                if (ts.isExpressionStatement(statement)) {
                    if (
                        context.expressionMatchesShape(
                            statement.expression,
                            "groupInternal._animationOrderManager = manager",
                        )
                    )
                        return [`${indent}order_state.manager = manager;`];
                    if (
                        ts.isCallExpression(statement.expression) &&
                        context.expressionMatchesShape(
                            statement.expression.expression,
                            "groups.splice",
                        )
                    ) {
                        context.assertExpressionShape(
                            statement.expression,
                            "groups.splice(groupIndex, 0, group)",
                            "Animation group registry publication",
                        );
                        return [
                            `${indent}insert(static_cast<std::size_t>(${lowerer.expression(statement.expression.arguments[0]!)}));`,
                        ];
                    }
                }
                return undefined;
            },
        },
    );
    return `// ${context.provenance(module, "addAnimationGroup")}
template<class OrderAt, class Insert>
void register_animation_group(const PropertyAnimationManager& manager,
    std::weak_ptr<PropertyAnimationManagerRecord>& registration, AnimationGroupOrder& order_state,
    const std::string& name, OrderAt order_at, Insert insert) {
${body}
}`;
}
