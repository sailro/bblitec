import type ts from "typescript";
import type { InstantiatedRecord, RecordJoin } from "./record-components.js";
import type { DataType } from "./data-types/model.js";
import { dataTypesEqual } from "./data-types/operations.js";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
    /** Stable identity when a generic source is mapped under concrete arguments. */
    instantiation?: InstantiatedRecord;
    type: ts.Type;
    node: ts.Node;
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    /** Mapped where the record is stored, its declared functions too (`fromStoredTsType`). */
    stored?: true;
    /** Mapped where `unknown` values are stored as JSON (`withDynamicJsonTypes`). */
    dynamicJsonStorage?: true;
    /** Every field must retain a receiver-aware accessor slot. */
    proxy?: true;
    /**
     * Records of this type are parsed documents the program reads as it:
     * every value of the type is stored as a document, which keeps the
     * object's own fields and identity.
     */
    document?: true;
    /** A plain fixed record stored as a homogeneous open scalar dictionary. */
    dictionary?: "string" | "number" | "boolean";
    /** One retained record cannot change its dictionary value representation. */
    dictionaryConflict?: true;
    /** A structural interface retains the native owner whose checked type supplies it. */
    native?: {
        readonly type: ts.Type;
        readonly node: ts.Node;
        readonly storage: DataType;
    };
    /** Distinct checked native owners cannot overwrite one structural demand. */
    nativeConflict?: true;
    /** A function can enter this callable record before any named property is installed. */
    bareCallable?: true;
    /**
     * Record types a record was stored as where a copy could be told apart:
     * each joins its source's record component (`record-components.ts`), so
     * one object keeps one identity under both. A join names its own
     * source, which replays merging demands of one struct keep.
     */
    joins?: readonly RecordJoin[];
    /**
     * Properties a record converted into this type defines with accessors (a
     * class getter, and setter): its struct holds each in an accessor slot.
     */
    accessors?: readonly RecordAccessorDemand[];
    /**
     * A union whose records hold fields only some members declare: its
     * struct stores every member's fields rather than their common view.
     */
    armFields?: true;
    /**
     * A closed record type an open string-keyed record is converted into:
     * it is a view of that record (one object), its slots its entries.
     */
    view?: true;
}

/** A property a converted record reads through a getter, and writes through a setter. */
export interface RecordAccessorDemand {
    readonly name: string;
    readonly setter: boolean;
    /** A property definition installs an own accessor, not a class prototype accessor. */
    readonly own?: true;
}

/** The demand flags a replay strengthens, never weakens. */
const RECORD_STORAGE_FLAGS = [
    "stored",
    "dynamicJsonStorage",
    "proxy",
    "document",
    "armFields",
    "view",
    "nativeConflict",
    "dictionaryConflict",
    "bareCallable",
] as const;

/**
 * Replays strengthen ownership and accumulate the joins and accessors
 * lowering met: `previous` merged with `next`, or undefined when `next`
 * demands nothing `previous` lacks.
 */
export function mergeNativeRecordStorage(
    previous: NativeRecordStorageDemand | undefined,
    next: NativeRecordStorageDemand,
): NativeRecordStorageDemand | undefined {
    const nativeConflict =
        previous?.nativeConflict ||
        next.nativeConflict ||
        (previous?.native !== undefined &&
            next.native !== undefined &&
            !dataTypesEqual(previous.native.storage, next.native.storage));
    const dictionaryConflict =
        previous?.dictionaryConflict ||
        next.dictionaryConflict ||
        (previous?.dictionary !== undefined &&
            next.dictionary !== undefined &&
            previous.dictionary !== next.dictionary);
    const added = (next.joins ?? []).filter(
        (join) =>
            !(previous?.joins ?? []).some(
                (known) =>
                    known.source === join.source &&
                    known.target === join.target &&
                    known.sourceInstantiation === join.sourceInstantiation &&
                    known.targetInstantiation === join.targetInstantiation &&
                    known.kind === join.kind,
            ),
    );
    const joins = [...(previous?.joins ?? []), ...added];
    const accessors = new Map(
        (previous?.accessors ?? []).map((accessor) => [
            accessor.name,
            accessor,
        ]),
    );
    let changed =
        previous === undefined ||
        added.length > 0 ||
        (nativeConflict && !previous?.nativeConflict) ||
        (dictionaryConflict && !previous?.dictionaryConflict) ||
        (next.dictionary !== undefined && previous?.dictionary === undefined) ||
        (next.native !== undefined && previous?.native === undefined) ||
        RECORD_STORAGE_FLAGS.some((flag) => next[flag] && !previous[flag]);
    for (const { name, setter, own } of next.accessors ?? []) {
        const known = accessors.get(name);
        if (
            known === undefined ||
            (setter && !known.setter) ||
            (!own && known.own)
        )
            changed = true;
        accessors.set(name, {
            name,
            setter: setter || known?.setter === true,
            ...(own && (!known || known.own) ? { own: true } : {}),
        });
    }
    if (!changed) return undefined;
    return {
        ...previous,
        ...next,
        ...(previous?.native ? { native: previous.native } : {}),
        ...(previous?.dictionary ? { dictionary: previous.dictionary } : {}),
        ...(nativeConflict ? { nativeConflict: true } : {}),
        ...(dictionaryConflict ? { dictionaryConflict: true } : {}),
        ...(joins.length ? { joins } : {}),
        ...(accessors.size
            ? {
                  accessors: [...accessors.values()],
              }
            : {}),
    };
}

/** Re-emit earlier storage and aliases after a dynamic boundary demands ownership. */
export class NativeRecordStorageRequired extends Error {
    constructor(readonly demand: NativeRecordStorageDemand) {
        super("A native record requires shared object storage.");
    }
}
