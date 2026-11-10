import type ts from "typescript";
import type { CompileError } from "./compile-error.js";
import type { DataType } from "./data-types/model.js";
import { erasedFieldWidens } from "./data-types/operations.js";
import type { CompletionProof } from "./completion-storage.js";
import type { AbsenceTagDeclaration } from "./absence-tag-storage.js";
import type { InstanceProperty } from "./class-members.js";
import type { EngineOwnerStorageDeclaration } from "./engine-owner-storage.js";
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
} from "./record-components.js";

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
          declaration: ts.PropertySignature | ts.PropertyDeclaration;
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
        case "thrown-value":
            return undefined;
        default:
            return request.declaration;
    }
}

/** What a request asks for and where, one text for every request that asks it there. */
export function storageRequestKey(request: StorageRequest): string {
    const site = storageRequestSite(request);
    const where =
        site === undefined
            ? ""
            : typeof site === "string"
              ? site
              : `${site.getSourceFile().fileName}:${site.getStart()}`;
    return `${describeStorageRequests([request])}@${where}`;
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
    /** @unjournaled Reached primitive throws require dynamic catch storage across call boundaries. */
    readonly thrownValueKinds = new Set<"string">();
    /** @unjournaled Classes shared from their first construction. */
    readonly sharedClasses = new Set<ts.ClassLikeDeclaration>();

    public constructor(private readonly checker: ts.TypeChecker) {}

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

    /**
     * What this storage holds now: the returned function puts it back,
     * withdrawing every demand added since.
     */
    public snapshot(): () => void {
        const map = <K, V>(held: Map<K, V>): (() => void) => {
            const entries = [...held];
            return () => {
                held.clear();
                for (const [key, value] of entries) held.set(key, value);
            };
        };
        const set = <T>(held: Set<T>): (() => void) => {
            const values = [...held];
            return () => {
                held.clear();
                for (const value of values) held.add(value);
            };
        };
        const numeric = [...this.numericSlots].map(
            ([declaration, kinds]) => [declaration, [...kinds]] as const,
        );
        const restores = [
            map(this.dynamicBindings),
            map(this.records),
            map(this.refusedRecords),
            this.genericFunctions.snapshot(),
            set(this.absenceTags),
            set(this.classFieldPresence),
            set(this.engineOwners),
            map(this.assertedHandleFields),
            map(this.completions),
            set(this.unprovenCompletions),
            set(this.parameterObjects),
            set(this.tupleArraySlots),
            () => {
                this.numericSlots.clear();
                for (const [declaration, kinds] of numeric)
                    this.numericSlots.set(declaration, new Set(kinds));
            },
            set(this.stringElementUnions),
            set(this.orderedRecordSchemas),
            set(this.thrownValueKinds),
            set(this.sharedClasses),
        ];
        return () => {
            for (const restore of restores) restore();
        };
    }

    /** Adds what `request` demands; false when this storage already holds it. */
    public add(request: StorageRequest): boolean {
        switch (request.kind) {
            case "dynamic": {
                const known = this.dynamicBindings.get(request.declaration);
                const callableUpgrade =
                    known === "callback" &&
                    typeof request.storage === "object" &&
                    "callable" in request.storage;
                if (
                    this.dynamicBindings.has(request.declaration) &&
                    !callableUpgrade &&
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
                this.refusedRecords.set(key, request.refusal);
                return true;
            }
            case "record": {
                const key = this.recordKey(request.demand);
                if (this.refusedRecords.has(key)) return false;
                const merged = mergeNativeRecordStorage(
                    this.records.get(key),
                    request.demand,
                );
                if (!merged) return false;
                this.records.set(key, merged);
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
            case "thrown-value":
                return addNew(this.thrownValueKinds, request.valueKind);
            case "shared-class":
                return addNew(this.sharedClasses, request.declaration);
        }
    }

    /**
     * Whether a planned record request only joins types that one record
     * component already holds: a strict attempt, which stores such records
     * in that component's layout, never demands it.
     */
    public joinsAlreadyHeld(request: StorageRequest): boolean {
        if (request.kind !== "record" || !request.demand.joins?.length)
            return false;
        const components = recordComponents(
            this.checker,
            [...this.records.values()].flatMap((demand) => demand.joins ?? []),
        );
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

function addNew<T>(set: Set<T>, value: T): boolean {
    if (set.has(value)) return false;
    set.add(value);
    return true;
}
