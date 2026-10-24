import type { StorageRequest } from "./replay-storage.js";

/**
 * A lowering met storage the compile has not planned: the compile replays
 * with the storage `request` names.
 */
export abstract class StorageDemand extends Error {
    abstract get request(): StorageRequest;
}
