import type ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";
import { compileLocaleStringMethod } from "./locale.js";

/** String operations over the runtime's UTF-8 storage, indexed as UTF-16. */
export function compileStringValueMethod(lowerer: DataLowerer, call: ts.CallExpression, method: string, owner: Value): Value | undefined {
    const locale = compileLocaleStringMethod(lowerer, call, method, owner);
    if (locale) return locale;
    if (!["substring", "repeat", "concat", "at", "codePointAt"].includes(method)) return undefined;
    const source = lowerer.context.allocateTemporaryCppName("string_receiver");
    lowerer.context.emit({ kind: "declaration", type: "const std::string", name: source, initializer: owner.cpp });
    const number = (index: number, fallback: string): string =>
        lowerer.compileNumberArgument(call.arguments[index], fallback);
    const stringType: DataType = { kind: "string" };
    if (method === "concat") {
        const parts = call.arguments.map(argument => {
            const value = lowerer.compileForSink(argument, stringType);
            const name = lowerer.context.allocateTemporaryCppName("concat_string");
            lowerer.context.emit({ kind: "declaration", type: "const std::string", name: name, initializer: value });
            return name;
        });
        return lowerer.leafValue(`bbl::js::concat(${[source, ...parts].join(", ")})`, stringType);
    }
    if (call.arguments.length > (method === "substring" ? 2 : 1)) lowerer.context.fail(call, `String.${method} has too many arguments.`);
    const start = number(0, "0.0");
    if (method === "substring") {
        const end = number(1, "std::numeric_limits<double>::infinity()");
        return lowerer.leafValue(`bbl::js::string_substring(${source}, ${start}, ${end})`, stringType);
    }
    if (method === "repeat") return lowerer.leafValue(`bbl::js::string_repeat(${source}, ${start})`, stringType);
    const type: DataType = { kind: "optional", inner: { kind: method === "at" ? "string" : "number" } };
    return lowerer.leafValue(`bbl::js::string_${method === "at" ? "relative_at" : "code_point_at"}(${source}, ${start})`, type);
}
