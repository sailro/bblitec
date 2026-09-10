import ts from "typescript";

import { type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import { isJsonValue } from "../json-bridge.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionNumber(_dataType: DataType<"number">, lowerer: DataSinkHost, expression: ts.Expression, _unwrapped: ts.Expression): string {
    return lowerer.context.compileNumber(expression, "double");
}

function expressionBoolean(_dataType: DataType<"boolean">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.context.compileCondition(unwrapped);
}

function expressionBorrowedPlatformEvent(dataType: DataType<"borrowed-platform-event">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    const value = lowerer.context.compileValue(unwrapped);
    const compatible = dataType.event === "event"
        ? value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event"
        : value.kind ===
            `platform-${dataType.event}-event`;
    if (!compatible) {
        lowerer.context.fail(unwrapped, `A borrowed DOM ${dataType.event === "event" ? "Event" : dataType.event === "mouse" ? "MouseEvent" : "KeyboardEvent"} must come from the active synchronous platform callback.`);
    }
    return dataType.event === "event"
        ? `bbl::js::BorrowedEvent(${value.cpp})`
        : `${lowerer.context.dataTypes.cppType(dataType)}(${value.cpp})`;
}

function expressionString(dataType: DataType<"string">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.compileStringSink(unwrapped, dataType);
}

function expressionJson(dataType: DataType<"json">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    // A parsed document is only ever produced by `JSON.parse`,
    // so a JSON sink is filled by a value that already is one.
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
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
    const compatible = dataType.event === "event"
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

export const scalarsSinks: DataSinkOperations<"number" | "boolean" | "string" | "json" | "borrowed-platform-event"> = {
    "number": { expression: expressionNumber, value: valueNumber },
    "boolean": { expression: expressionBoolean, value: valueBoolean },
    "string": { expression: expressionString, value: valueString },
    "json": { expression: expressionJson, value: () => undefined },
    "borrowed-platform-event": { expression: expressionBorrowedPlatformEvent, value: valueBorrowedPlatformEvent }
};
