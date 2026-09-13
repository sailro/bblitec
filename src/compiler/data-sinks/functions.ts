import ts from "typescript";

import { dataTypesEqual, type DataType } from "../data-types.js";
import type { Value } from "../types.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionFunction(dataType: DataType<"function">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    if (unwrapped.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(unwrapped) &&
            unwrapped.text === "undefined" &&
            !lowerer.context.lookupIdentifierValue(unwrapped))) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (ts.isIdentifier(unwrapped)) {
        const bound = lowerer.context.lookupIdentifierValue(unwrapped);
        if (bound &&
            (bound.kind === "callback" ||
                bound.kind === "data" ||
                bound.kind === "json-null")) {
            return lowerer.compileKnownValueForSink(bound, dataType, unwrapped);
        }
    }
    if (ts.isArrowFunction(unwrapped) ||
        ts.isFunctionExpression(unwrapped) ||
        ts.isIdentifier(unwrapped)) {
        if (ts.isIdentifier(unwrapped)) {
            const callback = lowerer.context.compileValue(unwrapped);
            if (callback.kind === "callback" &&
                callback.callbackDeclaration) {
                return lowerer.compileKnownValueForSink(callback, dataType, unwrapped);
            }
        }
        const nativeType = lowerer.dataTypeAt(unwrapped);
        if (nativeType?.kind === "function" && nativeType.restParameter !== undefined && dataType.restParameter === undefined) {
            const cpp = lowerer.context.compileStoredDataFunction(unwrapped, nativeType);
            return lowerer.compileKnownValueForSink(lowerer.leafValue(cpp, nativeType), dataType, unwrapped);
        }
        return lowerer.context.compileStoredDataFunction(unwrapped, dataType);
    }
    const value = lowerer.context.compileValue(unwrapped);
    if (value.kind === "callback") {
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    }
    if (value.kind === "data" && value.dataType?.kind === "function") {
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    }
    lowerer.context.fail(unwrapped, "Expected a local function with a native data signature.");
}

function valueFunction(dataType: DataType<"function">, lowerer: DataSinkHost, value: Value, _node: ts.Node): string | undefined {
    if (value.kind === "json-null") {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (value.kind === "callback" &&
        value.cpp.length > 0 &&
        value.callbackDeclaration &&
        !dataType.identity) {
        const nativeType = lowerer.dataTypeAt(value.callbackDeclaration);
        if (nativeType?.kind === "function" &&
            dataTypesEqual(nativeType, dataType)) {
            // A self-referential local is already materialized as
            // native callback storage so its own body can refer to
            // the initialized binding. Plain function sinks share
            // that storage instead of attempting to lower the
            // declaration a second time.
            return value.cpp;
        }
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "function" &&
        dataTypesEqual({...value.dataType, identity:true}, {...dataType, identity:true})) {
        return value.cpp;
    }
    if (value.kind === "callback" &&
        value.cpp.length > 0 &&
        value.nativeCallbackParameterTypes !== undefined &&
        dataType.restParameter === undefined &&
        !dataType.identity &&
        value.nativeCallbackParameterTypes.length ===
            dataType.parameters.length &&
        value.nativeCallbackParameterTypes.every((parameter, index) => parameter !== undefined &&
            dataTypesEqual(parameter, dataType.parameters[index]!)) &&
        ((value.nativeCallbackReturnType === undefined &&
            dataType.result === undefined) ||
            (value.nativeCallbackReturnType !== undefined &&
                dataType.result !== undefined &&
                dataTypesEqual(value.nativeCallbackReturnType, dataType.result)))) {
        return value.cpp;
    }
    if (value.kind === "callback" &&
        value.callbackDeclaration) {
        const nativeType = lowerer.dataTypeAt(value.callbackDeclaration);
        if (nativeType?.kind === "function" && nativeType.restParameter !== undefined && dataType.restParameter === undefined) {
            const cpp = lowerer.context.compileStoredDataFunction(value.callbackDeclaration, nativeType, value.callbackRecordOwner);
            return lowerer.compileKnownValueForSink(lowerer.leafValue(cpp, nativeType), dataType, value.callbackDeclaration);
        }
        return lowerer.context.compileStoredDataFunction(value.callbackDeclaration, dataType, value.callbackRecordOwner);
    }
    if (value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    const source = value.dataType;
    if (source?.kind === "function" && source.restParameter !== undefined &&
        dataType.restParameter === undefined && !source.erasedParameters?.length &&
        !dataType.erasedParameters?.length && dataType.parameters.length >= source.restParameter &&
        (dataType.result === undefined || (source.result && dataTypesEqual(source.result, dataType.result)))) {
        const rest = source.parameters[source.restParameter];
        if (rest?.kind !== "vector") return undefined;
        const parameters = dataType.parameters.map((type, index) => ({
            type, name:`argument_${index}`,
        }));
        if (!parameters.every(({type}, index) => dataTypesEqual(type,
            index < source.restParameter! ? source.parameters[index]! : rest.element))) return undefined;
        const values = parameters.map(({name}) => name);
        const args = values.slice(0, source.restParameter);
        args.push(`${lowerer.context.dataTypes.cppType(rest)}{${values.slice(source.restParameter).join(", ")}}`);
        const result = dataType.result ? lowerer.context.dataTypes.cppType(dataType.result) : "void";
        return `bbl::js::adapt_callback<${lowerer.context.dataTypes.cppType(dataType)}>(${value.cpp}, ` +
            `[](${lowerer.context.dataTypes.cppType(source)}& callback${parameters.map(({type, name}) =>
                `, ${lowerer.context.dataTypes.cppType(type)} ${name}`).join("")}) -> ${result} { ` +
            `${dataType.result ? "return " : "static_cast<void>("}callback(${args.join(", ")})${dataType.result ? "" : ")"}; })`;
    }
    return undefined;
}

export const functionsSinks: DataSinkOperations<"function"> = {
    "function": { expression: expressionFunction, value: valueFunction }
};
