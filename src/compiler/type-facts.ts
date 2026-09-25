import ts from "typescript";
import { presenceFlagCpp, type Value } from "./values/model.js";

/** Scalars copy into callees; composites and unresolved types may alias. */
export function typeCanCarryReference(type: ts.Type): boolean {
    if (type.isUnion() || type.isIntersection())
        return type.types.some(typeCanCarryReference);
    const scalar =
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.Never;
    return (type.flags & scalar) === 0;
}

const ABSENT = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/**
 * The absent flags one member contributes: its own, or those of the parts of
 * an intersection the checker distributed one of them into (`S & undefined`,
 * from narrowing `S | null` past a null check).
 */
function absentFlags(member: ts.Type): number {
    const own = member.flags & ABSENT;
    if (own !== 0 || !member.isIntersection()) return own;
    return member.types.reduce(
        (flags, part) => flags | (part.flags & ABSENT),
        0,
    );
}

/**
 * The members of a type that stand for a present value: a union's members
 * less `null`, `undefined`, `void` and the intersections that distribute one
 * of them; any other type is its own single member unless it is itself
 * absent. The one statement of the nullable-union member rule.
 */
export function presentMembers(type: ts.Type): readonly ts.Type[] {
    return (type.isUnion() ? type.types : [type]).filter(
        (member) => absentFlags(member) === 0,
    );
}

/**
 * Whether a slot of this type -- a Map value, an array element, an object
 * field -- can hold `null` but never `undefined`: its absent content is
 * then `null`, so a missing slot is the only `undefined` a read yields.
 */
export function slotHoldsOnlyNull(type: ts.Type): boolean {
    const absent = nullability(type);
    return absent.null && !absent.undefined;
}

/**
 * Which JavaScript absent value a native absence is ({@link absenceKind}):
 * one of the two, a run-time answer from whether the read's slot existed
 * (a missing slot is `undefined`, a stored absence `null`), "either",
 * which the caller refuses because nothing says which one it is, or
 * "unconstrained" when the type names neither (`any`, or narrowed past
 * both), so only the native representation can say.
 */
export type Absence =
    | "undefined"
    | "null"
    | "either"
    | "unconstrained"
    | { readonly slotFoundCpp: string };

/**
 * The one rule for which absent value `value`, read at `node`, is when it
 * is absent -- for strict comparisons, text and `typeof` alike. The native
 * storage has one absent state, so the answer comes from what the value
 * records and what its type admits, in order:
 * - a read that records whether its slot existed (`Value.slotFoundCpp`)
 *   answers at run time;
 * - an unchecked lookup (`Value.preserveUncheckedLookup`) misses as
 *   `undefined`, unless its values may be `null` too ("either");
 * - a type that admits only `undefined` is `undefined`, only `null` is
 *   `null`, both is "either";
 * - a type that names neither leaves the representation to say: a
 *   presence flag marks a slot that is not there (`undefined`); otherwise
 *   "unconstrained" -- a comparison keeps its absence test, text spells
 *   what the optional holds, `typeof` answers "undefined".
 */
export function absenceKind(
    checker: ts.TypeChecker,
    value: Value,
    node: ts.Node,
): Absence {
    if (value.slotFoundCpp) return { slotFoundCpp: value.slotFoundCpp };
    const absent = nullability(checker.getTypeAtLocation(node));
    if (value.preserveUncheckedLookup)
        return absent.null ? "either" : "undefined";
    if (absent.null) return absent.undefined ? "either" : "null";
    if (absent.undefined) return "undefined";
    if (presenceFlagCpp(value) !== undefined) return "undefined";
    return "unconstrained";
}

/** Whether a type is a generic instantiation (`Map<K, V>`, `Array<T>`). */
export function isTypeReference(type: ts.Type): type is ts.TypeReference {
    return (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
    );
}

/**
 * The element type of an array-like type, or undefined for another type.
 */
export function arrayElementType(
    checker: ts.TypeChecker,
    type: ts.Type,
): ts.Type | undefined {
    return checker.getIndexTypeOfType(
        checker.getNonNullableType(type),
        ts.IndexKind.Number,
    );
}

/** Which absent values a type admits. */
interface Nullability {
    /** A member is `null`. */
    readonly null: boolean;
    /** A member is `undefined` or `void`, which reads as undefined. */
    readonly undefined: boolean;
    /** A member is `void` itself, a result the caller is not meant to read. */
    readonly void: boolean;
}

/** See {@link Nullability}; members are those of {@link presentMembers}. */
export function nullability(type: ts.Type): Nullability {
    const flags = (type.isUnion() ? type.types : [type]).reduce(
        (all, member) => all | absentFlags(member),
        0,
    );
    return {
        null: (flags & ts.TypeFlags.Null) !== 0,
        undefined: (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0,
        void: (flags & ts.TypeFlags.Void) !== 0,
    };
}

/**
 * Whether the type a position expects rules out a colour written as an
 * object of named channels (`{ r, g, b[, a] }`): the type is known (not
 * `any` or `unknown`) and no present member has an `r`. The pin types every
 * RGB option and field and `baseColorFactor` as number tuples, and only its
 * Color4 dictionaries (a `GPUColorDict` clear colour, line colours) as
 * objects, so the checker's contextual type at the use decides -- the same
 * fact an assignability diagnostic reports there.
 */
export function excludesObjectColour(expected: ts.Type | undefined): boolean {
    if (
        expected === undefined ||
        (expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    )
        return false;
    return !presentMembers(expected).some(
        (member) => member.getProperty("r") !== undefined,
    );
}

/** Whether a type admits `null`, `undefined` or `void`. */
export function isNullable(type: ts.Type): boolean {
    const absent = nullability(type);
    return absent.null || absent.undefined;
}
