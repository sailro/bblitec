import { isOpaqueReference } from "./data-types/operations.js";
import type { DataType } from "./data-types/model.js";
import type { Value } from "./types.js";

/** Method-bearing records can expose an already represented owning handle. */
export function isNativeOwnerRecord(
    value: Value,
): value is Value & { kind: "record"; dataType: DataType } {
    return (
        value.kind === "record" &&
        value.cpp !== "" &&
        isOpaqueReference(value.dataType)
    );
}
