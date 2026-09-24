import { float32Literal } from "../../cpp-literals.js";
import { EmissionMap } from "../emission-transaction.js";
import type { DataType, TypedArrayKind } from "./model.js";

interface TypedArrayRecord {
    readonly constructor: string;
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
        constructor: "Int8Array",
        stem: "i8",
        cppType: "bbl::js::I8Array",
        elementCppType: "std::int8_t",
        store: (value) => `bbl::js::to_int8(${value})`,
        storeLiteral: (value) => `${Int8Array.of(value)[0]!}`,
    },
    u8array: {
        constructor: "Uint8Array",
        stem: "u8",
        cppType: "bbl::js::U8Array",
        elementCppType: "std::uint8_t",
        store: (value) => `bbl::js::to_uint8(${value})`,
        storeLiteral: (value) => `${Uint8Array.of(value)[0]!}u`,
    },
    f64array: {
        constructor: "Float64Array",
        stem: "f64",
        cppType: "bbl::js::F64Array",
        elementCppType: "double",
        store: (value) => value,
    },
    f32array: {
        constructor: "Float32Array",
        stem: "f32",
        cppType: "bbl::js::F32Array",
        elementCppType: "float",
        store: (value) => `static_cast<float>(${value})`,
        storeLiteral: float32TableLiteral,
    },
    u16array: {
        constructor: "Uint16Array",
        stem: "u16",
        cppType: "bbl::js::U16Array",
        elementCppType: "std::uint16_t",
        store: (value) => `bbl::js::to_uint16(${value})`,
        storeLiteral: (value) => `${Uint16Array.of(value)[0]!}u`,
    },
    i16array: {
        constructor: "Int16Array",
        stem: "i16",
        cppType: "bbl::js::I16Array",
        elementCppType: "std::int16_t",
        store: (value) => `bbl::js::to_int16(${value})`,
        storeLiteral: (value) => `${Int16Array.of(value)[0]!}`,
    },
    u32array: {
        constructor: "Uint32Array",
        stem: "u32",
        cppType: "bbl::js::U32Array",
        elementCppType: "std::uint32_t",
        store: (value) => `bbl::js::to_uint32(${value})`,
        storeLiteral: (value) => `${Uint32Array.of(value)[0]!}u`,
    },
    i32array: {
        constructor: "Int32Array",
        stem: "i32",
        cppType: "bbl::js::I32Array",
        elementCppType: "std::int32_t",
        store: (value) => `bbl::js::to_int32(${value})`,
        storeLiteral: (value) => `${Int32Array.of(value)[0]!}`,
    },
};

export const TYPED_ARRAY_KINDS: ReadonlyMap<string, TypedArrayKind> =
    new EmissionMap(
        (
            Object.entries(TYPED_ARRAYS) as [TypedArrayKind, TypedArrayRecord][]
        ).map(([kind, record]) => [record.constructor, kind]),
    );

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
