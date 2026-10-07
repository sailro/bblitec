import { dataTypesEqual, type DataType } from "./data-types.js";

/**
 * Arrays of a string literal union store its members as enum tags. One the
 * program also reads as a `string[]`, or as an array of a wider literal
 * union (a selection of several such arrays), at any array depth, would be
 * converted into a second array where JavaScript keeps one: the compile
 * replays with every array of those unions storing their members as
 * strings, so all the views are one array. Each union is named by its sorted
 * members (`DataTypeRegistry.enumLiterals`), which survive a replay where
 * the generated enum names may not.
 */
export class EnumArrayStorageRequired extends Error {
    constructor(readonly unions: readonly string[]) {
        super("Arrays of a literal union read as string arrays store strings.");
    }
}

/**
 * The literal unions (enum names) whose array elements must store strings
 * for `source` elements to be stored where `target` elements are, when
 * literal unions are the only difference between the two (through arrays
 * and optional lanes): a source union read as strings, a target union
 * holding strings, or both. An empty list when the types are equal, undefined when they
 * differ otherwise.
 */
export function enumsReadAsStrings(
    source: DataType,
    target: DataType,
): readonly string[] | undefined {
    if (dataTypesEqual(source, target)) return [];
    if (source.kind === "enum" && target.kind === "string")
        return [source.name];
    if (source.kind === "enum" && target.kind === "enum")
        return [source.name, target.name];
    if (source.kind === "string" && target.kind === "enum")
        return [target.name];
    if (source.kind === "optional" && target.kind === "optional")
        return enumsReadAsStrings(source.inner, target.inner);
    if (
        (source.kind === "vector" || source.kind === "span") &&
        (target.kind === "vector" || target.kind === "span")
    )
        return enumsReadAsStrings(source.element, target.element);
    return undefined;
}
