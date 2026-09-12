import ts from "typescript";

import { type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import { isJsonValue } from "../json-bridge.js";
import {eventTargetCpp} from "../dom-targets.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionNumber(_dataType: DataType<"number">, lowerer: DataSinkHost, expression: ts.Expression, _unwrapped: ts.Expression): string {
    return lowerer.context.compileNumber(expression, "double");
}

function expressionBoolean(_dataType: DataType<"boolean">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.context.compileCondition(unwrapped);
}

function expressionBorrowedPlatformEvent(dataType: DataType<"borrowed-platform-event">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    const value = lowerer.context.compileValue(unwrapped);
    return valueBorrowedPlatformEvent(dataType, lowerer, value, unwrapped) ??
        lowerer.context.fail(unwrapped, `A borrowed DOM ${dataType.event} event must come from the active synchronous platform callback.`);
}

function expressionString(dataType: DataType<"string">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.compileStringSink(unwrapped, dataType);
}

function expressionJson(dataType: DataType<"json">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), dataType, unwrapped);
}

function valueJson(_dataType: DataType<"json">, lowerer: DataSinkHost, value: Value): string | undefined {
    if (isJsonValue(value)) {
        lowerer.markEscaped(value);
        return value.cpp;
    }
    if (value.kind === "json-null") return value.cpp === "std::nullopt"
        ? "bbl::js::JsonValue{}" : "bbl::js::JsonValue::null_value()";
    return undefined;
}

function valueNumber(_dataType: DataType<"number">, lowerer: DataSinkHost, value: Value, _node: ts.Node): string | undefined {
    // A parsed document coerces at the sink, which is where
    // JavaScript coerces one: `Number(document)`.
    if (isJsonValue(value)) {
        return lowerer.context.castNumber(value, "double");
    }
    if (value.kind !== "number")
        return undefined;
    // A data-model number is a native double, which is the
    // width `castNumber` writes a static lane at.
    return lowerer.context.castNumber(value, "double");
}

function valueBoolean(_dataType: DataType<"boolean">, _lowerer: DataSinkHost, value: Value, _node: ts.Node): string | undefined {
    if (value.kind === "boolean")
        return value.cpp;
    if (isJsonValue(value)) {
        return `${value.cpp}.truthy()`;
    }
    return undefined;
}

function valueBorrowedPlatformEvent(dataType: DataType<"borrowed-platform-event">, lowerer: DataSinkHost, value: Value, _node: ts.Node): string | undefined {
    const compatible = dataType.event === "error" || dataType.event === "rejection"
        ? value.nativeErrorEvent && value.recordProperties?.type?.staticString === (dataType.event === "error" ? "error" : "unhandledrejection")
        : dataType.event === "event"
        ? value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event"
        : value.kind ===
            `platform-${dataType.event}-event`;
    if (!compatible)
        return undefined;
    return dataType.event === "event"
        ? `bbl::js::BorrowedEvent(${value.cpp})`
        : `${lowerer.context.dataTypes.cppType(dataType)}(${value.cpp})`;
}

function valueString(_dataType: DataType<"string">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.staticString !== undefined) {
        return lowerer.context.cppString(value.staticString);
    }
    if (value.kind === "string") {
        // Indexed string reads use the dedicated string Value
        // kind even though their character is selected at run
        // time. They are already native std::string expressions,
        // just like a data-model string leaf below.
        return value.cpp;
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "string") {
        return value.cpp;
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "enum") {
        return lowerer.context.dataTypes.enumToStringCpp(value.dataType, value.cpp, node);
    }
    if (isJsonValue(value)) {
        return `${value.cpp}.to_string()`;
    }
    return undefined;
}

export const scalarsSinks: DataSinkOperations<"event-target" | "http-response" | "promise" | "storage" | "date" | "date-time-format" | "number" | "boolean" | "string" | "json" | "borrowed-platform-event"> = {
    "event-target": {
        expression: (type, lowerer, expression) => lowerer.compileKnownValueForSink(lowerer.context.compileValue(expression), type, expression),
        value: (_type, lowerer, value, node) => eventTargetCpp(lowerer.context, value, node),
    },
    "http-response": {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), type, unwrapped),
        value: (_type, _lowerer, value) => value.dataType?.kind === "http-response" ? value.cpp : undefined,
    },
    promise: {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), type, unwrapped),
        value: (type, lowerer, value) => value.kind === "promise" && value.promiseType ===
            (type.result ? lowerer.context.dataTypes.cppType(type.result) : "bbl::js::PromiseVoid") ? value.cpp : undefined,
    },
    storage: {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), type, unwrapped),
        value: (_type, _lowerer, value) => value.dataType?.kind === "storage" ? value.cpp : undefined,
    },
    "date-time-format": {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.requireDataValue(unwrapped, type).cpp,
        value: (_type, _lowerer, value) => value.dataType?.kind === "date-time-format" ? value.cpp : undefined,
    },
    "date": {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.requireDataValue(unwrapped, type).cpp,
        value: (_type, _lowerer, value) => value.dataType?.kind === "date" ? value.cpp : undefined,
    },
    "number": { expression: expressionNumber, value: valueNumber },
    "boolean": { expression: expressionBoolean, value: valueBoolean },
    "string": { expression: expressionString, value: valueString },
    "json": { expression: expressionJson, value: valueJson },
    "borrowed-platform-event": { expression: expressionBorrowedPlatformEvent, value: valueBorrowedPlatformEvent }
};
