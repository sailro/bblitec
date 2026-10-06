import type ts from "typescript";
import { CompileError } from "./compile-error.js";

/** The source type and generic environment that produced a native record. */
export interface NativeRecordStorageDemand {
    identity: ts.Symbol | ts.Type | string;
    type: ts.Type;
    node: ts.Node;
    frames: readonly ReadonlyMap<ts.Symbol, ts.Type>[];
    /** Every field must retain a receiver-aware accessor slot. */
    proxy?: true;
    /**
     * Records of this type are constructed in this type's layout: a union or a
     * record type they were converted into, or the record type a view of them
     * was converted from. One object then keeps one identity under both types.
     */
    layout?: ts.Type;
}

/** Replays strengthen ownership without replacing an already chosen layout. */
export function mergeNativeRecordStorage(
    previous: NativeRecordStorageDemand | undefined,
    next: NativeRecordStorageDemand,
): NativeRecordStorageDemand {
    if (previous?.layout && next.layout && previous.layout !== next.layout) {
        const file = next.node.getSourceFile();
        const position = file.getLineAndCharacterOfPosition(
            next.node.getStart(file),
        );
        throw new CompileError(
            file.fileName,
            position.line + 1,
            position.character + 1,
            "A retained record has conflicting shared storage layouts.",
            "unsupported",
            next.node,
        );
    }
    return { ...previous, ...next };
}

/** Re-emit earlier storage and aliases after a dynamic boundary demands ownership. */
export class NativeRecordStorageRequired extends Error {
    constructor(readonly demand: NativeRecordStorageDemand) {
        super("A native record requires shared object storage.");
    }
}
