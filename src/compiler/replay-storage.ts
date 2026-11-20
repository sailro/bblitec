import type ts from "typescript";
import type { CompileError } from "./compile-error.js";
import type { DataType } from "./data-types/model.js";
import { erasedFieldWidens } from "./data-types/operations.js";
import type { CompletionProof } from "./completion-storage.js";
import type { AbsenceTagDeclaration } from "./absence-tag-storage.js";
import type { InstanceProperty } from "./class-members.js";
import type { KeyOrders } from "./record-key-orders.js";
import type { EngineOwnerStorageDeclaration } from "./engine-owner-storage.js";
import type { ErasedHandleStorage } from "./asserted-handle-field-storage.js";
import type { DynamicBindingStorage } from "./dynamic-binding-storage.js";
import {
    GenericFunctionStorage,
    type GenericFunctionDemand,
} from "./generic-function-storage.js";
import {
    describeRecordDemand,
    mergeNativeRecordStorage,
    type NativeRecordStorageDemand,
} from "./native-record-storage.js";
import type {
    NumericSlotDeclaration,
    NumericSlotKind,
} from "./numeric-slot-storage.js";
import {
    isRecordComponentKey,
    recordComponents,
    recordIdentity,
    type InstantiatedRecord,
    type RecordJoin,
} from "./record-components.js";
import { sourceOrder } from "./syntax.js";

/** One storage demand a compile replays with. */
export type StorageRequest =
    | {
          kind: "dynamic";
          declaration: ts.VariableDeclaration;
          storage: DynamicBindingStorage | undefined;
      }
    | { kind: "record"; demand: NativeRecordStorageDemand }
    | {
          kind: "refused-record";
          demand: NativeRecordStorageDemand;
          refusal: CompileError;
      }
    | { kind: "generic"; demand: GenericFunctionDemand }
    | { kind: "absence-tag"; declaration: AbsenceTagDeclaration }
    | { kind: "class-field-presence"; declaration: InstanceProperty }
    | { kind: "engine-owner"; declaration: EngineOwnerStorageDeclaration }
    | {
          kind: "asserted-handle-field";
          declaration: ErasedHandleStorage;
          storage: DataType;
      }
    | { kind: "completion"; signatureSite: string; proof: CompletionProof }
    | { kind: "unproven-completion"; signatureSite: string }
    | {
          kind: "tuple-array";
          declaration: ts.PropertySignature | ts.PropertyDeclaration;
      }
    | {
          kind: "numeric-slot";
          declaration: NumericSlotDeclaration;
          numeric: NumericSlotKind;
      }
    | { kind: "parameter-object"; declaration: ts.ParameterDeclaration }
    | { kind: "enum-array"; unions: readonly string[] }
    | { kind: "enum-record"; schema: string }
    | {
          kind: "key-order";
          record: ts.Symbol | ts.Type;
          orders: KeyOrders;
      }
    | { kind: "thrown-value"; valueKind: "string" }
    | { kind: "shared-class"; declaration: ts.ClassLikeDeclaration };

/**
 * Where a storage request was demanded, for reports: the declaration it
 * retypes, the node a record demand rose at, or a signature site; nothing
 * for the program-wide kinds.
 */
export function storageRequestSite(
    request: StorageRequest,
): ts.Node | string | undefined {
    switch (request.kind) {
        case "record":
        case "refused-record":
            return request.demand.node;
        case "completion":
        case "unproven-completion":
            return request.signatureSite;
        case "generic":
        case "enum-array":
        case "enum-record":
        case "key-order":
        case "thrown-value":
            return undefined;
        default:
            return request.declaration;
    }
}

/** What storage requests ask for, for reports: each kind once, a record's with what it demands. */
export function describeStorageRequests(
    requests: readonly StorageRequest[],
): string {
    const counts = new Map<string, number>();
    for (const request of requests) {
        const asked =
            request.kind === "record"
                ? `record (${describeRecordDemand(request.demand)})`
                : request.kind;
        counts.set(asked, (counts.get(asked) ?? 0) + 1);
    }
    return [...counts]
        .map(([asked, count]) => (count > 1 ? `${asked} x${count}` : asked))
        .join("; ");
}

