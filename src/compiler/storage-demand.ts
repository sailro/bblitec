import type { StorageRequest } from "./replay-storage.js";

/**
 * A lowering met storage the compile has not planned: the compile replays
 * with the storage `request` names, and with every demand of the same kind
 * one lowering met alongside it (`joinedWith`).
 */
export abstract class StorageDemand extends Error {
    /** @unjournaled A thrown demand's own list, never compiler state. */
    private readonly joined: StorageDemand[] = [];

    abstract get request(): StorageRequest;

    get requests(): readonly StorageRequest[] {
        return [
            this.request,
            ...this.joined.flatMap((demand) => demand.requests),
        ];
    }

    /** This demand with `others` of its kind, planned by one replay. */
    joinedWith(others: readonly this[]): this {
        this.joined.push(...others);
        return this;
    }
}
