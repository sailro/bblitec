import { typedArrayElement, type TypedArrayKind } from "./data-types.js";

/**
 * A constant typed-array table stored in its array's own element type.
 *
 * `elements` are the values the runtime store would produce, converted at
 * generation: `Math.fround` for a Float32Array, ToInt8 ... ToUint32 for the
 * integer kinds, so the table holds exactly what the typed array will and
 * the use site's conversion is the identity.
 */
export interface TypedArrayTable {
    readonly elementCppType: string;
    readonly elements: string[];
}

/**
 * A plain C++ floating or integer literal, optionally parenthesised as a
 * negated one is, which reads as the same double in JavaScript.
 */
const DECIMAL_LITERAL =
    /^(?:(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)|\((-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\))$/i;

/** The number a plain literal element spells, or undefined for any other text. */
function literalValue(text: string): number | undefined {
    const match = DECIMAL_LITERAL.exec(text);
    return match ? Number(match[1] ?? match[2]) : undefined;
}

/**
 * The element type and element literals of a constant table of `kind`,
 * or undefined where the elements do not all read as plain literals (the
 * caller then keeps the generic double table the runtime converts).
 */
export function typedArrayTable(
    kind: TypedArrayKind,
    elementText: readonly string[],
): TypedArrayTable | undefined {
    const { elementCppType, storeLiteral } = typedArrayElement(kind);
    if (!storeLiteral) {
        return { elementCppType, elements: [...elementText] };
    }
    const values = elementText.map(literalValue);
    if (!values.every((value): value is number => value !== undefined)) {
        return undefined;
    }
    const elements = values.map(storeLiteral);
    return elements.every((element) => element !== undefined)
        ? { elementCppType, elements }
        : undefined;
}
