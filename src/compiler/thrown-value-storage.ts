/** Reached primitive throws require catch bindings to retain their value kind. */
export class ThrownValueStorageRequired extends Error {
    constructor(readonly kind: "string") {
        super("Catch bindings retain primitive thrown values.");
    }
}
