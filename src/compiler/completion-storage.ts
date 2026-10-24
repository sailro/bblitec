import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
/** A stored callback's observed completion must be checked at every producer. */
export type CompletionProof = "undefined" | "nonthenable";

export class CompletionStorageRequired extends StorageDemand {
    constructor(
        readonly signatureSite: string,
        readonly proof: CompletionProof,
    ) {
        super("A stored callback requires a proven completion.");
    }

    get request(): StorageRequest {
        return {
            kind: "completion",
            signatureSite: this.signatureSite,
            proof: this.proof,
        };
    }
}
