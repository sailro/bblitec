import ts from "typescript";
import { resolvedSymbol } from "./symbols.js";

/** Storage choices survive replay; generated type names belong to one registry. */
export type DynamicBindingStorage =
    | "source"
    | "array"
    | "error-array"
    | { nativeType: ts.Type; node: ts.Expression };

/** A reached assignment proves that a lexical binding must retain dynamic object storage. */
export class DynamicBindingStorageRequired extends Error {
    constructor(
        readonly declaration: ts.VariableDeclaration,
        readonly storage?: DynamicBindingStorage,
    ) {
        super("A lexical record binding requires dynamic object storage.");
    }
}

export function requireDynamicBindingStorage(
    checker: ts.TypeChecker,
    target: ts.Identifier,
    storage?: DynamicBindingStorage,
): void {
    const declaration = resolvedSymbol(checker, target)?.valueDeclaration;
    if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
    )
        throw new DynamicBindingStorageRequired(declaration, storage);
}
