import ts from "typescript";

/** Explicitly erased imports/re-exports do not participate in module evaluation. */
export function moduleImportKind(statement: ts.ImportDeclaration | ts.ExportDeclaration): "runtime" | "type" {
    if (ts.isExportDeclaration(statement)) {
        return statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length > 0 && statement.exportClause.elements.every(element => element.isTypeOnly))
            ? "type" : "runtime";
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return "type";
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return "runtime";
    return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)
        ? "type" : "runtime";
}
