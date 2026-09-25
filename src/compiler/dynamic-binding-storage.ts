import ts from "typescript";
import type { DataType } from "./data-types.js";
import { resolvedSymbol } from "./symbols.js";

/** A reached assignment proves that a lexical binding must retain dynamic object storage. */
export class DynamicBindingStorageRequired extends Error {
    constructor(
        readonly declaration: ts.VariableDeclaration,
        readonly dataType?: DataType,
    ) {
        super("A lexical record binding requires dynamic object storage.");
    }
}

export function requireDynamicBindingStorage(
    checker: ts.TypeChecker,
    target: ts.Identifier,
): void {
    const declaration = resolvedSymbol(checker, target)?.valueDeclaration;
    if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
    )
        throw new DynamicBindingStorageRequired(declaration);
}
