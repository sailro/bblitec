import type ts from "typescript";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
    type: ts.Type;
    node: ts.Node;
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
}

/** Re-emit earlier storage and aliases after a dynamic boundary demands ownership. */
export class NativeRecordStorageRequired extends Error {
    constructor(readonly demand: NativeRecordStorageDemand) {
        super("A native record requires shared object storage.");
    }
}
