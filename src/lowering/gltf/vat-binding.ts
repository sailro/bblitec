import ts from "typescript";
import {stringLiteral} from "../../cpp-literals.js";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

/** Skeleton identity lookup and preparation guards over native resource callbacks. */
export function lowerGltfVatBinding(context: LoweringContext): string {
    const module = "src/vat/vat-baker.ts";
    const {file, declaration} = context.functionDeclaration(module, "bindingOf");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["skeleton", {cpp: "skeleton", type: "bool"}],
            ["bindings", {cpp: "bindings", type: "bool"}],
        ]), calls: new Map(),
        returnValue(node, numeric) { return node ? numeric.expression(node) : "false"; },
        expression(node) {
            if (ts.isIdentifier(node) && node.text === "undefined") return "false";
            if (ts.isCallExpression(node)) {
                context.assertExpressionShape(node, "bindings?.find((binding) => binding.runtimeSkeleton === skeleton || binding.boneTexture === skeleton.boneTexture)",
                    "VAT runtime-skeleton or bone-texture identity lookup");
                return "(bindings && find_binding())";
            }
            return undefined;
        },
        statement(node, _numeric, indent) {
            if (!ts.isVariableStatement(node)) return undefined;
            const variable = node.declarationList.declarations[0]!;
            if (node.declarationList.declarations.length !== 1 || !ts.isIdentifier(variable.name) || !variable.initializer)
                context.contractError(node, "Expected VAT binding storage alias.");
            if (variable.name.text === "skeleton") {
                context.assertExpressionShape(variable.initializer, "mesh.skeleton", "VAT target skeleton");
                return [`${indent}const bool skeleton = mesh_skeleton;`];
            }
            context.assertExpressionShape(variable.initializer, "group._gltfMixer?.[2]", "VAT all-bindings tuple");
            if (variable.name.text !== "bindings") context.contractError(node, "Expected VAT bindings alias.");
            return [`${indent}const bool bindings = bindings_present;`];
        },
    });
    const prepare = context.functionDeclaration(module, "prepareVatMany");
    const skeletonMap = context.unwrapExpression(context.variableInitializer(prepare.declaration, "states"));
    if (!ts.isCallExpression(skeletonMap) || !ts.isArrowFunction(skeletonMap.arguments[0]!) || !ts.isBlock(skeletonMap.arguments[0]!.body))
        context.contractError(skeletonMap, "Expected VAT target preparation map.");
    const statements = skeletonMap.arguments[0]!.body.statements;
    const bindingMap = context.unwrapExpression(context.variableInitializer(skeletonMap.arguments[0]!, "bindings"));
    if (!ts.isCallExpression(bindingMap) || !ts.isArrowFunction(bindingMap.arguments[0]!) || !ts.isBlock(bindingMap.arguments[0]!.body))
        context.contractError(bindingMap, "Expected VAT per-group binding map.");
    const guard = (statements: readonly ts.Statement[]) => lowerPinnedBody(file, statements, {
        bindings: new Map<string, PinnedBinding>([
            ["skeleton", {cpp: "skeleton", type: "bool"}],
            ["binding", {cpp: "binding", type: "bool"}],
            ["binding.boneCount", {cpp: "binding_bone_count", type: "scalar"}],
            ["skeleton.boneCount", {cpp: "skeleton_bone_count", type: "scalar"}],
        ]), calls: new Map(),
        statement(node, _numeric, indent) {
            if (!ts.isThrowStatement(node)) return undefined;
            const expression = node.expression;
            if (!ts.isNewExpression(expression) || !context.expressionMatchesShape(expression.expression, "Error") ||
                expression.arguments?.length !== 1 || !ts.isTemplateExpression(expression.arguments[0]!))
                context.contractError(node, "Expected a VAT preparation error template.");
            const message = expression.arguments[0]!;
            const parts = [`std::string{${stringLiteral(message.head.text)}}`];
            for (const span of message.templateSpans) {
                const name = context.expressionMatchesShape(span.expression, "target.mesh.name") ? "mesh_name" :
                    context.expressionMatchesShape(span.expression, "group.name") ? "group_name" : undefined;
                if (!name) context.contractError(span.expression, "Unsupported VAT error field.");
                parts.push(name, `std::string{${stringLiteral(span.literal.text)}}`);
            }
            return [`${indent}throw std::runtime_error(${parts.join(" + ")});`];
        },
    });
    const bindingIndex = statements.findIndex(statement => ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(variable => ts.isIdentifier(variable.name) && variable.name.text === "bindings"));
    const skeletonGuards = statements.slice(0, bindingIndex).filter(ts.isIfStatement);
    const bindingGuards = bindingMap.arguments[0]!.body.statements.filter(ts.isIfStatement);
    if (skeletonGuards.length !== 1 || bindingGuards.length !== 2)
        context.contractError(prepare.declaration, "Expected source skeleton and binding preparation guards.");
    return `// ${context.provenance(module, "bindingOf and prepareVatMany guards")}
template<class FindBinding>
bool gltf_vat_binding_of(bool mesh_skeleton, bool bindings_present, FindBinding find_binding) {
${body}
}
void gltf_vat_require_skeleton(bool skeleton, const std::string& mesh_name) {
${guard(skeletonGuards)}
}
void gltf_vat_require_binding(bool binding, double binding_bone_count, double skeleton_bone_count,
    const std::string& mesh_name, const std::string& group_name) {
${guard(bindingGuards)}
}
`;
}
