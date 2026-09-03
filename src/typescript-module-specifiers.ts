import ts from "typescript";

/** Every static import/export and dynamic-import specifier in a module. */
export function moduleSpecifiers(
    file: ts.SourceFile,
): ts.StringLiteralLike[] {
    const found: ts.StringLiteralLike[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) ||
                ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            found.push(node.moduleSpecifier);
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length > 0 &&
            ts.isStringLiteralLike(node.arguments[0]!)
        ) {
            found.push(node.arguments[0] as ts.StringLiteralLike);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}
