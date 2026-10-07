import type ts from "typescript";
import type { RecordJoin } from "./record-components.js";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
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
}

/** Replays strengthen ownership and accumulate the joins and accessors lowering met. */
export function mergeNativeRecordStorage(
    previous: NativeRecordStorageDemand | undefined,
    next: NativeRecordStorageDemand,
): NativeRecordStorageDemand {
    const joins = [
        ...(previous?.joins ?? []),
        ...(next.joins ?? []).filter(
            (join) =>
                !(previous?.joins ?? []).some(
                    (known) =>
                        known.source === join.source &&
                        known.target === join.target &&
                        known.targetInstantiation ===
                            join.targetInstantiation &&
                        known.kind === join.kind,
                ),
        ),
    ];
    const accessors = new Map<string, boolean>();
    for (const { name, setter } of [
        ...(previous?.accessors ?? []),
        ...(next.accessors ?? []),
    ])
        accessors.set(name, setter || accessors.get(name) === true);
    return {
        ...previous,
        ...next,
        ...(joins.length ? { joins } : {}),
        ...(accessors.size
            ? {
                  accessors: [...accessors].map(([name, setter]) => ({
                      name,
                      setter,
                  })),
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
