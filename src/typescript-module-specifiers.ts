import ts from "typescript";

/**
 * A specifier naming a sibling file rather than a package: `.`/`..` or a
 * `./`/`../` path, resolved against the importing module's directory.
 */
export function isRelativeSpecifier(specifier: string): boolean {
    return (
        specifier === "." ||
        specifier === ".." ||
        specifier.startsWith("./") ||
        specifier.startsWith("../")
    );
}

/** The literal specifier of an `import("...")` call. */
export function dynamicImportSpecifier(
    node: ts.Node,
): ts.StringLiteralLike | undefined {
    const [specifier] = ts.isCallExpression(node) ? node.arguments : [];
    return ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        specifier !== undefined &&
        ts.isStringLiteralLike(specifier)
        ? specifier
        : undefined;
}

/** Every static import/export and dynamic-import specifier in a module. */
export function moduleSpecifiers(file: ts.SourceFile): ts.StringLiteralLike[] {
    const found: ts.StringLiteralLike[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            found.push(node.moduleSpecifier);
        }
        const dynamic = dynamicImportSpecifier(node);
        if (dynamic) found.push(dynamic);
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}
