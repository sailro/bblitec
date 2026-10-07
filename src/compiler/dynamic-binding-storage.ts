import ts from "typescript";
import type { BindingScopes } from "./binding-scopes.js";
import {
    oneObjectObservation,
    type RecordObservationContext,
} from "./record-observations.js";
import { resolvedSymbol } from "./symbols.js";
import type { Value } from "./types.js";

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

/** The initialized variable declaration a name reads, whose storage a demand can retype. */
export function initializedVariableDeclaration(
    checker: ts.TypeChecker,
    name: ts.Identifier,
): ts.VariableDeclaration | undefined {
    const declaration = resolvedSymbol(checker, name)?.valueDeclaration;
    return declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
        ? declaration
        : undefined;
}

export function requireDynamicBindingStorage(
    checker: ts.TypeChecker,
    target: ts.Identifier,
    storage?: DynamicBindingStorage,
): void {
    const declaration = initializedVariableDeclaration(checker, target);
    if (declaration)
        throw new DynamicBindingStorageRequired(declaration, storage);
}

/** What deciding a declaration's one object reads of the compiler. */
export interface OneObjectContext extends RecordObservationContext {
    readonly bindings: Pick<
        BindingScopes,
        "recordDeclaration" | "tupleDeclaration"
    >;
    readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >;
}

/**
 * The value a declaration's initializer lowered to, as a binding takes it
 * or the static path reads it. A compile-time record or tuple is rebuilt at
 * each use; where the program observes the one object the literal creates
 * (`oneObjectObservation`: compared by identity, or a constant field
 * written through `this`), the declaration takes that object, one runtime
 * array or object. An alias of an earlier binding's aggregate leaves the
 * question to that binding, whose observation follows its aliases.
 */
export function requireOneObject(
    context: OneObjectContext,
    declaration: ts.VariableDeclaration,
    value: Value,
): void {
    const storage =
        value.kind === "tuple"
            ? "array"
            : value.kind === "record" && !value.cpp
              ? "source"
              : undefined;
    const initializer = declaration.initializer;
    if (
        !storage ||
        !initializer ||
        context.dynamicBindings.has(declaration) ||
        (storage === "array"
            ? context.bindings.tupleDeclaration(value, initializer)
            : context.bindings.recordDeclaration(value, initializer))
    )
        return;
    const observed = oneObjectObservation(context, declaration);
    const constantWritten =
        storage === "source" &&
        observed.receiverWrites.some((field) => {
            const member = value.recordProperties?.[field];
            return (
                member !== undefined &&
                !member.sharedStorageCpp &&
                !member.nativeLvalue &&
                (member.staticNumber !== undefined ||
                    member.staticBoolean !== undefined ||
                    member.staticString !== undefined)
            );
        });
    if (observed.identity !== undefined || constantWritten)
        throw new DynamicBindingStorageRequired(declaration, storage);
}
