import type { StorageRequest } from "./replay-storage.js";

/**
 * A lowering met storage the compile has not planned: the compile replays
 * with the storage `request` names, and with every demand of the same kind
 * one lowering met alongside it (`joinedWith`).
 */
export abstract class StorageDemand extends Error {
    /** @unjournaled A thrown demand's own list, never compiler state. */
    private joined: readonly StorageDemand[] = [];

    abstract get request(): StorageRequest;

    get requests(): readonly StorageRequest[] {
        return [
            this.request,
            ...this.joined.flatMap((demand) => demand.requests),
        ];
    }

    /**
     * This demand with `others` of its kind, planned by one replay: a new
     * demand of this one's class, which leaves this one and `others` as
     * they were, so a demand joined with one that holds it is no cycle.
     */
    joinedWith(others: readonly this[]): this {
        // The same class and own fields; a subclass's constructor would ask
        // again for what this demand already carries.
        const joined = Object.create(
            Object.getPrototypeOf(this) as object,
            Object.getOwnPropertyDescriptors(this),
        ) as this;
        joined.joined = [...this.joined, ...others];
        return joined;
    }
}
