import type { DataType, DataTypeRegistry } from "./data-types.js";
import type { Value } from "./types.js";

/** A callback's concrete storage when a checked predicate erased its source fields. */
export function representedResultType(
    dataTypes: Pick<DataTypeRegistry, "ownedRecordType">,
    value: Value,
    seen = new Set<Value>(),
): DataType | undefined {
    if (value.dataType) return value.dataType;
    if (
        value.kind === "number" ||
        value.kind === "string" ||
        value.kind === "boolean"
    )
        return { kind: value.kind };
    if (value.kind === "json-null")
        return { kind: value.cpp === "std::nullopt" ? "undefined" : "null" };
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
        if (value.kind === "tuple") {
            const elements: DataType[] = [];
            for (const element of value.tupleElements ?? []) {
                const type = representedResultType(dataTypes, element, seen);
                if (!type) return undefined;
                elements.push(type);
            }
            return elements.every((element) => element.kind === "number")
                ? { kind: "tuple", arity: elements.length }
                : { kind: "product", elements };
        }
        // Synthesized fields have no declaration from which to recover
        // method, accessor or own-presence storage.
        if (
            value.kind !== "record" ||
            Object.keys(value.recordMethods ?? {}).length > 0 ||
            Object.keys(value.recordGetters ?? {}).length > 0 ||
            Object.keys(value.recordSetters ?? {}).length > 0 ||
            value.classDeclaration
        )
            return undefined;
        const fields = [];
        for (const [sourceName, member] of Object.entries(
            value.recordProperties ?? {},
        )) {
            if (member.conditionalOwnKey) return undefined;
            const type = representedResultType(dataTypes, member, seen);
            if (!type) return undefined;
            fields.push({ sourceName, type });
        }
        return fields.length ? dataTypes.ownedRecordType(fields) : undefined;
    } finally {
        seen.delete(value);
    }
}
