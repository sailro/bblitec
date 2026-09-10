import type { DataKindOperations } from "./contracts.js";

export const namedKinds: DataKindOperations<"struct" | "enum" | "function"> = {
    struct: {
        cpp: (type, context) => context.namedType(type.name),
        key: type => `s(${type.name})`,
        equal: (left, right) => left.name === right.name,
        children: (type, fields) => fields(type.name), byReference: false,
    },
    enum: {
        cpp: (type, context) => context.namedType(type.name),
        key: type => `e(${type.name})`,
        equal: (left, right) => left.name === right.name,
        children: () => [], byReference: false,
    },
    function: {
        cpp: (type, context) => `bbl::js::Callback<${type.result ? context.cppType(type.result) : "void"}` +
            `(${type.parameters.map(parameter => context.cppType(parameter)).join(", ")})>`,
        key: (type, key) => `${type.identity ? "cb" : "fn"}(${type.parameters.map(key).join(",")})` +
            `${type.erasedParameters?.length ? `~${type.erasedParameters.join(",")}` : ""}->${type.result ? key(type.result) : "void"}`,
        equal: (left, right, equal) => left.identity === right.identity &&
            (left.erasedParameters ?? []).join(",") === (right.erasedParameters ?? []).join(",") &&
            left.parameters.length === right.parameters.length &&
            left.parameters.every((parameter, index) => equal(parameter, right.parameters[index]!)) &&
            (left.result === undefined ? right.result === undefined :
                right.result !== undefined && equal(left.result, right.result)),
        children: (type, _fields, signatures) => signatures
            ? [...type.parameters, ...(type.result ? [type.result] : [])] : [],
        byReference: false,
    },
};
