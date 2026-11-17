import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
import type ts from "typescript";
import type { DataType } from "./data-types/model.js";

/** Erased storage a native handle can settle: a record field or a parameter. */
export type ErasedHandleStorage =
    ts.PropertySignature | ts.PropertyDeclaration | ts.ParameterDeclaration;

/** An erased field or parameter whose reached use requires native resource storage. */
export class AssertedHandleFieldStorageRequired extends StorageDemand {
    constructor(
        readonly declaration: ErasedHandleStorage,
        readonly storage: DataType,
    ) {
        super("An asserted resource field must retain its native handle.");
    }

    get request(): StorageRequest {
        return {
            kind: "asserted-handle-field",
            declaration: this.declaration,
            storage: this.storage,
        };
    }
}