/**
 * The storage demands a compile replays with, keyed by the source each
 * belongs to. Emission replays and the discarded planner each hold one: the
 * planner's collects what its attempt met, the replay's is what every
 * compiler reads.
 */
export class ReplayStorage {
    /** @unjournaled Demands outlive the attempts that met them. */
    readonly dynamicBindings = new Map<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >();
    /** @unjournaled Demands outlive the attempts that met them. */
    readonly records = new Map<
        NativeRecordStorageDemand["identity"] | InstantiatedRecord,
        NativeRecordStorageDemand
    >();
    /**
     * @unjournaled Demands outlive the attempts that met them. Record demands no native object can
     * hold (`predeclareOwnedRecord` refused them): a statement demanding one again refuses.
     */
    readonly refusedRecords = new Map<
        NativeRecordStorageDemand["identity"] | InstantiatedRecord,
        CompileError
    >();
    /**
     * @unjournaled The record components the joins of {@link records} form,
     * until a record demand changes them (`joinsAlreadyHeld`).
     */
    private plannedComponents: ReturnType<typeof recordComponents> | undefined;
    readonly genericFunctions = new GenericFunctionStorage();
    /** @unjournaled Demands outlive the attempts that met them. Source storages that keep `null` and `undefined` apart (`DataType<"tagged">`). */
    readonly absenceTags = new Set<ts.Declaration>();
    /** @unjournaled Demands outlive the attempts that met them. Shared class fields that store whether they are present. */
    readonly classFieldPresence = new Set<ts.Declaration>();
    /** @unjournaled Resource storages whose reached uses require their actual engine. */
    readonly engineOwners = new Set<ts.Declaration>();
    /** @unjournaled Reached assertions settle erased resource field layouts before emission. */
    readonly assertedHandleFields = new Map<ts.Declaration, DataType>();
    /** @unjournaled Completion contracts are monotonic across replay attempts. */
    readonly completions = new Map<string, CompletionProof>();
    /** @unjournaled Demands outlive the attempts that met them. Signature sites whose own undefined completion a producer withdrew. */
    readonly unprovenCompletions = new Set<string>();
    /** @unjournaled Demands outlive the attempts that met them. Record parameters holding their argument as one object. */
    readonly parameterObjects = new Set<ts.ParameterDeclaration>();
    /** @unjournaled Demands outlive the attempts that met them. Record properties storing their numeric tuples as growable arrays. */
    readonly tupleArraySlots = new Set<ts.Declaration>();
    /** @unjournaled Demands outlive the attempts that met them. `ArrayLike<number>` slots retyped for the numeric arrays they store. */
    readonly numericSlots = new Map<ts.Declaration, Set<NumericSlotKind>>();
    /**
     * @unjournaled Demands outlive the attempts that met them. String literal unions (`enumLiterals`) whose
     * arrays store their members as strings (`EnumArrayStorageRequired`).
     */
    readonly stringElementUnions = new Set<string>();
    /** @unjournaled Finite-key record schemas whose enumeration requires dictionary order. */
    readonly orderedRecordSchemas = new Set<string>();
    /**
     * @unjournaled Demands outlive the attempts that met them. The own-key
     * orders an enumerated record type's records take, by record identity,
     * as the last attempt to find them did (`RecordKeyOrderRequired`): an
     * earlier attempt may have read a source's fields in a layout since
     * reordered.
     */
    readonly recordKeyOrders = new Map<ts.Symbol | ts.Type, KeyOrders>();
    /** @unjournaled Every set of orders demanded for a record type, spelled (`spellKeyOrders`). */
    private readonly keyOrderSpellings = new Map<
        ts.Symbol | ts.Type,
        Set<string>
    >();
    /** @unjournaled Reached primitive throws require dynamic catch storage across call boundaries. */
    readonly thrownValueKinds = new Set<"string">();
    /** @unjournaled Classes shared from their first construction. */
    readonly sharedClasses = new Set<ts.ClassLikeDeclaration>();

