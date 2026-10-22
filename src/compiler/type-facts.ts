import ts from "typescript";
import { declaredSymbol, libraryName, calledDeclaration } from "./symbols.js";
import {
    unwrapExpression,
    wrappedParent,
    objectLiteralMembers,
} from "./syntax.js";
import { presenceFlagCpp, type Value } from "./values/model.js";

/**
 * What a value of one member of a type is at run time. `void` is its own
 * kind: a result its caller is not meant to read, whose run-time value only
 * a proven completion makes `undefined`. `unknown` covers `any`, `unknown`
 * and types only an instantiation decides.
 */
export type ValueKind =
    | "number"
    | "string"
    | "boolean"
    | "bigint"
    | "symbol"
    | "null"
    | "undefined"
    | "void"
    | "object"
    | "unknown";

const scalarKinds: readonly [ts.TypeFlags, ValueKind][] = [
    [ts.TypeFlags.NumberLike, "number"],
    [ts.TypeFlags.StringLike, "string"],
    [ts.TypeFlags.BooleanLike, "boolean"],
    [ts.TypeFlags.BigIntLike, "bigint"],
    [ts.TypeFlags.ESSymbolLike, "symbol"],
    [ts.TypeFlags.Null, "null"],
    [ts.TypeFlags.Undefined, "undefined"],
    [ts.TypeFlags.Void, "void"],
];

