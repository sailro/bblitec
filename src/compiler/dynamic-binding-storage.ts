import ts from "typescript";
import type { BindingScopes } from "./binding-scopes.js";
import {
    oneObjectObservation,
    type RecordObservationContext,
} from "./record-observations.js";
import type { DataType, DataTypeRegistry } from "./data-types.js";
import { resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import { nullability } from "./type-facts.js";
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

/** What typing a demanded binding reads of the compiler. */
export interface DemandedStorageContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: Pick<
        DataTypeRegistry,
        "fromStoredTsType" | "nullableType"
    >;
}

/**
 * The native type a declaration is stored as under a demand; undefined
 * when its type has no native storage representation. `initializer` is the
 * declaration's unwrapped initializer.
 */
export function demandedStorageType(
    context: DemandedStorageContext,
    declaration: ts.VariableDeclaration,
    storage: DynamicBindingStorage,
    initializer: ts.Expression,
): DataType | undefined {
    const { checker, dataTypes } = context;
    const source = checker.getTypeAtLocation(declaration.name);
    if (storage === "error-array")
        return { kind: "vector", element: { kind: "error" } };
    if (typeof storage === "object") {
        const mapped = dataTypes.fromStoredTsType(
            storage.nativeType,
            storage.node,
        );
        const absent = nullability(source);
        return mapped && (absent.null || absent.undefined)
            ? dataTypes.nullableType(mapped, !absent.null)
            : mapped;
    }
    const mapped =
        dataTypes.fromStoredTsType(source, declaration) ??
        // A fresh `{}` has no members to type: a parsed document holds it
        // as one object with identity.
        (storage === "source" &&
        ts.isObjectLiteralExpression(initializer) &&
        initializer.properties.length === 0
            ? { kind: "json" as const }
            : undefined);
    if (storage === "source") return mapped;
    const indexed = checker.getIndexTypeOfType(source, ts.IndexKind.Number);
    const element =
        mapped?.kind === "vector" || mapped?.kind === "span"
            ? mapped.element
            : indexed && dataTypes.fromStoredTsType(indexed, declaration);
    return element ? { kind: "vector", element } : undefined;
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
export interface OneObjectContext
    extends RecordObservationContext, DemandedStorageContext {
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
    // A host object already carries its identity, and a member or element
    // read names an object its container created.
    const read = initializer && unwrapExpression(initializer);
    if (
        !storage ||
        !read ||
        value.objectIdentityCpp !== undefined ||
        ts.isPropertyAccessExpression(read) ||
        ts.isElementAccessExpression(read) ||
        context.dynamicBindings.has(declaration) ||
        (storage === "array"
            ? context.bindings.tupleDeclaration(value, read)
            : context.bindings.recordDeclaration(value, read))
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
    // A type without native storage keeps its compile-time value: a use
    // that observes the one object needs that storage and refuses there.
    if (
        (observed.identity !== undefined || constantWritten) &&
        demandedStorageType(context, declaration, storage, read) !== undefined
    )
        throw new DynamicBindingStorageRequired(declaration, storage);
}
