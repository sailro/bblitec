/** A stored callback's observed completion must be checked at every producer. */
export type CompletionProof = "undefined" | "nonthenable";

export class CompletionStorageRequired extends Error {
    constructor(
        readonly signatureSite: string,
        readonly proof: CompletionProof,
    ) {
        super("A stored callback requires a proven completion.");
    }
}
