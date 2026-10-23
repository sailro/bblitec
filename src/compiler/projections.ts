/**
 * The path algebra the alias and effect analyses share: a key path into a
 * value, `*` matching any key ({@link keysMayMatch}), and what a value holds
 * of a tracked object as it is read, nested and computed from.
 */
import { ANY_KEY, aliasKey, keysMayMatch, type PatternRead } from "./syntax.js";

/** Keys from a value to one of its members. */
export type KeyPath = readonly string[];

/**
 * What a value holds of a tracked object: the object at `from` sits at `at`
 * inside the value (`at` empty: the value is that object). A `derived`
 * value is computed from the object: it may be, or hold, any object at or
 * below `from`.
 */
export interface Projection {
    readonly at: KeyPath;
    readonly from: KeyPath;
    readonly derived: boolean;
}

/** Whether `path` begins with `prefix`. */
export function pathStartsWith(path: KeyPath, prefix: KeyPath): boolean {
    return (
        path.length >= prefix.length &&
        prefix.every((key, index) => keysMayMatch(key, path[index]!))
    );
}

/** Whether one path begins with the other: what they name may overlap. */
export function pathsOverlap(left: KeyPath, right: KeyPath): boolean {
    return pathStartsWith(left, right) || pathStartsWith(right, left);
}

/**
 * The deepest path an analysis keeps: a longer one is cut to its prefix,
 * which names an object holding what the full path names.
 */
const MAXIMUM_PATH = 6;

/** `path` cut to the deepest path an analysis keeps. */
export function boundedKeyPath(path: KeyPath): KeyPath {
    return path.length > MAXIMUM_PATH ? path.slice(0, MAXIMUM_PATH) : path;
}

/**
 * The projections of the value read at `key` inside a value holding
 * `values`. A member of a derived value is no member of its source at that
 * key: it may be any object below the source, as the value may.
 */
export function projectMember(
    values: readonly Projection[],
    key: string,
): Projection[] {
    return values.flatMap((value) =>
        value.at.length > 0
            ? keysMayMatch(value.at[0]!, key)
                ? [{ ...value, at: value.at.slice(1) }]
                : []
            : value.derived
              ? [value]
              : [{ ...value, from: boundedKeyPath([...value.from, key]) }],
    );
}

/** The projections of a container holding a value with `values` at `key`. */
export function nest(values: readonly Projection[], key: string): Projection[] {
    return values.map((value) => ({
        ...value,
        at: boundedKeyPath([key, ...value.at]),
    }));
}

/** A value computed from one holding `values`. */
export function derive(values: readonly Projection[]): Projection[] {
    return values.map((value) => ({
        at: [],
        from: value.from,
        derived: true,
    }));
}

/**
 * The projections one destructuring slot takes from a value holding
 * `values`: a member's, or for a rest a new collection of the members.
 */
export function slotProjections(
    values: readonly Projection[],
    read: PatternRead,
): Projection[] {
    return read.kind === "member"
        ? projectMember(values, aliasKey(read.key))
        : nest(projectMember(values, ANY_KEY), ANY_KEY);
}