    /**
     * @unjournaled What this storage took since the running attempt began
     * (`beginAttempt`): the declarations its demands retype and the literal
     * unions it gave string element storage. A survey pass takes demands as
     * it lowers, so what it bound or laid out before one predates that
     * storage.
     */
    private readonly takenSinceAttempt = new Set<ts.Declaration | string>();

    public constructor(private readonly checker: ts.TypeChecker) {}

    /** An attempt begins lowering with the storage this holds now. */
    public beginAttempt(): void {
        this.takenSinceAttempt.clear();
    }

    /**
     * Whether this storage took `taken`, a declaration's demand or a literal
     * union's string element storage, while the running attempt lowered.
     */
    public takenDuringAttempt(taken: ts.Declaration | string): boolean {
        return this.takenSinceAttempt.has(taken);
    }

    /** A record component's members demand apart: their shared key is renumbered as joins grow. */
    private recordKey(
        demand: NativeRecordStorageDemand,
    ): NativeRecordStorageDemand["identity"] | InstantiatedRecord {
        return (
            demand.instantiation ??
            (isRecordComponentKey(demand.identity)
                ? recordIdentity(this.checker, demand.type)
                : demand.identity)
        );
    }

    /** The refusal a demand for a record no native object can hold stands for. */
    public refusedRecord(
        demand: NativeRecordStorageDemand,
    ): CompileError | undefined {
        return this.refusedRecords.get(this.recordKey(demand));
    }

    /** Adds what `request` demands; false when this storage already holds it. */
    public add(request: StorageRequest): boolean {
        const unions =
            request.kind === "enum-array"
                ? request.unions.filter(
                      (union) => !this.stringElementUnions.has(union),
                  )
                : [];
        const added = this.addRequest(request);
        if (added && "declaration" in request)
            this.takenSinceAttempt.add(request.declaration);
        for (const union of unions) this.takenSinceAttempt.add(union);
        return added;
    }

    private addRequest(request: StorageRequest): boolean {
        switch (request.kind) {
            case "dynamic": {
                const known = this.dynamicBindings.get(request.declaration);
                // A callback binding's record of callables, and an array
                // binding's elements, refine the storage it holds.
                const upgrade =
                    typeof request.storage === "object" &&
                    ((known === "callback" && "callable" in request.storage) ||
                        (known === "array" && "elements" in request.storage));
                if (
                    this.dynamicBindings.has(request.declaration) &&
                    !upgrade &&
                    (known || !request.storage)
                )
                    return false;
                this.dynamicBindings.set(request.declaration, request.storage);
                return true;
            }
            case "refused-record": {
                const key = this.recordKey(request.demand);
                if (this.refusedRecords.has(key)) return false;
                this.records.delete(key);
                this.plannedComponents = undefined;
                this.refusedRecords.set(key, request.refusal);
                return true;
            }
            case "record": {
                const key = this.recordKey(request.demand);
                if (this.refusedRecords.has(key)) return false;
                const known = this.records.get(key);
                const merged = mergeNativeRecordStorage(known, request.demand);
                // A record keeps the site its source spells first, and the
                // type and frames it was demanded in there, whichever attempt
                // met it first.
                const site =
                    known && sourceOrder(known.node, request.demand.node) <= 0
                        ? known
                        : request.demand;
                if (!merged) {
                    if (known && site !== known)
                        this.records.set(key, {
                            ...known,
                            ...recordSite(site),
                        });
                    return false;
                }
                this.records.set(key, { ...merged, ...recordSite(site) });
                this.plannedComponents = undefined;
                return true;
            }
            case "generic":
                return this.genericFunctions.add(request.demand);
            case "absence-tag":
                return addNew(this.absenceTags, request.declaration);
            case "class-field-presence":
                return addNew(this.classFieldPresence, request.declaration);
            case "engine-owner":
                return addNew(this.engineOwners, request.declaration);
            case "asserted-handle-field": {
                // A nullable use widens a field a present one settled.
                const known = this.assertedHandleFields.get(
                    request.declaration,
                );
                if (known && !erasedFieldWidens(known, request.storage))
                    return false;
                this.assertedHandleFields.set(
                    request.declaration,
                    request.storage,
                );
                return true;
            }
            case "completion": {
                const known = this.completions.get(request.signatureSite);
                // A fresh array is never thenable.
                if (
                    known === "undefined" ||
                    known === request.proof ||
                    (known === "fresh" && request.proof === "nonthenable")
                )
                    return false;
                this.completions.set(request.signatureSite, request.proof);
                return true;
            }
            case "unproven-completion":
                return addNew(this.unprovenCompletions, request.signatureSite);
            case "tuple-array":
                return addNew(this.tupleArraySlots, request.declaration);
            case "parameter-object":
                return addNew(this.parameterObjects, request.declaration);
            case "numeric-slot": {
                const kinds = this.numericSlots.get(request.declaration);
                if (kinds) return addNew(kinds, request.numeric);
                this.numericSlots.set(
                    request.declaration,
                    new Set([request.numeric]),
                );
                return true;
            }
            case "enum-array":
                return request.unions.reduce(
                    (added, union) =>
                        addNew(this.stringElementUnions, union) || added,
                    false,
                );
            case "enum-record":
                return addNew(this.orderedRecordSchemas, request.schema);
            case "key-order": {
                // Orders demanded once already would replay in a cycle.
                if (this.demandedKeyOrders(request.record, request.orders))
                    return false;
                const spellings =
                    this.keyOrderSpellings.get(request.record) ??
                    new Set<string>();
                this.keyOrderSpellings.set(
                    request.record,
                    spellings.add(spellKeyOrders(request.orders)),
                );
                this.recordKeyOrders.set(request.record, request.orders);
                return true;
            }
            case "thrown-value":
                return addNew(this.thrownValueKinds, request.valueKind);
            case "shared-class":
                return addNew(this.sharedClasses, request.declaration);
        }
    }

