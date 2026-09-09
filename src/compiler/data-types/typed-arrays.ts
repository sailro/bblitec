import { EmissionMap } from "../emission-transaction.js";
import type { DataType, TypedArrayKind } from "./model.js";

interface TypedArrayRecord {
  readonly constructor: string;
  readonly stem: string;
  readonly cppType: string;
  readonly store: (value: string) => string;
}

const TYPED_ARRAYS: Readonly<Record<TypedArrayKind, TypedArrayRecord>> = {
  u8array: {
    constructor: "Uint8Array",
    stem: "u8",
    cppType: "bbl::js::U8Array",
    store: (value) => `bbl::js::to_uint8(${value})`,
  },
  f64array: {
    constructor: "Float64Array",
    stem: "f64",
    cppType: "bbl::js::F64Array",
    store: (value) => value,
  },
  f32array: {
    constructor: "Float32Array",
    stem: "f32",
    cppType: "bbl::js::F32Array",
    store: (value) => `static_cast<float>(${value})`,
  },
  u16array: {
    constructor: "Uint16Array",
    stem: "u16",
    cppType: "bbl::js::U16Array",
    store: (value) => `bbl::js::to_uint16(${value})`,
  },
  i16array: {
    constructor: "Int16Array",
    stem: "i16",
    cppType: "bbl::js::I16Array",
    store: (value) => `bbl::js::to_int16(${value})`,
  },
  u32array: {
    constructor: "Uint32Array",
    stem: "u32",
    cppType: "bbl::js::U32Array",
    store: (value) => `bbl::js::to_uint32(${value})`,
  },
  i32array: {
    constructor: "Int32Array",
    stem: "i32",
    cppType: "bbl::js::I32Array",
    store: (value) => `bbl::js::to_int32(${value})`,
  },
};

export const TYPED_ARRAY_KINDS: ReadonlyMap<string, TypedArrayKind> = new EmissionMap(
  (Object.entries(TYPED_ARRAYS) as [TypedArrayKind, TypedArrayRecord][]).map(
    ([kind, record]) => [record.constructor, kind],
  ),
);

export const BUFFER_VIEW_KINDS: ReadonlyMap<string, "arraybuffer" | "dataview"> =
  new EmissionMap([
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

export function typedArrayStoreExpression(
  kind: TypedArrayKind,
  value: string,
): string {
  return TYPED_ARRAYS[kind].store(value);
}
