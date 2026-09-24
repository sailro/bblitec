import { float32Literal, floatLiteral } from "../cpp-literals.js";

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

const float32Bits = new Float32Array(1);
const float32Word = new Uint32Array(float32Bits.buffer);

/** The float32 adjacent to `value` (itself a float32) on the side of `toward`. */
function adjacentFloat32(value: number, toward: number): number {
    float32Bits[0] = value;
    // Magnitude grows with the stored word for both signs, so the step
    // direction depends on whether `toward` is further from zero.
    const away = Math.abs(toward) > Math.abs(value);
    float32Word[0] = float32Word[0]! + (away ? 1 : -1);
    return float32Bits[0];
}

/**
 * Whether `decimal` (a double) lies exactly halfway between two float32s.
 *
 * `float32Literal` proves its decimal rounds to the float through a double;
 * a C++ `f` literal rounds the decimal once, straight to float. The two can
 * disagree only when the intermediate double is exactly such a midpoint:
 * any other double lies strictly on the decimal's own side of every
 * midpoint, because the midpoints are themselves doubles.
 */
function isFloat32Midpoint(decimal: number): boolean {
    const nearest = Math.fround(decimal);
    if (nearest === decimal || !Number.isFinite(nearest)) return false;
    const other = adjacentFloat32(nearest, decimal);
    return Math.abs(decimal - nearest) === Math.abs(other - decimal);
}

/**
 * The shortest `float` literal that a C++ compiler reads back as exactly
 * the float32 `value`, or undefined where no finite float names it.
 */
export function float32TableLiteral(value: number): string | undefined {
    const stored = Math.fround(value);
    if (!Number.isFinite(stored)) return undefined;
    const literal = float32Literal(stored);
    // `floatLiteral` spells the float's exact double value, which is never
    // near a midpoint and so always parses back to the same float.
    return isFloat32Midpoint(Number(literal.slice(0, -1)))
        ? floatLiteral(stored)
        : literal;
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
