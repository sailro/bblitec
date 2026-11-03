import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
/**
 * A stored callback's observed completion must be checked at every producer:
 * undefined, nonthenable, or fresh (a new array no other reference holds).
 */
export type CompletionProof = "undefined" | "nonthenable" | "fresh";

/**
 * A stored callback slot claims a completion from its own source (undefined,
 * nonthenable), and one of its producers cannot prove it: the claims are
 * withdrawn, so only a read of a call's result through the slot refuses.
 */
export class UnprovenCompletionRequired extends StorageDemand {
    constructor(readonly signatureSite: string) {
        super("A stored callback's producers do not all prove its completion.");
    }

    get request(): StorageRequest {
        return {
            kind: "unproven-completion",
            signatureSite: this.signatureSite,
        };
    }
}

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
