import type { DataKindOperations } from "./contracts.js";

export const namedKinds: DataKindOperations<"struct" | "enum" | "function"> = {
    struct: {
        cpp: (type, context) => context.namedType(type.name),
        key: (type) => `s(${type.name})`,
        equal: (left, right) => left.name === right.name,
        children: (type, fields) => fields(type.name),
        byReference: false,
        tracedEdges: "children",
    },
    enum: {
        cpp: (type, context) => context.namedType(type.name),
        key: (type) => `e(${type.name})`,
        equal: (left, right) => left.name === right.name,
        children: () => [],
        byReference: false,
        tracedEdges: "never",
        reseats: true,
    },
    function: {
        cpp: (type, context) =>
            type.generic
                ? `bbl::js::GenericCallback<${context.namedType(type.generic)}>`
                : `bbl::js::Callback<${type.result ? context.cppType(type.result) : "void"}` +
                  `(${type.parameters.map((parameter) => context.cppType(parameter)).join(", ")})>`,
        key: (type, key) =>
            type.generic
                ? `generic(${type.generic})`
                : `${type.identity ? "cb" : "fn"}(${type.parameters.map(key).join(",")})` +
                  `${type.restParameter === undefined ? "" : `...${type.restParameter}`}` +
                  `${type.optionalParameters?.length ? `?${type.optionalParameters.join(",")}` : ""}` +
                  `${type.erasedParameters?.length ? `~${type.erasedParameters.join(",")}` : ""}->${type.result ? key(type.result) : "void"}${type.undefinedCompletion ? ":undefined" : ""}`,
        equal: (left, right, equal) =>
            left.generic === right.generic &&
            left.identity === right.identity &&
            left.undefinedCompletion === right.undefinedCompletion &&
            left.restParameter === right.restParameter &&
            (left.optionalParameters ?? []).join(",") ===
                (right.optionalParameters ?? []).join(",") &&
            (left.erasedParameters ?? []).join(",") ===
                (right.erasedParameters ?? []).join(",") &&
            left.parameters.length === right.parameters.length &&
            left.parameters.every((parameter, index) =>
                equal(parameter, right.parameters[index]!),
            ) &&
            (left.result === undefined
                ? right.result === undefined
                : right.result !== undefined &&
                  equal(left.result, right.result)),
        children: (type, fields, signatures) =>
            type.generic
                ? fields(type.generic)
                : signatures
                  ? [...type.parameters, ...(type.result ? [type.result] : [])]
                  : [],
        byReference: false,
        tracedEdges: "always",
    },
};
