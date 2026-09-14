import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

export function compileSearchParams(lowerer: DataLowerer, node: ts.NewExpression): Value | undefined {
    const context = lowerer.context;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "URLSearchParams" ||
        !context.isDefaultLibraryIdentifier(node.expression)) return undefined;
    const args = node.arguments ?? [];
    if (args.length !== 1) context.fail(node, "Runtime URLSearchParams requires a string initializer.");
    const input = lowerer.compileForSink(args[0]!, {kind:"string"});
    context.reachJsData();
    return {...lowerer.leafValue(`bbl::js::SearchParams(${input})`, {kind:"search-params"}), impure:true};
}

export function compileSearchParamsMethod(lowerer: DataLowerer, call: ts.CallExpression, owner: Value, method: string): Value {
    const context = lowerer.context;
    if (method !== "get" && method !== "has") return context.fail(call, `Runtime URLSearchParams.${method} is not lowered.`);
    context.expectArgumentCount(call, 1, method === "has" ? 2 : 1);
    const receiver = context.pinValueToTemporary(owner, "query_receiver");
    const arguments_ = call.arguments.map(argument => {
        const value = context.pinValueToTemporary(context.compileValue(argument), "query_argument");
        return lowerer.compileKnownValueForSink(value, {kind:"string"}, argument);
    });
    return lowerer.leafValue(`(${receiver.cpp}).${method}(${arguments_.join(", ")})`,
        method === "has" ? {kind:"boolean"} : {kind:"optional", inner:{kind:"string"}});
}
