import ts from "typescript";
import { declaredSymbol, resolvedSymbol } from "./compiler/symbols.js";

/** Explicitly erased imports/re-exports do not participate in module evaluation. */
export function moduleImportKind(
    statement: ts.ImportDeclaration | ts.ExportDeclaration,
): "runtime" | "type" {
    if (ts.isExportDeclaration(statement)) {
        return statement.isTypeOnly ||
            (statement.exportClause &&
                ts.isNamedExports(statement.exportClause) &&
                statement.exportClause.elements.length > 0 &&
                statement.exportClause.elements.every(
                    (element) => element.isTypeOnly,
                ))
            ? "type"
            : "runtime";
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return "type";
    if (
        !clause ||
        clause.name ||
        !clause.namedBindings ||
        !ts.isNamedImports(clause.namedBindings)
    )
        return "runtime";
    return clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)
        ? "type"
        : "runtime";
}

/** Whether an identifier stands in a type: a type node, `implements`, an interface's `extends`. */
function inTypePosition(identifier: ts.Identifier): boolean {
    for (let node: ts.Node = identifier.parent; ; node = node.parent) {
        if (ts.isSourceFile(node)) return false;
        // A class's `extends` names its base class, a value.
        if (ts.isExpressionWithTypeArguments(node))
            return !(
                ts.isHeritageClause(node.parent) &&
                node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
                ts.isClassLike(node.parent.parent)
            );
        if (ts.isTypeNode(node)) return true;
    }
}

/**
 * Whether an import or re-export makes its module run, as TypeScript emits
 * it without `verbatimModuleSyntax`: an import with bindings runs only when
 * its file reads one of them as a value (a binding used only in types,
 * `typeof` in a type included, is elided with its import); a named
 * re-export runs when it exports a value; `import "./x"` and `export *`
 * always run.
 */
export function isRuntimeImport(
    checker: ts.TypeChecker,
    statement: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
    if (moduleImportKind(statement) === "type") return false;
    const exportsValue = (specifier: ts.ExportSpecifier): boolean => {
        const target = resolvedSymbol(checker, specifier.name);
        return (
            !specifier.isTypeOnly &&
            target !== undefined &&
            (target.flags & ts.SymbolFlags.Value) !== 0
        );
    };
    if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        return !clause || !ts.isNamedExports(clause)
            ? true
            : clause.elements.some(exportsValue);
    }
    const clause = statement.importClause;
    if (!clause) return true;
    const bindings = new Set<ts.Symbol>();
    const bind = (name: ts.Identifier): void => {
        const symbol = declaredSymbol(checker, name);
        if (symbol) bindings.add(symbol);
    };
    if (clause.name) bind(clause.name);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bind(named.name);
    else if (named)
        for (const element of named.elements)
            if (!element.isTypeOnly) bind(element.name);
    const file = statement.getSourceFile();
    const readsValue = (node: ts.Node): boolean => {
        if (ts.isImportDeclaration(node)) return false;
        if (ts.isExportSpecifier(node)) {
            const local = checker.getExportSpecifierLocalTargetSymbol(node);
            return (
                local !== undefined && bindings.has(local) && exportsValue(node)
            );
        }
        if (ts.isIdentifier(node) && !inTypePosition(node)) {
            const symbol = declaredSymbol(checker, node);
            if (symbol && bindings.has(symbol)) return true;
        }
        return ts.forEachChild(node, readsValue) ?? false;
    };
    return readsValue(file);
}
