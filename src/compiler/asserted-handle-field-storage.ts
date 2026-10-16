import type ts from "typescript";
import type { DataType } from "./data-types/model.js";

/** An erased field whose reached assertion requires native resource storage. */
export class AssertedHandleFieldStorageRequired extends Error {
    constructor(
        readonly declaration: ts.PropertySignature | ts.PropertyDeclaration,
        readonly storage: DataType,
    ) {
        super("An asserted resource field must retain its native handle.");
    }
}
