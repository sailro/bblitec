/** JSON predicates and field reads shared by generation and tooling. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string =>
    typeof value === "string";
export const isNumber = (value: unknown): value is number =>
    typeof value === "number";
export const isFiniteNumber = (value: unknown): value is number =>
    isNumber(value) && Number.isFinite(value);
export const isBoolean = (value: unknown): value is boolean =>
    typeof value === "boolean";
export const isNonemptyString = (value: unknown): value is string =>
    isString(value) && value.trim() !== "";

export function arrayOf<T>(
    value: unknown,
    guard: (entry: unknown) => entry is T,
): value is T[] {
    return Array.isArray(value) && value.every(guard);
}
export function recordOf<T>(
    value: unknown,
    guard: (entry: unknown) => entry is T,
): value is Record<string, T> {
    return isRecord(value) && Object.values(value).every(guard);
}
export function jsonValue<T>(
    value: unknown,
    guard: (entry: unknown) => entry is T,
    message: string,
): T {
    if (!guard(value)) throw new Error(message);
    return value;
}
export function optionalJsonField<T>(
    record: JsonObject,
    key: string,
    guard: (entry: unknown) => entry is T,
    message: string,
): T | undefined {
    const value = record[key];
    return value === undefined ? undefined : jsonValue(value, guard, message);
}

/** A parsed JSON object — the shape every glTF document read shares. */
export type JsonObject = Record<string, unknown>;
/** The same type under the packagers' historical name. */
export type JsonRecord = JsonObject;

export const asObject = (value: unknown): JsonObject | undefined =>
    isRecord(value) ? value : undefined;

/**
 * The array's object entries, dropping everything else.
 *
 * `compressed-geometry.ts` keeps a cast-only variant on purpose: its chunk
 * rewriter trusts documents it just built, which is a different contract.
 */
export const asRecords = (value: unknown): JsonObject[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

export const asNumbers = (value: unknown): number[] | undefined =>
    arrayOf(value, isNumber) ? value : undefined;

export const asString = (value: unknown): string | undefined =>
    isString(value) ? value : undefined;

export const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter(isString) : [];
