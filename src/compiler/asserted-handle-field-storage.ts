import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
import type ts from "typescript";
import type { DataType } from "./data-types/model.js";

/** An erased field whose reached assertion requires native resource storage. */
export class AssertedHandleFieldStorageRequired extends StorageDemand {
    constructor(
        readonly declaration: ts.PropertySignature | ts.PropertyDeclaration,
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
