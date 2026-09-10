import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";

/** Zero mask denotes an absent entry in the admitted visibility-only native map. */
export function lowerGltfBoneVisibility(context: LoweringContext): string {
    const module = "src/skeleton/bone-control.ts";
    const ensure = context.functionDeclaration(module, "ensureOverride");
    context.assertFunctionBodyShape(ensure.declaration, `{
        let o = skeleton._overrides.get(bone._nodeIndex);
        if (!o) {
            o = { mask: 0, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
            skeleton._overrides.set(bone._nodeIndex, o);
        }
        return o;
    }`, "Visibility-only override initialization");
    const {file, declaration} = context.functionDeclaration(module, "setBoneVisible");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["visible", {cpp: "visible", type: "bool"}],
            ["o", {cpp: "o", type: "opaque", absentCpp: "!o"}],
            ["o.mask", {cpp: "o->mask", type: "scalar"}],
            ["bone._nodeIndex", {cpp: "node", type: "scalar"}],
        ]),
        calls: new Map([
            ["skeleton._bake", () => "bake()"],
            ["skeleton._overrides.delete", (args: readonly string[]) => `(entries.at(static_cast<std::size_t>(${args[0]})).mask = 0u)`],
        ]), booleanAnd: true,
        expression(node, numeric) {
            if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.TildeToken)
                return `bbl::js::bitwise_not(${numeric.expression(node.operand)})`;
            return undefined;
        },
        statement(node, numeric, indent) {
            if (ts.isVariableStatement(node)) {
                const variable = node.declarationList.declarations[0];
                if (node.declarationList.declarations.length !== 1 || !variable || !variable.initializer ||
                    !ts.isIdentifier(variable.name) || variable.name.text !== "o") return undefined;
                if (context.expressionMatchesShape(variable.initializer, "ensureOverride(skeleton, bone)"))
                    return [`${indent}auto* o = &entries.at(node);`];
                context.assertExpressionShape(variable.initializer, "skeleton._overrides.get(bone._nodeIndex)", "Bone override lookup");
                return [`${indent}auto* o = entries.at(node).mask ? &entries.at(node) : nullptr;`];
            }
            if (!ts.isExpressionStatement(node) || !ts.isBinaryExpression(node.expression)) return undefined;
            const expression = node.expression;
            if (expression.operatorToken.kind !== ts.SyntaxKind.BarEqualsToken &&
                expression.operatorToken.kind !== ts.SyntaxKind.AmpersandEqualsToken) return undefined;
            context.assertExpressionShape(expression.left, "o.mask", "Bone visibility mask store");
            const operation = ts.setTextRange(ts.factory.createBinaryExpression(expression.left,
                expression.operatorToken.kind === ts.SyntaxKind.BarEqualsToken ? ts.SyntaxKind.BarToken : ts.SyntaxKind.AmpersandToken,
                expression.right), expression);
            return [`${indent}o->mask = static_cast<std::uint32_t>(${numeric.expression(operation)});`];
        },
    });
    return `// ${context.provenance(module, "setBoneVisible")}
template<class Entries, class Bake>
void gltf_set_bone_visibility(Entries& entries, std::size_t node, bool visible, Bake bake) {
${body}
}
`;
}
