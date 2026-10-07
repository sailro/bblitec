import type ts from "typescript";
import type { RecordJoin } from "./record-components.js";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
    type: ts.Type;
    node: ts.Node;
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    /** Every field must retain a receiver-aware accessor slot. */
    proxy?: true;
    /**
     * Record types a record of this type was stored as where a copy could
     * be told apart: each joins this type's record component
     * (`record-components.ts`), so one object keeps one identity under both.
     */
    joins?: readonly Omit<RecordJoin, "source">[];
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
                        known.target === join.target &&
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
