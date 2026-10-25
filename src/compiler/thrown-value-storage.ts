import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";

/** Reached primitive throws require catch bindings to retain their value kind. */
export class ThrownValueStorageRequired extends StorageDemand {
    constructor(readonly kind: "string") {
        super("Catch bindings retain primitive thrown values.");
    }

    get request(): StorageRequest {
        return { kind: "thrown-value", valueKind: this.kind };
    }
}
