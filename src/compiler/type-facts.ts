import ts from "typescript";

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

/** Which absent values a type admits. */
export interface Nullability {
    /** A member is `null`. */
    readonly null: boolean;
    /** A member is `undefined` or `void`, which reads as undefined. */
    readonly undefined: boolean;
    /**
     * A member is `void` itself: a result the caller is not meant to read,
     * so a type that pairs it with more than one present member names no
     * storage.
     */
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

/** Whether a type admits `null`, `undefined` or `void`. */
export function isNullable(type: ts.Type): boolean {
    const absent = nullability(type);
    return absent.null || absent.undefined;
}
