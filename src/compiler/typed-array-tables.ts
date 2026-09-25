import { typedArrayElement, type TypedArrayKind } from "./data-types.js";

/**
 * A constant typed-array table stored in its array's own element type.
 *
 * `elements` are the values the runtime store would produce, converted at
 * generation: `Math.fround` for a Float32Array, ToInt8 ... ToUint32 for the
 * integer kinds, so the table holds exactly what the typed array will and
 * the use site's conversion is the identity.
 */
interface TypedArrayTable {
    readonly elementCppType: string;
    readonly elements: string[];
}

/**
 * The element type and element literals of a constant table of `kind`
 * over its generation-known `values` (spelled `elementText` as doubles),
 * or undefined where a value has no literal in the element type (the
 * caller then keeps the generic double table the runtime converts).
 */
export function typedArrayTable(
    kind: TypedArrayKind,
    values: readonly number[],
    elementText: readonly string[],
): TypedArrayTable | undefined {
    const { elementCppType, storeLiteral } = typedArrayElement(kind);
    if (!storeLiteral) {
        return { elementCppType, elements: [...elementText] };
    }
    const elements = values.map(storeLiteral);
    return elements.every((element) => element !== undefined)
        ? { elementCppType, elements }
        : undefined;
}
