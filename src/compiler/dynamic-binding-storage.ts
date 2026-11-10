import { StorageDemand } from "./storage-demand.js";
import { demandOrPlan } from "./storage-demand-planner.js";
import type { StorageRequest } from "./replay-storage.js";
import ts from "typescript";
import type { BindingScopes } from "./binding-scopes.js";
import {
    oneObjectObservation,
    recordCopyObservation,
    type RecordObservationContext,
} from "./record-observations.js";
import type { DataType, DataTypeRegistry } from "./data-types.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import {
    isProtoSetter,
    outermostWrapper,
    unwrapExpression,
    variableKind,
} from "./syntax.js";
import { onlyReadsFields } from "./constructed-fields.js";
import {
    nullability,
    arrayElementType,
    classInstanceDeclaration,
    unionMembers,
    isAnyTyped,
} from "./type-facts.js";
import { isRebound } from "./binding-rebinds.js";
import type { Value } from "./types.js";
import type { NativeRecordStorageDemand } from "./native-record-storage.js";

/** Storage choices survive replay; generated type names belong to one registry. */
export type DynamicBindingStorage =
    | "source"
    | "array"
    | "error-array"
    | "callback"
    /**
     * A hoisted `var` a function may read before its assignment: its
     * declared type, undefined until assigned.
     */
    | "unassigned"
    | { nativeHandle: DataType<"handle"> }
    /** An array binding holding elements as an array assigned to it does. */
    | { elements: DataType }
    | { callable: NativeRecordStorageDemand }
    | { nativeType: ts.Type; node: ts.Expression };

/** A reached assignment proves that a lexical binding must retain dynamic object storage. */
export class DynamicBindingStorageRequired extends StorageDemand {
    constructor(
        readonly declaration: ts.VariableDeclaration,
        readonly storage?: DynamicBindingStorage,
    ) {
        super("A lexical record binding requires dynamic object storage.");
    }

    get request(): StorageRequest {
        return {
            kind: "dynamic",
            declaration: this.declaration,
            storage: this.storage,
        };
    }
}

/**
 * A parameter whose record a store keeps as one object: the compile
 * replays with the parameter holding its argument as a native object
 * rather than as separate field storage.
 */
export class ParameterObjectStorageRequired extends StorageDemand {
    constructor(readonly declaration: ts.ParameterDeclaration) {
        super("A record parameter requires its own native object.");
    }

    get request(): StorageRequest {
        return { kind: "parameter-object", declaration: this.declaration };
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
        | "requireNativeRecordView"
        | "hasNativeRecordView"
        | "markStoredObjectReferences"
        | "nullableType"
        | "withDynamicJsonTypes"
        | "dynamicJsonType"
    >;
}

/**
 * The class instance type a binding holds when a class instance initializes
 * it and nothing rebinds it, whatever record type annotates it: JavaScript
 * keeps one object, and its reads and calls go through the class.
 */
export function heldClassInstanceType(
    checker: ts.TypeChecker,
    declaration: ts.VariableDeclaration,
): ts.Type | undefined {
    const initializer = declaration.initializer;
    if (!declaration.type || !initializer || !ts.isIdentifier(declaration.name))
        return undefined;
    const type = checker.getTypeAtLocation(initializer);
    const instance = classInstanceDeclaration(type);
    // Only record types: an open one (`unknown`, `object`) is a dynamic view.
    const records = unionMembers(
        checker.getTypeFromTypeNode(declaration.type),
    ).filter(
        (member) =>
            (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0,
    );
    const symbol = declaredSymbol(checker, declaration.name);
    return instance &&
        symbol &&
        records.length > 0 &&
        records.every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) !==
                    0 && classInstanceDeclaration(member) !== instance,
        ) &&
        !isRebound(checker, [declaration.getSourceFile()], symbol)
        ? type
        : undefined;
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
    if (storage === "unassigned") {
        const declared = dataTypes.fromStoredTsType(source, declaration);
        return (
            declared &&
            heldAsBinding(context, declaration, source, declared, true)
        );
    }
    if (typeof storage === "object") {
        if ("nativeHandle" in storage)
            return dataTypes.nullableType(storage.nativeHandle);
        if ("elements" in storage)
            return heldAsBinding(context, declaration, source, {
                kind: "vector",
                element: storage.elements,
            });
        if ("callable" in storage)
            return dataTypes.fromCallableRecordDemand(storage.callable);
        const mapped = dataTypes.fromStoredTsType(
            storage.nativeType,
            storage.node,
        );
        const declared = dataTypes.fromStoredTsType(source, declaration);
        const target =
            declared?.kind === "optional" ? declared.inner : declared;
        if (mapped && target?.kind === "struct")
            dataTypes.requireNativeRecordView(
                target.name,
                mapped,
                storage.node,
            );
        return mapped && heldAsBinding(context, declaration, source, mapped);
    }
    // A fresh authored record may share an annotation with an unrelated
    // native view. Its one-object demand retains the literal's actual
    // carrier; it does not turn that object or its aliases into the native
    // owner. Later values must still pass the retained carrier's sink.
    const actualSource =
        heldClassInstanceType(checker, declaration) ??
        (storage === "source" &&
        initializer &&
        ts.isObjectLiteralExpression(initializer) &&
        dataTypes.hasNativeRecordView(source)
            ? checker.getTypeAtLocation(initializer)
            : undefined);
    const stored = (): DataType | undefined =>
        dataTypes.fromStoredTsType(
            actualSource ?? source,
            actualSource ? initializer! : declaration,
        );
    return (
        stored() ??
        // A dictionary of unknown values is a document.
        (storage === "source"
            ? dataTypes.dynamicJsonType(source)
            : undefined) ??
        // A fresh `{}` has no members to type: a parsed document holds it
        // as one object with identity.
        (initializer &&
        ts.isObjectLiteralExpression(initializer) &&
        initializer.properties.length === 0
            ? { kind: "json" as const }
            : undefined) ??
        // A record's fields hold unknown values as documents.
        (storage === "source"
            ? dataTypes.withDynamicJsonTypes(true, stored)
            : undefined) ??
        // A literal of plain JSON values no layout stores (an empty array
        // in it holds no element type, its arrays mix shapes) is the
        // document it spells.
        (initializer && spellsJson(initializer)
            ? { kind: "json" as const }
            : undefined)
    );
}

