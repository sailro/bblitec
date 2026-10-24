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

/** What a file reads, as values, of the aliases its imports bind. */
interface AliasReads {
    readonly aliases: ReadonlySet<ts.Symbol>;
    readonly exports: readonly ts.ExportSpecifier[];
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const aliasReads = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.SourceFile, AliasReads>
>();

/**
 * One walk of a file for the aliases it reads as values: a type node
 * (`implements`, an interface's `extends`, `typeof` in a type) reads none,
 * a class's `extends` names its base class, a value; and its export
 * specifiers, whose local alias a re-export reads.
 */
function fileAliasReads(
    checker: ts.TypeChecker,
    file: ts.SourceFile,
): AliasReads {
    let files = aliasReads.get(checker);
    if (!files) aliasReads.set(checker, (files = new WeakMap()));
    const known = files.get(file);
    if (known) return known;
    const aliases = new Set<ts.Symbol>();
    const exports: ts.ExportSpecifier[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) return;
        if (ts.isExportSpecifier(node)) {
            exports.push(node);
            return;
        }
        if (ts.isExpressionWithTypeArguments(node)) {
            if (
                ts.isHeritageClause(node.parent) &&
                node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
                ts.isClassLike(node.parent.parent)
            )
                visit(node.expression);
            return;
        }
        if (ts.isTypeNode(node)) return;
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(checker, node);
            if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
                aliases.add(symbol);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    const reads = { aliases, exports };
    files.set(file, reads);
    return reads;
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
    const reads = fileAliasReads(checker, statement.getSourceFile());
    return (
        [...bindings].some((binding) => reads.aliases.has(binding)) ||
        reads.exports.some((specifier) => {
            const local =
                checker.getExportSpecifierLocalTargetSymbol(specifier);
            return (
                local !== undefined &&
                bindings.has(local) &&
                exportsValue(specifier)
            );
        })
    );
}
