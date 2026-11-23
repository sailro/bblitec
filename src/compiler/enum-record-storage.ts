import type ts from "typescript";
import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
/**
 * A finite-key Record whose own order is observed needs dictionary storage
 * when its producer's order is not known at the read. The sorted literal
 * schema names the demand across replays and across readonly views.
 */
export class EnumRecordStorageRequired extends StorageDemand {
    constructor(readonly schema: string) {
        super("Enumerated finite-key records retain their own property order.");
    }

    get request(): StorageRequest {
        return { kind: "enum-record", schema: this.schema };
    }
}

/**
 * A finite-key Record stored as a struct whose fields are its keys, each of
 * its value type: the record is stored as that struct, so a record of the
 * key union and the struct are one object. The schema names the record type
 * (`keyRecordSchema`); the struct type is read where it was demanded.
 */
export class KeyRecordStructRequired extends StorageDemand {
    constructor(
        readonly schema: string,
        readonly struct: { readonly type: ts.Type; readonly node: ts.Node },
    ) {
        super(
            "A finite-key record stored as a struct takes that struct's storage.",
        );
    }

    get request(): StorageRequest {
        return {
            kind: "struct-record",
            schema: this.schema,
            struct: this.struct,
        };
    }
}