    /** Whether `orders` were demanded for record type `record` before (`RecordKeyOrderRequired`). */
    public demandedKeyOrders(
        record: ts.Symbol | ts.Type,
        orders: KeyOrders,
    ): boolean {
        return (
            this.keyOrderSpellings.get(record)?.has(spellKeyOrders(orders)) ===
            true
        );
    }

    /**
     * The record demands this storage holds, in an order of the program
     * alone (`recordOrder`): a compile lays their records out in it,
     * whatever order the attempts that met them took them in.
     */
    public orderedRecords(): readonly NativeRecordStorageDemand[] {
        const spelled = typeSpeller(this.checker);
        return [...this.records.values()].sort((left, right) =>
            recordOrder(spelled, left, right),
        );
    }

    /** The joins of `records` ({@link orderedRecords}), each record's in `joinOrder`. */
    public orderedJoins(
        records: readonly NativeRecordStorageDemand[],
    ): readonly RecordJoin[] {
        const spelled = typeSpeller(this.checker);
        return records.flatMap((demand) =>
            [...(demand.joins ?? [])].sort((left, right) =>
                joinOrder(spelled, left, right),
            ),
        );
    }

    /** The dynamic bindings this storage holds, in source order of their declarations. */
    public sourceOrderedDynamicBindings(): readonly (readonly [
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined,
    ])[] {
        return [...this.dynamicBindings].sort(([left], [right]) =>
            sourceOrder(left, right),
        );
    }

    /**
     * Whether a planned record request only joins types that one record
     * component already holds: a strict attempt, which stores such records
     * in that component's layout, never demands it.
     */
    public joinsAlreadyHeld(request: StorageRequest): boolean {
        if (request.kind !== "record" || !request.demand.joins?.length)
            return false;
        const components = (this.plannedComponents ??= recordComponents(
            this.checker,
            [...this.records.values()].flatMap((demand) => demand.joins ?? []),
        ));
        const component = (type: ts.Type, instantiation?: InstantiatedRecord) =>
            components.get(instantiation ?? recordIdentity(this.checker, type));
        return request.demand.joins.every(
            (join) =>
                component(join.source, join.sourceInstantiation) !==
                    undefined &&
                component(join.source, join.sourceInstantiation) ===
                    component(join.target, join.targetInstantiation),
        );
    }
}

/**
 * A request that only adds its key to a set: wherever lowering meets it,
 * it demands the same storage. Every other request carries what its site
 * found (a record's type, a binding's storage, a completion proof).
 */
