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

/** A specifier the importing package's own `imports` map resolves (`#name`). */
export function isPackageImportSpecifier(specifier: string): boolean {
    return specifier.startsWith("#");
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

/**
 * The specifier of a module whose one statement is a side-effect import
 * (`import "./scene2";`), read by the scanner alone; undefined for any
 * other module.
 */
export function sideEffectImportSpecifier(text: string): string | undefined {
    const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        text,
    );
    const tokens: { kind: ts.SyntaxKind; value: string }[] = [];
    for (
        let kind = scanner.scan();
        kind !== ts.SyntaxKind.EndOfFileToken && tokens.length <= 3;
        kind = scanner.scan()
    )
        tokens.push({ kind, value: scanner.getTokenValue() });
    const [keyword, specifier, end, ...rest] = tokens;
    return keyword?.kind === ts.SyntaxKind.ImportKeyword &&
        specifier?.kind === ts.SyntaxKind.StringLiteral &&
        (end === undefined || end.kind === ts.SyntaxKind.SemicolonToken) &&
        rest.length === 0
        ? specifier.value
        : undefined;
}

/** Whether a module is a barrel: statements that only import or re-export. */
export function reexportsOnly(fileName: string, text: string): boolean {
    const statements = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        false,
    ).statements;
    return (
        statements.length > 0 &&
        statements.every(
            (statement) =>
                ts.isImportDeclaration(statement) ||
                ts.isExportDeclaration(statement),
        )
    );
}

/**
 * Every static import/export and dynamic-import specifier in a module, and
 * with `importTypes` every `import("x")` type's. No parent pointers are
 * read, so a parse that sets none serves.
 */
export function moduleSpecifiers(
    file: ts.SourceFile,
    { importTypes = false }: { importTypes?: boolean } = {},
): ts.StringLiteralLike[] {
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
        if (
            importTypes &&
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        )
            found.push(node.argument.literal);
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}
