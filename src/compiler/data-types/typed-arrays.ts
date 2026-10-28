import {
    jsToInt32Call,
    jsToUint32Call,
} from "../../lowering/pinned-operators.js";
import { float32Literal } from "../../cpp-literals.js";
import { EmissionMap } from "../emission-transaction.js";
import { TYPED_ARRAY_CLASSES } from "../../typed-array-classes.js";
import type { DataType, TypedArrayKind } from "./model.js";

interface TypedArrayRecord {
    readonly stem: string;
    readonly cppType: string;
    /** The C++ type of one element, which a constant table stores. */
    readonly elementCppType: string;
    readonly store: (value: string) => string;
    /**
     * The same store run at generation: the C++ literal of the element the
     * typed array keeps for one number, or undefined where no element of
     * the type names it. A Float64Array has none, because each element
     * already spells the double it keeps.
     */
    readonly storeLiteral?: (value: number) => string | undefined;
}

const TYPED_ARRAYS: Readonly<Record<TypedArrayKind, TypedArrayRecord>> = {
    i8array: {
        stem: "i8",
        cppType: "bbl::js::I8Array",
        elementCppType: "std::int8_t",
        store: (value) => `bbl::js::to_int8(${value})`,
        storeLiteral: (value) => `${Int8Array.of(value)[0]!}`,
    },
    u8array: {
        stem: "u8",
        cppType: "bbl::js::U8Array",
        elementCppType: "std::uint8_t",
        store: (value) => `bbl::js::to_uint8(${value})`,
        storeLiteral: (value) => `${Uint8Array.of(value)[0]!}u`,
    },
    f64array: {
        stem: "f64",
        cppType: "bbl::js::F64Array",
        elementCppType: "double",
        store: (value) => value,
    },
    f32array: {
        stem: "f32",
        cppType: "bbl::js::F32Array",
        elementCppType: "float",
        store: (value) => `static_cast<float>(${value})`,
        storeLiteral: float32TableLiteral,
    },
    u16array: {
        stem: "u16",
        cppType: "bbl::js::U16Array",
        elementCppType: "std::uint16_t",
        store: (value) => `bbl::js::to_uint16(${value})`,
        storeLiteral: (value) => `${Uint16Array.of(value)[0]!}u`,
    },
    i16array: {
        stem: "i16",
        cppType: "bbl::js::I16Array",
        elementCppType: "std::int16_t",
        store: (value) => `bbl::js::to_int16(${value})`,
        storeLiteral: (value) => `${Int16Array.of(value)[0]!}`,
    },
    u32array: {
        stem: "u32",
        cppType: "bbl::js::U32Array",
        elementCppType: "std::uint32_t",
        store: jsToUint32Call,
        storeLiteral: (value) => `${Uint32Array.of(value)[0]!}u`,
    },
    u8clampedarray: {
        stem: "u8c",
        cppType: "bbl::js::U8CArray",
        elementCppType: "bbl::js::ClampedByte",
        store: (value) => `bbl::js::to_uint8_clamp(${value})`,
        storeLiteral: (value) =>
            `bbl::js::ClampedByte{${Uint8ClampedArray.of(value)[0]!}u}`,
    },
    i32array: {
        stem: "i32",
        cppType: "bbl::js::I32Array",
        elementCppType: "std::int32_t",
        store: jsToInt32Call,
        storeLiteral: (value) => `${Int32Array.of(value)[0]!}`,
    },
};

export const TYPED_ARRAY_KINDS: ReadonlyMap<string, TypedArrayKind> =
    new EmissionMap(
        (
            Object.entries(TYPED_ARRAY_CLASSES) as [
                TypedArrayKind,
                (typeof TYPED_ARRAY_CLASSES)[TypedArrayKind],
            ][]
        ).map(([kind, type]) => [type.name, kind]),
    );

/** BigInt64Array and BigUint64Array, by constructor name. */
export const BIGINT_ARRAY_KINDS: ReadonlyMap<string, "i64array" | "u64array"> =
    new EmissionMap([
        ["BigInt64Array", "i64array"],
        ["BigUint64Array", "u64array"],
    ]);

/** `BYTES_PER_ELEMENT` of a typed-array kind, the BigInt kinds included. */
export function typedArrayBytesPerElement(
    kind: TypedArrayKind | "i64array" | "u64array",
): number {
    return kind === "i64array" || kind === "u64array"
        ? 8
        : TYPED_ARRAY_CLASSES[kind].BYTES_PER_ELEMENT;
}

/**
 * `BYTES_PER_ELEMENT` of the typed-array class a library global names
 * (`Float32Array`), or undefined for any other global.
 */
export function typedArrayClassBytesPerElement(
    name: string,
): number | undefined {
    const kind = TYPED_ARRAY_KINDS.get(name) ?? BIGINT_ARRAY_KINDS.get(name);
    return kind === undefined ? undefined : typedArrayBytesPerElement(kind);
}

export const BUFFER_VIEW_KINDS: ReadonlyMap<
    string,
    "arraybuffer" | "dataview"
> = new EmissionMap([
    ["ArrayBuffer", "arraybuffer"],
    ["DataView", "dataview"],
]);

export function isTypedArrayType(
    dataType: DataType | undefined,
): dataType is DataType & { kind: TypedArrayKind } {
    return (
        dataType !== undefined &&
        Object.prototype.hasOwnProperty.call(TYPED_ARRAYS, dataType.kind)
    );
}

/**
 * A sequence of numbers a typed array is built or filled from, read
 * element by element: a typed array, a number array or a numeric tuple.
 */
export function isNumericSequenceType(dataType: DataType): boolean {
    return (
        isTypedArrayType(dataType) ||
        dataType.kind === "tuple" ||
        ((dataType.kind === "vector" || dataType.kind === "span") &&
            dataType.element.kind === "number")
    );
}

/** An ArrayBuffer, a DataView, an ArrayBufferView or a typed array. */
export function isBinaryDataType(
    dataType: DataType | undefined,
): dataType is DataType<
    "arraybuffer" | "dataview" | "bufferview" | TypedArrayKind
> {
    return (
        dataType?.kind === "arraybuffer" ||
        dataType?.kind === "dataview" ||
        dataType?.kind === "bufferview" ||
        isTypedArrayType(dataType)
    );
}

/** The global constructor of a typed-array kind: `Float32Array`, ... */
export function typedArrayConstructorName(kind: TypedArrayKind): string {
    return TYPED_ARRAY_CLASSES[kind].name;
}

export function typedArrayStem(kind: TypedArrayKind): string {
    return TYPED_ARRAYS[kind].stem;
}

export function typedArrayCppType(kind: TypedArrayKind): string {
    return TYPED_ARRAYS[kind].cppType;
}

/** What a constant table of the kind stores for each element. */
export function typedArrayElement(
    kind: TypedArrayKind,
): Pick<TypedArrayRecord, "elementCppType" | "storeLiteral"> {
    return TYPED_ARRAYS[kind];
}

export function typedArrayStoreExpression(
    kind: TypedArrayKind | "numberindex",
    value: string,
): string {
    return kind === "numberindex" ? value : TYPED_ARRAYS[kind].store(value);
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
