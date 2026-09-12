import ts from "typescript";

import { dataTypesEqual, doubleLiteral, type DataType } from "../data-types.js";
import type { Value } from "../types.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionOptional(dataType: DataType<"optional">, lowerer: DataSinkHost, expression: ts.Expression, _unwrapped: ts.Expression): string {
    return lowerer.compileOptionalSink(expression, dataType);
}

function expressionVector(dataType: DataType<"vector">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.compileVectorSink(unwrapped, dataType);
}

function expressionMapOrSet(dataType: DataType<"map" | "set">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    if (dataType.kind === "map" &&
        ts.isObjectLiteralExpression(unwrapped)) {
        return lowerer.openRecordLiteral(unwrapped, dataType);
    }
    if (dataType.kind === "map" &&
        (ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped))) {
        const known = lowerer.context.compileValue(unwrapped);
        if (known.kind === "record") {
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
    }
    if (ts.isNewExpression(unwrapped)) {
        const created = lowerer.compileMapOrSetNew(unwrapped, dataType);
        if (created?.dataType &&
            dataTypesEqual(created.dataType, dataType)) {
            return created.cpp;
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function expressionSpanOrTupleOrTable(dataType: DataType<"span" | "tuple" | "table">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    return lowerer.spanLikeForSink(unwrapped, dataType);
}

function valueOptional(dataType: DataType<"optional">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "void") {
        lowerer.context.emitDiscardedValue(value);
        return "std::nullopt";
    }
    if (value.kind === "json-null") {
        return "std::nullopt";
    }
    if (value.dataType?.kind === "optional") {
        const sourceType = value.dataType.inner;
        const source = lowerer.context.allocateTemporaryCppName("optional_source");
        let converted = "";
        const lines = lowerer.context.captureEmittedLines(() => {
            converted = lowerer.compileKnownValueForSink(lowerer.leafValue(`(*${source})`, sourceType), dataType.inner, node);
        });
        return `([&]() -> ${lowerer.context.dataTypes.cppType(dataType)} { ` +
            `const auto ${source} = (${value.cpp}).to_optional(); if (!${source}) return std::nullopt; ` +
            `${lines.join("\n")} return ${converted}; }())`;
    }
    return lowerer.compileKnownValueForSink(value, dataType.inner, node);
}

function valueVector(dataType: DataType<"vector">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "handle-collection" &&
        value.handleCollection &&
        dataType.element.kind === "handle" &&
        value.handleCollection.elementKind ===
            dataType.element.handle) {
        lowerer.context.reachJsData();
        return `bbl::js::array_from_iterable<${lowerer.context.dataTypes.cppType(dataType.element)}>(` +
            `${value.handleCollection.containerCpp})`;
    }
    if (value.kind === "tuple") {
        lowerer.context.reachJsData();
        const elements = value.tupleElements ?? [];
        elements.forEach((entry, index) => lowerer.context.recordDataLightSlot(entry, index));
        return `bbl::js::Array<${lowerer.context.dataTypes.cppType(dataType.element)}>{${elements
            .map((entry) => lowerer.compileKnownValueForSink(entry, dataType.element, node))
            .join(", ")}}`;
    }
    if (value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "span" &&
        dataTypesEqual(value.dataType.element, dataType.element)) {
        lowerer.context.fail(node,
            "A borrowed array view cannot retain JavaScript array identity in owning storage.");
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "vector" &&
        (value.dataType.element.kind === "struct" ||
            value.dataType.element.kind === "map") &&
        dataType.element.kind === "struct") {
        lowerer.context.reachJsData();
        const source = lowerer.context.allocateTemporaryCppName("project_source");
        const item = lowerer.context.allocateTemporaryCppName("project_item");
        const result = lowerer.context.allocateTemporaryCppName("project_result");
        const destinationCpp = lowerer.context.dataTypes.cppType(dataType);
        const projected = lowerer.compileKnownValueForSink(lowerer.leafValue(item, value.dataType.element), dataType.element, node);
        return (`[&]() { auto ${source} = ${value.cpp}; ` +
            `${destinationCpp} ${result}; ` +
            `${result}.reserve(${source}.size()); ` +
            `for (const auto& ${item} : ${source}) ` +
            `${result}.push_back(${projected}); ` +
            `return ${result}; }()`);
    }
    return undefined;
}

function valueMap(dataType: DataType<"map">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "record") {
        const entries = Object.entries(value.recordProperties ?? {}).map(([name, entry]) => {
            const key = dataType.key.kind === "string"
                ? lowerer.context.cppString(name)
                : dataType.key.kind === "number"
                    ? doubleLiteral(Number(name))
                    : lowerer.context.fail(node, "Compile-time open Records require string or number keys.");
            return `{${key}, ${lowerer.compileKnownValueForSink(entry, dataType.value, node)}}`;
        });
        lowerer.context.reachJsData();
        return `${lowerer.context.dataTypes.cppType(dataType)}{${entries.join(", ")}}`;
    }
    if (value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueSpan(dataType: DataType<"span">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "handle-collection" &&
        value.handleCollection &&
        dataType.element.kind === "handle" &&
        value.handleCollection.elementKind ===
            dataType.element.handle) {
        lowerer.context.reachJsData();
        return `bbl::js::array_from_iterable<${lowerer.context.dataTypes.cppType(dataType.element)}>(` +
            `${value.handleCollection.containerCpp})`;
    }
    if (value.kind === "tuple") {
        lowerer.context.reachJsData();
        (value.tupleElements ?? []).forEach((entry, index) => lowerer.context.recordDataLightSlot(entry, index));
        return `bbl::js::Array<${lowerer.context.dataTypes.cppType(dataType.element)}>{${(value.tupleElements ?? [])
            .map((entry) => lowerer.compileKnownValueForSink(entry, dataType.element, node))
            .join(", ")}}`;
    }
    if (value.dataType &&
        lowerer.spanCompatible(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueSetOrTable(dataType: DataType<"set" | "table">, _lowerer: DataSinkHost, value: Value, _node: ts.Node): string | undefined {
    if (value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueTuple(dataType: DataType<"tuple">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "tuple" &&
        (value.tupleElements?.length ?? 0) ===
            dataType.arity) {
        return `bbl::js::Tuple<${dataType.arity}>{${value
            .tupleElements!.map((entry) => lowerer.compileKnownValueForSink(entry, { kind: "number" }, node))
            .join(", ")}}`;
    }
    if (value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueProduct(dataType: DataType<"product">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "tuple" && value.tupleElements?.length === dataType.elements.length) {
        lowerer.context.reachJsData();
        return `${lowerer.context.dataTypes.cppType(dataType)}{${value.tupleElements.map((entry, index) =>
            lowerer.compileKnownValueForSink(entry, dataType.elements[index]!, node)).join(", ")}}`;
    }
    return value.dataType && dataTypesEqual(value.dataType, dataType) ? value.cpp : undefined;
}

export const containersSinks: DataSinkOperations<"optional" | "vector" | "map" | "set" | "iterator" | "span" | "tuple" | "product" | "table"> = {
    "iterator": {
        expression: (type, lowerer, _expression, unwrapped) => lowerer.requireDataValue(unwrapped, type).cpp,
        value: (type, _lowerer, value) => value.dataType && dataTypesEqual(type, value.dataType) ? value.cpp : undefined,
    },
    "product": {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), type, unwrapped),
        value: valueProduct,
    },
    "optional": { expression: expressionOptional, value: valueOptional },
    "vector": { expression: expressionVector, value: valueVector },
    "map": { expression: expressionMapOrSet, value: valueMap },
    "set": { expression: expressionMapOrSet, value: valueSetOrTable },
    "span": { expression: expressionSpanOrTupleOrTable, value: valueSpan },
    "tuple": { expression: expressionSpanOrTupleOrTable, value: valueTuple },
    "table": { expression: expressionSpanOrTupleOrTable, value: valueSetOrTable }
};
