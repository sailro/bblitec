import type ts from "typescript";
import type { AbsenceTagDeclaration } from "./absence-tag-storage.js";
import type { EngineOwnerStorageDeclaration } from "./engine-owner-storage.js";
import type { DynamicBindingStorage } from "./dynamic-binding-storage.js";
import {
    GenericFunctionStorage,
    type GenericFunctionDemand,
} from "./generic-function-storage.js";
import {
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
    | { kind: "generic"; demand: GenericFunctionDemand }
    | { kind: "absence-tag"; declaration: AbsenceTagDeclaration }
    | { kind: "engine-owner"; declaration: EngineOwnerStorageDeclaration }
    | {
          kind: "tuple-array";
          declaration: ts.PropertySignature | ts.PropertyDeclaration;
      }
    | {
          kind: "numeric-slot";
          declaration: NumericSlotDeclaration;
          numeric: NumericSlotKind;
      }
    | { kind: "enum-array"; unions: readonly string[] };

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
    readonly genericFunctions = new GenericFunctionStorage();
    /** @unjournaled Demands outlive the attempts that met them. Source storages that keep `null` and `undefined` apart (`DataType<"tagged">`). */
    readonly absenceTags = new Set<ts.Declaration>();
    /** @unjournaled Resource storages whose reached uses require their actual engine. */
    readonly engineOwners = new Set<ts.Declaration>();
    /** @unjournaled Demands outlive the attempts that met them. Record properties storing their numeric tuples as growable arrays. */
    readonly tupleArraySlots = new Set<ts.Declaration>();
    /** @unjournaled Demands outlive the attempts that met them. `ArrayLike<number>` slots retyped for the numeric arrays they store. */
    readonly numericSlots = new Map<ts.Declaration, Set<NumericSlotKind>>();
    /**
     * @unjournaled Demands outlive the attempts that met them. String literal unions (`enumLiterals`) whose
     * arrays store their members as strings (`EnumArrayStorageRequired`).
     */
    readonly stringElementUnions = new Set<string>();

    public constructor(private readonly checker: ts.TypeChecker) {}

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
            case "record": {
                // A record component's members demand apart: their shared
                // key is renumbered as joins grow.
                const key =
                    request.demand.instantiation ??
                    (isRecordComponentKey(request.demand.identity)
                        ? recordIdentity(this.checker, request.demand.type)
                        : request.demand.identity);
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
            case "engine-owner":
                return addNew(this.engineOwners, request.declaration);
            case "tuple-array":
                return addNew(this.tupleArraySlots, request.declaration);
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

function addNew<T>(set: Set<T>, value: T): boolean {
    if (set.has(value)) return false;
    set.add(value);
    return true;
}