/**
 * Whether an expression spells a JSON value: object and array literals of
 * such values under plain keys, strings, numbers, booleans and `null`.
 */
function spellsJson(expression: ts.Expression): boolean {
    const node = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(node))
        return node.properties.every(
            (property) =>
                ts.isPropertyAssignment(property) &&
                !ts.isComputedPropertyName(property.name) &&
                !isProtoSetter(property) &&
                spellsJson(property.initializer),
        );
    if (ts.isArrayLiteralExpression(node))
        return node.elements.every(
            (element) =>
                !ts.isSpreadElement(element) &&
                !ts.isOmittedExpression(element) &&
                spellsJson(element),
        );
    return (
        ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(node.operand))
    );
}

/**
 * `stored` as `declaration` holds it, nullable for the absent values the
 * binding can hold: its type's (`source`), its initializer's where
 * TypeScript types it `any` (`var observer = null` holds null until
 * assigned), and undefined while it is `unassigned`.
 */
function heldAsBinding(
    context: DemandedStorageContext,
    declaration: ts.VariableDeclaration,
    source: ts.Type,
    stored: DataType,
    unassigned = false,
): DataType {
    const absent = nullability(
        isAnyTyped(source) && declaration.initializer
            ? context.checker.getTypeAtLocation(declaration.initializer)
            : source,
    );
    return absent.null || absent.undefined || unassigned
        ? context.dataTypes.nullableType(stored, !absent.null)
        : stored;
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

/** What retyping an auto-typed binding from its assignments reads. */
export interface AssignedStorageContext extends DemandedStorageContext {
    readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >;
}

/**
 * An assignment of a value with native storage to an auto-typed binding
 * that holds no storage yet (its `null` initializer is generation-known):
 * the binding is stored as the assigned type, nullable as its initializer.
 */
export function requireAssignedBindingStorage(
    context: AssignedStorageContext,
    target: ts.Identifier,
    value: ts.Expression,
): void {
    const { checker } = context;
    const declaration = initializedVariableDeclaration(checker, target);
    if (
        !declaration ||
        context.dynamicBindings.has(declaration) ||
        !isAnyTyped(checker.getTypeAtLocation(declaration.name))
    )
        return;
    const nativeType = checker.getNonNullableType(
        checker.getTypeAtLocation(value),
    );
    if (
        !isAnyTyped(nativeType) &&
        context.dataTypes.fromStoredTsType(nativeType, value)
    )
        throw new DynamicBindingStorageRequired(declaration, {
            nativeType,
            node: value,
        });
}

/**
 * The type the value `receiver` reads holds, which member dispatch keys
 * on: the checker's, except where it is `any` -- an auto-typed binding
 * read outside the flow that assigned it holds the type its storage was
 * demanded for (`requireAssignedBindingStorage`), and a property read off
 * such a value (`c.signal`) the property's type there.
 */
export function receiverType(
    context: Pick<AssignedStorageContext, "checker" | "dynamicBindings">,
    receiver: ts.Expression,
): ts.Type {
    const { checker } = context;
    const type = checker.getTypeAtLocation(receiver);
    if (!isAnyTyped(type)) return type;
    const node = unwrapExpression(receiver);
    if (ts.isPropertyAccessExpression(node)) {
        const owner = receiverType(context, node.expression);
        const property =
            !isAnyTyped(owner) &&
            checker.getNonNullableType(owner).getProperty(node.name.text);
        return property
            ? checker.getTypeOfSymbolAtLocation(property, node)
            : type;
    }
    const declaration =
        ts.isIdentifier(node) && initializedVariableDeclaration(checker, node);
    const storage = declaration && context.dynamicBindings.get(declaration);
    return typeof storage === "object" && "nativeType" in storage
        ? storage.nativeType
        : type;
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
 * The read of `parameter`'s record inside a store's source expression: the
 * parameter, or the member path through it (`p`, `p.inner`), where the
 * store copies it into a field, element or spread.
 */
function heldParameterRead(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    parameter: ts.ParameterDeclaration,
): ts.Expression | undefined {
    let read: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (read) return;
        if (
            ts.isIdentifier(node) &&
            resolvedSymbol(checker, node)?.valueDeclaration === parameter
        ) {
            let path: ts.Expression = node;
            while (
                ts.isPropertyAccessExpression(path.parent) &&
                path.parent.expression === path
            )
                path = path.parent;
            read = path;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    return read;
}

/**
 * Why a store's native copy of `parameter`'s record could be told apart
 * from the argument's object JavaScript stores: a copy kept as the type the
 * store gives its read, or the record's own type where it gives none.
 */
function storedCopyObservation(
    context: RecordObservationContext,
    expression: ts.Expression | undefined,
    parameter: ts.ParameterDeclaration,
): string | undefined {
    const { checker } = context;
    const read =
        expression && heldParameterRead(checker, expression, parameter);
    if (!read) return "the store reads the record through another name";
    const source = checker.getTypeAtLocation(read);
    const shorthand = ts.isShorthandPropertyAssignment(read.parent)
        ? read.parent
        : undefined;
    const literalType =
        shorthand && checker.getContextualType(shorthand.parent);
    const member =
        shorthand &&
        literalType &&
        checker.getPropertyOfType(literalType, shorthand.name.text);
    const target =
        (shorthand
            ? member && checker.getTypeOfSymbolAtLocation(member, shorthand)
            : checker.getContextualType(read)) ?? source;
    const fields = checker
        .getPropertiesOfType(target)
        .map((property) => property.name);
    const carries = checker
        .getPropertiesOfType(source)
        .some((property) => !fields.includes(property.name));
    // A copy lent to a callee that only reads it, or kept where only its
    // fields are read, is never seen as an object.
    return recordCopyObservation(
        context,
        source,
        target,
        fields,
        carries,
        expression,
        expression && fieldReadOnlyHolder(checker, expression)
            ? "sole"
            : undefined,
    );
}

/** @unjournaled A pure function of the checked program, kept across replays. */
const fieldReadOnlyHolders = new WeakMap<ts.VariableDeclaration, boolean>();

/**
 * Whether `expression` initializes a function's `const` that the program
 * only reads fields of (`onlyReadsFields`): a copy held there is its own
 * object's only view, and only a write to the record it copies could tell
 * it apart. A module binding can be read from another file.
 */
function fieldReadOnlyHolder(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const initializer = outermostWrapper(expression);
    const declaration = initializer.parent;
    if (
        !ts.isVariableDeclaration(declaration) ||
        declaration.initializer !== initializer ||
        !ts.isIdentifier(declaration.name) ||
        variableKind(declaration) !== "const" ||
        !ts.findAncestor(declaration, ts.isFunctionLike)
    )
        return false;
    let known = fieldReadOnlyHolders.get(declaration);
    if (known === undefined) {
        known = onlyReadsFields(
            (node) => declaredSymbol(checker, node),
            declaration,
        );
        fieldReadOnlyHolders.set(declaration, known);
    }
    return known;
}

/** What keeping a stored record's object reads of the compiler. */
export interface HeldRecordContext extends RecordObservationContext {
    readonly bindings: Pick<BindingScopes, "recordHolder">;
    readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >;
    readonly parameterObjects: ReadonlySet<ts.ParameterDeclaration>;
    fail(node: ts.Node, message: string): never;
}

/**
 * A compile-time record stored where it stays one object: the binding that
 * holds it, itself or nested in its fields -- found by its members, whatever
 * node the store reads it from (a spread operand, a member, the name) --
 * takes native storage, a variable's or a parameter's object, so the store
 * keeps that object rather than a copy. `expression` is
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
    const declaration = context.bindings.recordHolder(value, expression);
    if (!declaration) return;
    // A parameter's record held as field storage has no object yet; the
    // store copies its fields unless the program could tell that copy from
    // the argument's object.
    if (ts.isParameter(declaration)) {
        if (
            !context.parameterObjects.has(declaration) &&
            storedCopyObservation(context, expression, declaration) !==
                undefined
        )
            demandOrPlan(new ParameterObjectStorageRequired(declaration));
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
