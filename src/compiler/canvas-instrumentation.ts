import { EmissionSet } from "./emission-transaction.js";
import ts from "typescript";
import type { NativeHostUi } from "./types.js";
import { nativeHostUiStyleRules } from "../ui-style-rule.js";

/** A packaged-asset progress helper may write canvas metadata that the retained
 * page never reads. Retained controls, layout, and observed metadata stay live. */
export function writesUnobservedCanvasMetadata(
    checker: ts.TypeChecker,
    program: ts.Program,
    call: ts.CallExpression,
    argumentIndex: number,
    host: NativeHostUi | undefined,
): boolean {
    if (!host) return false;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) return false;
    const parameter = declaration.parameters[argumentIndex];
    if (!parameter || !ts.isIdentifier(parameter.name)) return false;
    const symbol = checker.getSymbolAtLocation(parameter.name);
    const fields = new EmissionSet<string>();
    let valid = true;
    const visit = (node: ts.Node): void => {
        if (!valid || ts.isTypeNode(node)) return;
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
            const dataset = node.parent;
            const field = dataset.parent;
            if (!ts.isPropertyAccessExpression(dataset) || dataset.expression !== node || dataset.name.text !== "dataset" ||
                !ts.isPropertyAccessExpression(field) || field.expression !== dataset) { valid = false; return; }
            const write = field.parent;
            if (!(ts.isBinaryExpression(write) && write.left === field && write.operatorToken.kind === ts.SyntaxKind.EqualsToken) &&
                !(ts.isDeleteExpression(write) && write.expression === field)) { valid = false; return; }
            fields.add(field.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    if (!valid || fields.size === 0) return false;
    const attributes = [...fields].map(name => `data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
    // A selector, declared attribute, or any external source read can observe
    // the metadata. Dynamic property reads conservatively retain the helper.
    const hostText = JSON.stringify([host.elements, nativeHostUiStyleRules(host)]);
    if (attributes.some(name => hostText.includes(name))) return false;
    const observes = (node: ts.Node): boolean => {
        if (node === declaration) return false;
        if (ts.isTypeNode(node)) return false;
        if (ts.isElementAccessExpression(node) &&
            checker.getTypeAtLocation(node.expression).getSymbol()?.name === "DOMStringMap") return true;
        if (ts.isPropertyAccessExpression(node) && node.name.text === "dataset" &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) return true;
        if (ts.isPropertyAccessExpression(node) && fields.has(node.name.text)) return true;
        if (ts.isStringLiteralLike(node) && attributes.some(name => node.text.includes(name))) return true;
        return ts.forEachChild(node, observes) ?? false;
    };
    return !program.getSourceFiles().some(file => !file.isDeclarationFile && observes(file));
}
