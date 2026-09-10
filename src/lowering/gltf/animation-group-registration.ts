import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

/** Source public group-list ownership; the task's update is transported by the ordered registry. */
export function lowerAnimationGroupRegistration(context: LoweringContext): string {
    const module = "src/animation/animation-group-task.ts";
    const {file, declaration} = context.functionDeclaration(module, "addAnimationGroup");
    const statements = declaration.body!.statements;
    const task = statements.findIndex(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(variable =>
        ts.isIdentifier(variable.name) && variable.name.text === "task"));
    if (task < 0) context.contractError(declaration, "Expected source animation task construction boundary.");
    const push = statements[task + 1], owner = statements[task + 2];
    if (!push || !owner || !ts.isExpressionStatement(push) || !ts.isExpressionStatement(owner))
        context.contractError(declaration, "Expected ordered animation group and owner publication.");
    context.assertExpressionShape(push.expression, "getMutableAnimationGroups(manager).push(group)", "Animation group registry publication");
    context.assertExpressionShape(owner.expression, "groupInternal._animationManager = manager", "Animation group owner publication");
    const bindings = new Map<string, PinnedBinding>([
        ["manager", {cpp: "manager", type: "opaque", staticBoolean: true}],
        ["owner", {cpp: "owner", type: "opaque", absentCpp: "!owner"}],
        ["groupInternal._animationManager", {cpp: "registration", type: "opaque"}],
        ["group.name", {cpp: "name", type: "opaque"}],
    ]);
    const body = lowerPinnedBody(file, [...statements.slice(0, task), push, owner], {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        expression(node) {
            if (ts.isTemplateExpression(node)) {
                const parts = [`std::string(${JSON.stringify(node.head.text)})`];
                for (const span of node.templateSpans) {
                    context.assertExpressionShape(span.expression, "group.name", "Animation ownership error name");
                    parts.push("name", JSON.stringify(span.literal.text));
                }
                return `(${parts.join(" + ")})`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isThrowStatement(statement)) {
                const error = statement.expression;
                if (!ts.isNewExpression(error) || !ts.isIdentifier(error.expression) || error.expression.text !== "Error" || error.arguments?.length !== 1)
                    context.contractError(statement, "Expected source animation ownership Error construction.");
                return [`${indent}throw std::runtime_error(${lowerer.expression(error.arguments![0]!)});`];
            }
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                const variable = statement.declarationList.declarations[0]!;
                if (!ts.isIdentifier(variable.name) || !variable.initializer) return undefined;
                if (variable.name.text === "groupInternal") {
                    context.assertExpressionShape(variable.initializer, "group as AnimationGroupTaskGroup", "Animation registry group identity"); return [];
                }
                if (variable.name.text === "owner") {
                    context.assertExpressionShape(variable.initializer, "groupInternal._animationManager", "Animation registry owner identity");
                    return [`${indent}const auto owner = registration.lock();`];
                }
            }
            if (statement === push) return [`${indent}append();`];
            return undefined;
        },
    });
    return `// ${context.provenance(module, "addAnimationGroup")}
template<class Append>
void register_animation_group(const PropertyAnimationManager& manager,
    std::weak_ptr<PropertyAnimationManagerRecord>& registration, const std::string& name, Append append) {
${body}
}`;
}
