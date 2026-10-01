import { CPP_SCALAR } from "../../lowering/cpp-types.js";
import { handleCppType } from "./handles.js";
import type { DataKindOperations } from "./contracts.js";
import type { TypedArrayKind } from "./model.js";
import { typedArrayCppType, typedArrayStem } from "./typed-arrays.js";

/** A payload-free kind; `traced` is its native type's `gc_traceable`. */
function leaf(cpp: string, key: string, byReference = false, traced = false) {
    return {
        cpp: () => cpp,
        key: () => key,
        equal: () => true,
        children: () => [],
        byReference,
        tracedEdges: traced ? ("always" as const) : ("never" as const),
    };
}

/** A reference-backed leaf: copies retain identity and the payload is traced. */
function opaqueLeaf(cpp: string, key: string) {
    return { ...leaf(cpp, key, true, true), opaqueReference: true as const };
}

function typedArray(kind: TypedArrayKind) {
    return leaf(typedArrayCppType(kind), typedArrayStem(kind), true);
}

export const scalarKinds: DataKindOperations<
    | "error"
    | "search-params"
    | "http-response"
    | "storage"
    | "date"
    | "date-time-format"
    | "text-decoder"
    | "text-encoder"
    | "collator"
    | "number"
    | "boolean"
    | "string"
    | "arraybuffer"
    | "dataview"
    | "bufferview"
    | "numberindex"
    | "json"
    | "event-target"
    | "borrowed-platform-event"
    | "handle"
    | TypedArrayKind
> = {
    error: leaf("bbl::js::Error", "error"),
    "event-target": leaf("bbl::DomEventTargetValue", "event-target"),
    "http-response": opaqueLeaf("bbl::pal::HttpResponse", "http-response"),
    "search-params": opaqueLeaf("bbl::js::SearchParams", "search-params"),
    storage: opaqueLeaf("bbl::js::Storage", "storage"),
    date: opaqueLeaf("bbl::js::Date", "date"),
    "date-time-format": opaqueLeaf("bbl::js::DateTimeFormat", "dateformat"),
    "text-decoder": opaqueLeaf("bbl::js::TextDecoder", "textdecoder"),
    "text-encoder": opaqueLeaf("bbl::js::TextEncoder", "textencoder"),
    collator: opaqueLeaf("bbl::pal::Collator", "collator"),
    number: leaf(CPP_SCALAR.number, "n"),
    boolean: leaf(CPP_SCALAR.boolean, "b"),
    string: leaf(CPP_SCALAR.string, "str"),
    arraybuffer: leaf("bbl::js::ArrayBuffer", "ab", true),
    dataview: leaf("bbl::js::DataView", "dv", true),
    bufferview: leaf("bbl::js::ArrayBufferView", "bv", true),
    numberindex: leaf("bbl::js::NumericArrayView", "ni", false),
    json: leaf("bbl::js::JsonValue", "json", false, true),
    "borrowed-platform-event": {
        cpp: (type) =>
            type.event === "event"
                ? "bbl::js::BorrowedEvent"
                : type.event === "error" || type.event === "rejection"
                  ? "bbl::js::Borrowed<bbl::pal::ApplicationErrorEvent>"
                  : `bbl::js::Borrowed<const bbl::Platform${type.event === "mouse" ? "Mouse" : "Keyboard"}Event>`,
        key: (type) => `borrowed(${type.event})`,
        equal: (left, right) => left.event === right.event,
        children: () => [],
        byReference: false,
        tracedEdges: "never",
    },
    handle: {
        cpp: (type) => handleCppType(type.handle),
        key: (type) => `h(${type.handle})`,
        equal: (left, right) => left.handle === right.handle,
        children: () => [],
        byReference: false,
        tracedEdges: (type) =>
            `bbl::js::gc_traceable<${handleCppType(type.handle)}>`,
    },
    u8array: typedArray("u8array"),
    i8array: typedArray("i8array"),
    f64array: typedArray("f64array"),
    f32array: typedArray("f32array"),
    u16array: typedArray("u16array"),
    i16array: typedArray("i16array"),
    u32array: typedArray("u32array"),
    i32array: typedArray("i32array"),
};
