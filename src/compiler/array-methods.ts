import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";

/** Keep the selected array alive before arguments can rebind its source. */
export function captureArrayReceiver(lowerer: DataLowerer, owner: Value): string {
    const source = lowerer.context.allocateTemporaryCppName("array_receiver");
    lowerer.context.emit({ kind: "declaration", type: "auto", name: source, initializer: owner.cpp });
    return source;
}

/** Methods that return a value independently of the array callback protocol. */
export function compileArrayValueMethod(
    lowerer: DataLowerer, call: ts.CallExpression, method: string,
    owner: Value, type: DataType & { kind: "vector" | "span" },
): Value | undefined {
    if (!["at", "concat", "lastIndexOf", "copyWithin", "fill", "splice"].includes(method)) return undefined;
    if (type.kind === "span" && (method === "copyWithin" || method === "fill" || method === "splice")) {
        lowerer.context.fail(call, `Array.${method} requires owned mutable array storage.`);
    }
    lowerer.context.reachJsData();
    const source = captureArrayReceiver(lowerer, owner);
    const numericArgument = (index: number, fallback: string): string =>
        lowerer.compileNumberArgument(call.arguments[index], fallback);
    if (method === "at") {
        if (call.arguments.length > 1) lowerer.context.fail(call, "Array.at expects at most one index.");
        const resultType: DataType = lowerer.dataTypeAt(call) ?? (type.element.kind === "optional"
            ? type.element : { kind: "optional", inner: type.element });
        return lowerer.leafValue(`bbl::js::array_relative_at<${lowerer.context.dataTypes.cppType(resultType)}>(${source}, ${numericArgument(0, "0.0")})`, resultType);
    }
    if (method === "lastIndexOf") {
        return lowerer.compileArraySearch(call, { ...owner, cpp: source }, type.element, method);
    }
    if (method === "concat") {
        const resultType = { kind: "vector", element: type.element } as const;
        // Evaluate every argument before copying: an argument may mutate the receiver.
        const arguments_ = call.arguments.map(argument => {
            const value = lowerer.context.compileValue(argument);
            const array = value.kind === "tuple" || value.dataType?.kind === "tuple" ||
                value.dataType?.kind === "vector" || value.dataType?.kind === "span";
            const expected = array ? resultType : type.element;
            const cpp = lowerer.compileKnownValueForSink(value, expected, argument);
            const name = lowerer.context.allocateTemporaryCppName("concat_argument");
            lowerer.context.emit({ kind: "declaration", type: "const auto", name: name, initializer: cpp });
            return { name, array };
        });
        const result = lowerer.context.allocateTemporaryCppName("concat_result");
        lowerer.context.emit(`${lowerer.context.dataTypes.cppType(resultType)} ${result};`);
        const lengths = [ `${source}.size()`, ...arguments_.map(argument => argument.array ? `${argument.name}.size()` : "1") ];
        lowerer.context.emit(`${result}.reserve(${lengths.join(" + ")});`);
        lowerer.context.emit(`bbl::js::array_append(${result}, ${source});`);
        for (const argument of arguments_) lowerer.context.emit(argument.array
            ? `bbl::js::array_append(${result}, ${argument.name});`
            : `${result}.push_back(${argument.name});`);
        lowerer.registerLocal(result, "owned");
        return { kind: "data", cpp: result, dataType: resultType };
    }
    if (method === "copyWithin") {
        if (call.arguments.length < 2 || call.arguments.length > 3) lowerer.context.fail(call, "Array.copyWithin expects two or three arguments.");
        const target = numericArgument(0, "0.0");
        const start = numericArgument(1, "0.0");
        const end = numericArgument(2, "std::numeric_limits<double>::infinity()");
        lowerer.invalidateAliases(owner.cpp);
        return { kind: "data", cpp: `bbl::js::array_copy_within(${source}, ${target}, ${start}, ${end})`, dataType: type };
    }
    if (method === "fill") {
        if (call.arguments.length < 1 || call.arguments.length > 3) lowerer.context.fail(call, "Array.fill expects one to three arguments.");
        const value = lowerer.compileForRetainedSink(call.arguments[0]!, type.element, "Array.fill");
        const item = lowerer.context.allocateTemporaryCppName("fill_value");
        lowerer.context.emit({ kind: "declaration", type: "const auto", name: item, initializer: value });
        const start = numericArgument(1, "0.0");
        const end = numericArgument(2, "std::numeric_limits<double>::infinity()");
        return { kind: "data", cpp: `bbl::js::array_fill_range(${source}, ${item}, ${start}, ${end})`, dataType: type };
    }
    const start = numericArgument(0, "0.0");
    const count = numericArgument(1, call.arguments.length ? "std::numeric_limits<double>::infinity()" : "0.0");
    const inserted = call.arguments.slice(2).map(argument => {
        const value = lowerer.compileForRetainedSink(argument, type.element, "Array.splice");
        const name = lowerer.context.allocateTemporaryCppName("splice_item");
        lowerer.context.emit({ kind: "declaration", type: "const auto", name: name, initializer: value });
        return name;
    });
    lowerer.invalidateAliases(owner.cpp);
    return { kind: "data", cpp: `bbl::js::array_splice(${source}, ${start}, ${count}, {${inserted.join(", ")}})`, dataType: type };
}
