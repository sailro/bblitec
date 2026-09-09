import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { unwrapExpression } from "./syntax.js";
import type { SupportedFunction } from "./user-functions.js";

/** Prove storage provenance without inferring aliasing from a readonly type. */
export function arrayReturnStorage(checker: ts.TypeChecker, declaration: SupportedFunction,
    isStaticTable?: (root: ts.Identifier) => boolean): "fresh" | "static" | undefined {
    const body = declaration.body;
    if (!body) return undefined;
    const classify = (expression: ts.Expression, seen = new Set<ts.Node>()): "fresh" | "static" | undefined => {
        const node = unwrapExpression(expression);
        if (seen.has(node)) return undefined;
        seen.add(node);
        if (ts.isArrayLiteralExpression(node)) return "fresh";
        if (ts.isIdentifier(node)) {
            let symbol = checker.getSymbolAtLocation(node);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const binding = symbol?.valueDeclaration;
            if (!binding || !ts.isVariableDeclaration(binding) || !binding.initializer ||
                !ts.isVariableDeclarationList(binding.parent) || !(binding.parent.flags & ts.NodeFlags.Const)) return undefined;
            if (ts.findAncestor(binding, ancestor => ancestor === body)) return classify(binding.initializer, seen);
            return undefined;
        }
        if (ts.isElementAccessExpression(node)) {
            let root: ts.Expression = node;
            while (ts.isElementAccessExpression(root)) root = unwrapExpression(root.expression);
            if (!ts.isIdentifier(root)) return undefined;
            let symbol = checker.getSymbolAtLocation(root);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const binding = symbol?.valueDeclaration;
            if (!binding || !ts.isVariableDeclaration(binding) || !binding.initializer ||
                !ts.isVariableDeclarationList(binding.parent) || !(binding.parent.flags & ts.NodeFlags.Const) ||
                !ts.isVariableStatement(binding.parent.parent) || !ts.isSourceFile(binding.parent.parent.parent)) return undefined;
            // Numeric constant tables live at namespace scope. Their readonly
            // rows can remain views for the whole process lifetime.
            return isStaticTable?.(root) ? "static" : undefined;
        }
        return undefined;
    };
    if (!ts.isBlock(body)) return classify(body);
    const returns: Array<"fresh" | "static" | undefined> = [];
    forEachAnalysisNode(body, node => {
        if (ts.isReturnStatement(node)) returns.push(node.expression ? classify(node.expression) : undefined);
    }, { functions: "skip" });
    return returns.length > 0 && returns.every(value => value === returns[0]) ? returns[0] : undefined;
}
