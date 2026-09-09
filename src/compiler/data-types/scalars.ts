import { CPP_SCALAR } from "../../lowering/cpp-types.js";
import { handleCppType } from "./handles.js";
import type { DataKindOperations } from "./contracts.js";
import type { TypedArrayKind } from "./model.js";
import { typedArrayCppType, typedArrayStem } from "./typed-arrays.js";

function leaf(cpp: string, key: string, byReference = false) {
    return { cpp: () => cpp, key: () => key, equal: () => true, children: () => [], byReference };
}

function typedArray(kind: TypedArrayKind) {
    return leaf(typedArrayCppType(kind), typedArrayStem(kind), true);
}

export const scalarKinds: DataKindOperations<
    "number" | "boolean" | "string" | "arraybuffer" | "dataview" | "json" |
    "borrowed-platform-event" | "handle" | TypedArrayKind
> = {
    number: leaf(CPP_SCALAR.number, "n"),
    boolean: leaf(CPP_SCALAR.boolean, "b"),
    string: leaf(CPP_SCALAR.string, "str"),
    arraybuffer: leaf("bbl::js::ArrayBuffer", "ab", true),
    dataview: leaf("bbl::js::DataView", "dv", true),
    json: leaf("bbl::js::JsonValue", "json"),
    "borrowed-platform-event": {
        cpp: type => type.event === "event" ? "bbl::js::BorrowedEvent" :
            `bbl::js::Borrowed<const bbl::Platform${type.event === "mouse" ? "Mouse" : "Keyboard"}Event>`,
        key: type => `borrowed(${type.event})`,
        equal: (left, right) => left.event === right.event,
        children: () => [], byReference: false,
    },
    handle: {
        cpp: type => handleCppType(type.handle),
        key: type => `h(${type.handle})`,
        equal: (left, right) => left.handle === right.handle,
        children: () => [], byReference: false,
    },
    u8array: typedArray("u8array"),
    f64array: typedArray("f64array"),
    f32array: typedArray("f32array"),
    u16array: typedArray("u16array"),
    i16array: typedArray("i16array"),
    u32array: typedArray("u32array"),
    i32array: typedArray("i32array"),
};
