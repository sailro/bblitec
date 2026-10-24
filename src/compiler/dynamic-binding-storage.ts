import ts from "typescript";
import type { BindingScopes } from "./binding-scopes.js";
import {
    oneObjectObservation,
    type RecordObservationContext,
} from "./record-observations.js";
import type { DataType, DataTypeRegistry } from "./data-types.js";
import { resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import { nullability, arrayElementType } from "./type-facts.js";
import type { Value } from "./types.js";
import {
    NativeRecordStorageRequired,
    type NativeRecordStorageDemand,
} from "./native-record-storage.js";

/** Storage choices survive replay; generated type names belong to one registry. */
export type DynamicBindingStorage =
    | "source"
    | "array"
    | "error-array"
    | "callback"
    | { nativeHandle: DataType<"handle"> }
    | { callable: NativeRecordStorageDemand }
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

/**
 * A parameter whose record a store keeps as one object: the compile
 * replays with the parameter holding its argument as a native object
 * rather than as separate field storage.
 */
export class ParameterObjectStorageRequired extends Error {
    constructor(readonly declaration: ts.ParameterDeclaration) {
        super("A record parameter requires its own native object.");
    }
}

/** What typing a demanded binding reads of the compiler. */
export interface DemandedStorageContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: Pick<
        DataTypeRegistry,
        | "fromStoredTsType"
        | "fromCallableRecordDemand"
        | "fromSharedReturnType"
        | "nativeRecordViewDemand"
        | "hasNativeRecordView"
        | "markStoredObjectReferences"
        | "nullableType"
        | "withDynamicJsonTypes"
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
    initializer: ts.Expression | undefined,
): DataType | undefined {
    const { checker, dataTypes } = context;
    const source = checker.getTypeAtLocation(declaration.name);
    if (storage === "callback") {
        const mapped = dataTypes.fromStoredTsType(source, declaration);
        return mapped?.kind === "function"
            ? { ...mapped, identity: true }
            : undefined;
    }
    if (storage === "array")
        return dataTypes.withDynamicJsonTypes(true, () => {
            const indexed = arrayElementType(checker, source);
            const element =
                indexed &&
                (dataTypes.fromStoredTsType(indexed, declaration) ??
                    dataTypes.fromSharedReturnType(indexed, declaration));
            return element
                ? {
                      kind: "vector",
                      element: dataTypes.markStoredObjectReferences(element),
                  }
                : undefined;
        });
    if (storage === "error-array")
        return { kind: "vector", element: { kind: "error" } };
    if (typeof storage === "object") {
        if ("nativeHandle" in storage)
            return dataTypes.nullableType(storage.nativeHandle);
        if ("callable" in storage)
            return dataTypes.fromCallableRecordDemand(storage.callable);
        const mapped = dataTypes.fromStoredTsType(
            storage.nativeType,
            storage.node,
        );
        const declared = dataTypes.fromStoredTsType(source, declaration);
        const target =
            declared?.kind === "optional" ? declared.inner : declared;
        if (mapped && target?.kind === "struct") {
            const demand = dataTypes.nativeRecordViewDemand(
                target.name,
                mapped,
                storage.node,
            );
            if (demand) throw new NativeRecordStorageRequired(demand);
        }
        const absent = nullability(source);
        return mapped && (absent.null || absent.undefined)
            ? dataTypes.nullableType(mapped, !absent.null)
            : mapped;
    }
    // A fresh authored record may share an annotation with an unrelated
    // native view. Its one-object demand retains the literal's actual
    // carrier; it does not turn that object or its aliases into the native
    // owner. Later values must still pass the retained carrier's sink.
    const actualSource =
        storage === "source" &&
        initializer &&
        ts.isObjectLiteralExpression(initializer) &&
        dataTypes.hasNativeRecordView(source)
            ? checker.getTypeAtLocation(initializer)
            : undefined;
    return (
        dataTypes.fromStoredTsType(
            actualSource ?? source,
            actualSource ? initializer! : declaration,
        ) ??
        // A fresh `{}` has no members to type: a parsed document holds it
        // as one object with identity.
        (initializer &&
        ts.isObjectLiteralExpression(initializer) &&
        initializer.properties.length === 0
            ? { kind: "json" as const }
            : undefined)
    );
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

/** What keeping a stored record's object reads of the compiler. */
export interface HeldRecordContext {
    readonly bindings: Pick<
        BindingScopes,
        "recordDeclaration" | "recordParameter"
    >;
    readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >;
    readonly parameterObjects: ReadonlySet<ts.ParameterDeclaration>;
    fail(node: ts.Node, message: string): never;
}

/**
 * A compile-time record stored where it stays one object: the binding that
 * holds it -- found by its members, whatever node the store reads it from
 * (a spread operand, a member, the name) -- takes native storage, so the
 * store keeps that binding's object rather than a copy. `expression` is
 * the store's source expression, where there is one: an unbound container
 * name there stands in for a nested record it holds.
 */
export function requireHeldRecordStorage(
    context: HeldRecordContext,
    value: Value,
    node: ts.Node,
    expression: ts.Expression | undefined = ts.isExpression(node)
        ? node
        : undefined,
): void {
    if (value.kind !== "record") return;
    const declaration = context.bindings.recordDeclaration(value, expression);
    if (!declaration) {
        // A parameter's record held as field storage has no object yet.
        const parameter = context.bindings.recordParameter(value);
        if (parameter && !context.parameterObjects.has(parameter))
            throw new ParameterObjectStorageRequired(parameter);
        return;
    }
    // A binding already given its own storage is still a record only when
    // lowering its initializer into that storage refused.
    if (context.dynamicBindings.get(declaration) !== undefined)
        context.fail(
            node,
            `Record '${declaration.name.getText()}' has no native object: its initializer could not be stored natively.`,
        );
    throw new DynamicBindingStorageRequired(declaration, "source");
}

/** Replay a mutable compile-time array using its declared or represented source storage. */
export function requireMutableTupleStorage(
    context: OneObjectContext,
    value: Value,
    expression: ts.Expression,
): void {
    const declaration = context.bindings.tupleDeclaration(value, expression);
    if (!declaration?.initializer || context.dynamicBindings.has(declaration))
        return;
    const initializer = unwrapExpression(declaration.initializer);
    const declared = demandedStorageType(
        context,
        declaration,
        "array",
        initializer,
    );
    // Generation-known handle lists retain their composition metadata.
    if (declared?.kind === "vector") {
        if (declared.element.kind !== "handle")
            throw new DynamicBindingStorageRequired(declaration, "array");
        return;
    }
    // A wider annotation can mention unrepresented owners while the actual
    // initializer has a concrete array type. Every later write still passes
    // through that native element sink and refuses an incompatible value.
    const storage = {
        nativeType: context.checker.getTypeAtLocation(initializer),
        node: initializer,
    };
    const represented = demandedStorageType(
        context,
        declaration,
        storage,
        initializer,
    );
    if (represented?.kind === "vector" && represented.element.kind !== "handle")
        throw new DynamicBindingStorageRequired(declaration, storage);
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
