import ts from "typescript";
import type { DataType, DataTypeRegistry } from "./data-types.js";

/** The value a property declared `unknown` holds: a document. */
export function unknownPropertyValue(declared: ts.Type): DataType | undefined {
    return (declared.flags & ts.TypeFlags.Unknown) !== 0
        ? { kind: "json" }
        : undefined;
}

/**
 * The storage of a property the program adds to an object it does not
 * declare, holding `value`: absent until written.
 */
export function addedPropertyStorage(
    dataTypes: Pick<DataTypeRegistry, "markStoredObjectReferences">,
    value: DataType,
): DataType {
    return dataTypes.markStoredObjectReferences(
        value.kind === "optional"
            ? value
            : { kind: "optional", inner: value, undefinedOnly: true },
    );
}
