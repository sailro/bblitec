import ts from "typescript";

/** A reached assignment proves that a lexical binding must retain dynamic object storage. */
export class DynamicBindingStorageRequired extends Error {
    constructor(readonly declaration: ts.VariableDeclaration) {
        super("A lexical record binding requires dynamic object storage.");
    }
}

export function requireDynamicBindingStorage(checker: ts.TypeChecker, target: ts.Identifier): void {
    let symbol = checker.getSymbolAtLocation(target);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
        throw new DynamicBindingStorageRequired(declaration);
}
