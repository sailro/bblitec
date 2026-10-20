/**
 * A finite-key Record whose own order is observed needs dictionary storage
 * when its producer's order is not known at the read. The sorted literal
 * schema names the demand across replays and across readonly views.
 */
export class EnumRecordStorageRequired extends Error {
    constructor(readonly schema: string) {
        super("Enumerated finite-key records retain their own property order.");
    }
}