/** The kind of value one member of a type (not a union) holds. */
export function valueKindOf(member: ts.Type): ValueKind {
    for (const [flags, kind] of scalarKinds)
        if ((member.flags & flags) !== 0) return kind;
    if (member.isIntersection()) {
        // A branded primitive (`number & { brand }`) is its primitive.
        const kinds = member.types.map(valueKindOf);
        return (
            kinds.find((kind) => kind !== "object" && kind !== "unknown") ??
            (kinds.includes("unknown") ? "unknown" : "object")
        );
    }
    return (member.flags &
        (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !==
        0
        ? "object"
        : "unknown";
}

/** The kinds of value a type's members hold; `never` holds none. */
export function valueKinds(type: ts.Type): ReadonlySet<ValueKind> {
    if ((type.flags & ts.TypeFlags.Never) !== 0) return new Set();
    return new Set(unionMembers(type).map(valueKindOf));
}

/** Whether every value of a type is of one of `kinds`. */
export function holdsOnly(type: ts.Type, kinds: readonly ValueKind[]): boolean {
    return [...valueKinds(type)].every((kind) => kinds.includes(kind));
}

/** Scalars copy into callees; composites and unresolved types may alias. */
export function typeCanCarryReference(type: ts.Type): boolean {
    return !holdsOnly(type, [
        "number",
        "string",
        "boolean",
        "bigint",
        "symbol",
        "null",
        "undefined",
        "void",
    ]);
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

/** A union's members, or the type itself. */
function unionMembers(type: ts.Type): readonly ts.Type[] {
    return type.isUnion() ? type.types : [type];
}

/**
 * The members of a type that stand for a present value: a union's members
 * less `null`, `undefined`, `void` and the intersections that distribute one
 * of them; any other type is its own single member unless it is itself
 * absent. The one statement of the nullable-union member rule.
 */
export function presentMembers(type: ts.Type): readonly ts.Type[] {
    return unionMembers(type).filter((member) => absentFlags(member) === 0);
}

/**
 * The call signatures of a value of `type`. Its `null`, `undefined` and
 * `void` members say nothing about calling it: `present` reads the value's
 * signatures once present (an optional callback is callable after its
 * test); `exact` gives a nullable type none, for a site that calls, binds
 * or stores the value as it is. Several function members answer the
 * checker's merged signature.
 */
export function callSignatures(
    checker: ts.TypeChecker,
    type: ts.Type,
    absent: "present" | "exact",
): readonly ts.Signature[] {
    const members = presentMembers(type);
    if (absent === "exact" && members.length !== unionMembers(type).length)
        return [];
    return members.length === 1
        ? members[0]!.getCallSignatures()
        : checker.getNonNullableType(type).getCallSignatures();
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
    AbsentValueKind | "unconstrained" | { readonly slotFoundCpp: string };

/** Which JavaScript absent values a type admits: one of the two, or "either". */
export type AbsentValueKind = "undefined" | "null" | "either";

/** The absent values `absent` admits; undefined when it admits neither. */
export function absentValueKind(
    absent: Pick<Nullability, "null" | "undefined">,
): AbsentValueKind | undefined {
    if (absent.null) return absent.undefined ? "either" : "null";
    return absent.undefined ? "undefined" : undefined;
}

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
    let absent = nullability(checker.getTypeAtLocation(node));
    if (
        !absent.null &&
        !absent.undefined &&
        presenceFlagCpp(value) !== undefined
    ) {
        // A write through an alias can invalidate TypeScript's flow narrowing.
        // The native slot still carries its declared kind of absence.
        const symbol = declaredSymbol(checker, node);
        if (symbol?.valueDeclaration)
            absent = nullability(
                checker.getTypeOfSymbolAtLocation(
                    symbol,
                    symbol.valueDeclaration,
                ),
            );
    }
    if (value.preserveUncheckedLookup)
        return absent.null ? "either" : "undefined";
    return (
        absentValueKind(absent) ??
        (presenceFlagCpp(value) !== undefined ? "undefined" : "unconstrained")
    );
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

/** An array or tuple type: its element type, whether writes through it are allowed, and whether it is a tuple. */
export interface ArrayShape {
    readonly element: ts.Type;
    readonly mutable: boolean;
    readonly tuple: boolean;
}

/**
 * The shape of a library array (`T[]`, `Array<T>`, `ReadonlyArray<T>`) or a
 * tuple; undefined for any other type, a union included.
 */
export function arrayShape(
    checker: ts.TypeChecker,
    type: ts.Type,
): ArrayShape | undefined {
    if (checker.isTupleType(type)) {
        const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        return (
            element && {
                element,
                mutable: !(type as ts.TupleTypeReference).target.readonly,
                tuple: true,
            }
        );
    }
    if (!checker.isArrayType(type)) return undefined;
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    return (
        element && {
            element,
            mutable: libraryName(type) === "Array",
            tuple: false,
        }
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

/**
 * Whether a type is `void` itself: a result its caller is not meant to read,
 * which has no storage (`undefined` has; a `void | T` union is not `void`).
 */
export function isVoid(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Void) !== 0;
}

/**
 * Whether a slot of this type holds no payload: `void` or `never`. Such a
 * parameter only fills a position; its argument is erased.
 */
export function holdsNoPayload(type: ts.Type): boolean {
    return isVoid(type) || (type.flags & ts.TypeFlags.Never) !== 0;
}

/**
 * Whether every member of a type is `undefined` or `void`: a value of it is
 * `undefined`, and a call returning it completes without a value.
 */
export function undefinedOnly(type: ts.Type): boolean {
    return unionMembers(type).every((member) => {
        const flags = absentFlags(member);
        return (
            (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
            (flags & ts.TypeFlags.Null) === 0
        );
    });
}

/** See {@link Nullability}; members are those of {@link presentMembers}. */
export function nullability(type: ts.Type): Nullability {
    const flags = unionMembers(type).reduce(
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
 * The literal's named keys whose value types admit neither `null` nor
 * `undefined`: each is present on the object the literal builds.
 */
export function presentLiteralKeys(
    checker: ts.TypeChecker,
    literal: ts.ObjectLiteralExpression,
): string[] {
    const keys: string[] = [];
    for (const member of objectLiteralMembers(literal)) {
        if (
            (member.kind !== "property" && member.kind !== "shorthand") ||
            member.key === undefined
        )
            continue;
        const absent = nullability(checker.getTypeAtLocation(member.value));
        if (!absent.null && !absent.undefined) keys.push(member.key);
    }
    return keys;
}

/**
 * Whether the slot `expression` is stored into is typed so that nothing can
 * change an array's length through it: its contextual type is known and no
 * present member is a growable array (`readonly number[]`, `ArrayLike`,
 * primitives).
 */
export function storedAsReadonlyArray(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const type = checker.getContextualType(expression);
    if (type === undefined) return false;
    const members = presentMembers(type);
    return (
        members.length > 0 &&
        members.every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Any |
                        ts.TypeFlags.Unknown |
                        ts.TypeFlags.TypeParameter |
                        ts.TypeFlags.Index |
                        ts.TypeFlags.IndexedAccess)) ===
                    0 &&
                checker.getPropertyOfType(member, "push") === undefined,
        )
    );
}

/** Whether a value of `type` may be `undefined`: it names it, or it is `unknown` or `any`. */
export function admitsUndefined(type: ts.Type): boolean {
    return (
        nullability(type).undefined ||
        (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
    );
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

/**
 * Whether every present value of a type is truthy: objects, non-empty string
 * and non-zero number literals, and `true`. Its absent values are then its
 * only falsy ones.
 */
export function presentValuesTruthy(
    checker: ts.TypeChecker,
    type: ts.Type,
): boolean {
    return presentMembers(type).every((member) => {
        if (member.isStringLiteral()) return member.value !== "";
        if (member.isNumberLiteral()) return member.value !== 0;
        if ((member.flags & ts.TypeFlags.BooleanLiteral) !== 0)
            return member === checker.getTrueType();
        return (
            (member.flags &
                (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !==
            0
        );
    });
}

/** Whether a type admits `null`, `undefined` or `void`. */
export function isNullable(type: ts.Type): boolean {
    const absent = nullability(type);
    return absent.null || absent.undefined;
}

/**
 * The type an expression's position declares for it: its contextual type,
 * except as an argument of a generic call or construction, whose parameter
 * type TypeScript inferred from the argument itself.
 */
export function declaredContextualType(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.Type | undefined {
    const parent = wrappedParent(expression);
    const callee =
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.arguments?.some(
            (argument) => unwrapExpression(argument) === expression,
        )
            ? calledDeclaration(checker, parent)
            : undefined;
    // A constructor's signature carries its class's type parameters.
    return callee &&
        checker.getSignatureFromDeclaration(callee)?.typeParameters?.length
        ? undefined
        : checker.getContextualType(expression);
}

/**
 * The property `name` of the type an object literal is stored as: its
 * contextual type, absent members aside.
 */
export function contextualProperty(
    checker: ts.TypeChecker,
    literal: ts.ObjectLiteralExpression,
    name: string,
): ts.Symbol | undefined {
    const owner = checker.getContextualType(literal);
    return (
        owner &&
        checker.getPropertyOfType(checker.getNonNullableType(owner), name)
    );
}
