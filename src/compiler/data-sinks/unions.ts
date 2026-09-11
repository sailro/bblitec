import ts from "typescript";
import { dataTypesEqual, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function unionValue(type: DataType<"union">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.dataType && dataTypesEqual(value.dataType, type)) return value.cpp;
    const source = value.dataType ?? (value.kind === "number" || value.kind === "boolean" || value.kind === "string"
        ? { kind: value.kind } as DataType : ts.isExpression(node) ? lowerer.dataTypeAt(node) : undefined);
    let memberIndex = type.members.findIndex(member => source &&
        (dataTypesEqual(source, member) || lowerer.spanCompatible(source, member) ||
            (source.kind === "enum" && member.kind === "string")));
    // Record literals and arrays can have a contextual union type. Select the
    // arm through the normal sinks so field conversion and escape rules agree.
    if (memberIndex < 0) memberIndex = type.members.findIndex(member => lowerer.knownValueFitsSink(value, member, node));
    if (memberIndex < 0) return undefined;
    const cpp = lowerer.compileKnownValueForSink(value, type.members[memberIndex]!, node);
    return `${lowerer.context.dataTypes.cppType(type)}{std::in_place_index<${memberIndex}>, ${cpp}}`;
}

export const unionsSinks: DataSinkOperations<"union"> = {
    union: {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(lowerer.context.compileValue(unwrapped), type, unwrapped),
        value: unionValue,
    },
};
