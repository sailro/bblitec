import { float32Literal } from "../cpp-literals.js";

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

interface IntegerStore {
    readonly cppType: string;
    readonly unsigned: boolean;
    /** The JavaScript store of one number into this element kind. */
    readonly store: (value: number) => number;
}

/** Keyed by the typed-array stem the `${stem}_array_from` helpers use. */
const INTEGER_STORES: Readonly<Record<string, IntegerStore>> = {
    i8: {
        cppType: "std::int8_t",
        unsigned: false,
        store: (value) => Int8Array.of(value)[0]!,
    },
    u8: {
        cppType: "std::uint8_t",
        unsigned: true,
        store: (value) => Uint8Array.of(value)[0]!,
    },
    i16: {
        cppType: "std::int16_t",
        unsigned: false,
        store: (value) => Int16Array.of(value)[0]!,
    },
    u16: {
        cppType: "std::uint16_t",
        unsigned: true,
        store: (value) => Uint16Array.of(value)[0]!,
    },
    i32: {
        cppType: "std::int32_t",
        unsigned: false,
        store: (value) => Int32Array.of(value)[0]!,
    },
    u32: {
        cppType: "std::uint32_t",
        unsigned: true,
        store: (value) => Uint32Array.of(value)[0]!,
    },
};

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
 * The shortest `float` literal that a C++ compiler reads back as exactly
 * the float32 `value`, or undefined where no finite float names it.
 */
export function float32TableLiteral(value: number): string | undefined {
    return Number.isFinite(Math.fround(value))
        ? float32Literal(value)
        : undefined;
}

/**
 * The element type and element literals of a constant table for `stem`,
 * or undefined where the elements do not all read as plain literals (the
 * caller then keeps the generic double table the runtime converts).
 */
export function typedArrayTable(
    stem: string,
    elementText: readonly string[],
): TypedArrayTable | undefined {
    if (stem === "f64") {
        return { elementCppType: "double", elements: [...elementText] };
    }
    const values = elementText.map(literalValue);
    if (!values.every((value): value is number => value !== undefined)) {
        return undefined;
    }
    if (stem === "f32") {
        const elements = values.map(float32TableLiteral);
        return elements.every((element) => element !== undefined)
            ? { elementCppType: "float", elements }
            : undefined;
    }
    const integer = INTEGER_STORES[stem];
    if (!integer) {
        throw new Error(`No typed-array element store for '${stem}'.`);
    }
    return {
        elementCppType: integer.cppType,
        elements: values.map((value) => {
            const stored = integer.store(value);
            return integer.unsigned ? `${stored}u` : `${stored}`;
        }),
    };
}