export function demandsKeyOnly(request: StorageRequest): boolean {
    switch (request.kind) {
        case "absence-tag":
        case "class-field-presence":
        case "engine-owner":
        case "tuple-array":
        case "parameter-object":
        case "numeric-slot":
        case "enum-array":
        case "enum-record":
        case "thrown-value":
        case "shared-class":
        case "unproven-completion":
            return true;
        default:
            return false;
    }
}

/** A set of key orders as one string, whatever order it lists them in. */
function spellKeyOrders(orders: KeyOrders): string {
    return JSON.stringify(orders.map((order) => JSON.stringify(order)).sort());
}

/**
 * A request whose storage its key and source types name: a key's
 * (`demandsKeyOnly`), a record type's, a binding's named storage. Every
 * other request carries a data type or proof its site lowered (a binding's
 * element or native storage, a record's native owner, a generic signature,
 * a completion proof, an asserted field's storage).
 */
export function demandsSourceStorage(request: StorageRequest): boolean {
    if (demandsKeyOnly(request)) return true;
    switch (request.kind) {
        case "record":
        case "refused-record":
            return request.demand.native === undefined;
        case "dynamic":
            return typeof request.storage !== "object";
        default:
            return false;
    }
}

/** Orders two strings by code unit, the same on every machine. */
function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Where a record type is declared: its alias's, else its own symbol's first declaration. */
function typeDeclaration(type: ts.Type): ts.Node | undefined {
    return (
        type.aliasSymbol?.declarations?.[0] ??
        type.getSymbol()?.declarations?.[0]
    );
}

/** The checker's spelling of a type, spelled once per type for one sort. */
function typeSpeller(checker: ts.TypeChecker): (type: ts.Type) => string {
    const spellings = new Map<ts.Type, string>();
    return (type) => {
        let spelling = spellings.get(type);
        if (spelling === undefined) {
            spelling = checker.typeToString(type);
            spellings.set(type, spelling);
        }
        return spelling;
    };
}

/** Orders two record types by declaration, then as `spelled` spells them. */
function typeOrder(
    spelled: (type: ts.Type) => string,
    left: ts.Type,
    right: ts.Type,
): number {
    if (left === right) return 0;
    return (
        sourceOrder(typeDeclaration(left), typeDeclaration(right)) ||
        compareText(spelled(left), spelled(right))
    );
}

/** Where and as what a record demand was met: the fields its site decides. */
function recordSite(
    demand: NativeRecordStorageDemand,
): Pick<NativeRecordStorageDemand, "identity" | "type" | "node" | "frames"> {
    return {
        identity: demand.identity,
        type: demand.type,
        node: demand.node,
        frames: demand.frames,
    };
}

/**
 * Orders record demands for predeclaration. A joined component's struct is
 * mapped once, by the first of its records predeclared, so the order is
 * part of the layout: a record its source spells without type arguments
 * comes before instantiations, which resolve through such records, and a
 * record stored with its declared functions (`stored`) before one mapped
 * without them; then by the site the source spells first, then by type.
 */
function recordOrder(
    spelled: (type: ts.Type) => string,
    left: NativeRecordStorageDemand,
    right: NativeRecordStorageDemand,
): number {
    return (
        Number(instantiated(left)) - Number(instantiated(right)) ||
        Number(!left.stored) - Number(!right.stored) ||
        sourceOrder(left.node, right.node) ||
        typeOrder(spelled, left.type, right.type)
    );
}

/** Whether a record demand resolves its type through type-argument frames. */
function instantiated(demand: NativeRecordStorageDemand): boolean {
    return demand.frames.some((frame) => frame.size > 0);
}

/** Orders joins by source type, then target type, then kind. */
function joinOrder(
    spelled: (type: ts.Type) => string,
    left: RecordJoin,
    right: RecordJoin,
): number {
    return (
        typeOrder(spelled, left.source, right.source) ||
        typeOrder(spelled, left.target, right.target) ||
        compareText(left.kind, right.kind)
    );
}

function addNew<T>(set: Set<T>, value: T): boolean {
    if (set.has(value)) return false;
    set.add(value);
    return true;
}
