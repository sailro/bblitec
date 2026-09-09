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
                return lowerer.context.compileStoredDataFunction(callback.callbackDeclaration, dataType, callback.callbackRecordOwner);
            }
        }
        return lowerer.context.compileStoredDataFunction(unwrapped, dataType);
    }
    const value = lowerer.context.compileValue(unwrapped);
    if (value.kind === "callback") {
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    }
    if (value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
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
        value.dataType.identity === true &&
        !dataType.identity &&
        value.dataType.parameters.length ===
            dataType.parameters.length &&
        value.dataType.parameters.every((parameter, index) => dataTypesEqual(parameter, dataType.parameters[index]!)) &&
        ((value.dataType.result === undefined &&
            dataType.result === undefined) ||
            (value.dataType.result !== undefined &&
                dataType.result !== undefined &&
                dataTypesEqual(value.dataType.result, dataType.result)))) {
        return value.cpp;
    }
    if (value.kind === "callback" &&
        value.cpp.length > 0 &&
        value.nativeCallbackParameterTypes !== undefined &&
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
        return lowerer.context.compileStoredDataFunction(value.callbackDeclaration, dataType, value.callbackRecordOwner);
    }
    if (value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

export const functionsSinks: DataSinkOperations<"function"> = {
    "function": { expression: expressionFunction, value: valueFunction }
};
