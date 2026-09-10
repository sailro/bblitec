import ts from "typescript";
import type {LoweringContext} from "../context.js";
import {lowerPinnedBody} from "../pinned-body-lowerer.js";
import type {PinnedBinding} from "../pinned-numeric-lowerer.js";

/** The source bone hook over entries carrying their glTF node index and override fields. */
export function lowerGltfAnimationBoneOverrides(context: LoweringContext, options: {visibilityOnly?: boolean} = {}): string {
    const module = "src/skeleton/bone-control.ts";
    const {file, declaration} = context.functionDeclaration(module, "applyOverridesToTRS");
    const pose = context.sourceFile("src/skeleton/skeleton-pose.ts");
    const hidden = options.visibilityOnly ? visibilityMask(context) : undefined;
    const bindings = new Map<string, PinnedBinding>([
        ["ni", {cpp: "ni", type: "scalar"}], ["o", {cpp: "o", type: "opaque"}],
        ["currentTRS", {cpp: "current_trs", type: "f32"}],
        ["numNodes", {cpp: "node_count", type: "scalar"}],
        ["hiddenOnly", {cpp: "hidden_only", type: "bool"}],
    ]);
    for (const name of ["TRS_STRIDE", "T_OFF", "R_OFF", "S_OFF"])
        bindings.set(name, {cpp: context.doubleLiteral(context.numericValue(ts.factory.createIdentifier(name), pose)), type: "scalar"});
    for (const field of hidden === undefined ? ["mask", "tx", "ty", "tz", "rx", "ry", "rz", "rw", "sx", "sy", "sz"] : ["mask"])
        bindings.set(`o.${field}`, {cpp: `o.${field}`, type: "scalar"});
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(), booleanAnd: true, booleanOr: true,
        statement(statement, lowerer, indent) {
            if (hidden !== undefined && ts.isIfStatement(statement) && ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind === ts.SyntaxKind.AmpersandToken && context.expressionMatchesShape(statement.expression.left, "m")) {
                const bit = context.numericValue(statement.expression.right, file);
                if ((bit & hidden) === 0) return statement.elseStatement ? lowerer.statement(statement.elseStatement, indent) : [];
            }
            if (!ts.isForOfStatement(statement)) return undefined;
            context.assertExpressionShape(statement.expression, "overrides", "Bone override entry storage");
            if (!ts.isVariableDeclarationList(statement.initializer) || statement.initializer.declarations.length !== 1 ||
                !ts.isArrayBindingPattern(statement.initializer.declarations[0]!.name) || !ts.isBlock(statement.statement))
                context.contractError(statement, "Expected indexed bone override entries.");
            const names = statement.initializer.declarations[0]!.name;
            if (!ts.isArrayBindingPattern(names) || names.elements.length !== 2 ||
                !ts.isBindingElement(names.elements[0]!) || names.elements[0]!.name.getText(file) !== "ni" ||
                !ts.isBindingElement(names.elements[1]!) || names.elements[1]!.name.getText(file) !== "o")
                context.contractError(statement, "Expected bone override node and field identity.");
            return [`${indent}for (const auto& [ni, o] : overrides) {`,
                ...lowerer.statements(statement.statement.statements, indent + "    "), `${indent}}`];
        },
    });
    return `// ${context.provenance(module, "applyOverridesToTRS")}
template<class Overrides, class Scratch>
void gltf_apply_animation_bone_overrides(const Overrides& overrides, Scratch& current_trs, double node_count, bool hidden_only) {
${body}
}`;
}

/** The compiler admits setBoneVisible and explicitly refuses the transform setters. */
function visibilityMask(context: LoweringContext): number {
    const module = "src/skeleton/bone-control.ts";
    const ensure = context.functionDeclaration(module, "ensureOverride");
    context.assertFunctionBodyShape(ensure.declaration, `{
        let o = skeleton._overrides.get(bone._nodeIndex);
        if (!o) {
            o = { mask: 0, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, rw: 1, sx: 1, sy: 1, sz: 1 };
            skeleton._overrides.set(bone._nodeIndex, o);
        }
        return o;
    }`, "Initial visibility-only bone mask");
    const visible = context.functionDeclaration(module, "setBoneVisible");
    const writes = context.findNodes(visible.declaration, (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarEqualsToken && context.expressionMatchesShape(node.left, "o.mask"));
    if (writes.length !== 1) context.contractError(visible.declaration, "Expected one admitted bone visibility bit writer.");
    const hidden = context.numericValue(writes[0]!.right, visible.file);
    if (!Number.isInteger(hidden) || hidden <= 0 || hidden > 0x80000000 || (hidden & (hidden - 1)) !== 0)
        context.contractError(writes[0]!, "Expected one bone visibility mask bit.");
    context.assertFunctionBodyShape(visible.declaration, `{
        if (!visible) {
            const o = ensureOverride(skeleton, bone); o.mask |= ${hidden}; skeleton._bake(); return;
        }
        const o = skeleton._overrides.get(bone._nodeIndex);
        if (o && o.mask & ${hidden}) {
            o.mask &= ~${hidden};
            if (o.mask === 0) { skeleton._overrides.delete(bone._nodeIndex); }
            skeleton._bake();
        }
    }`, "Admitted visibility mask writes");
    return hidden;
}
