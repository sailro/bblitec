import ts from "typescript";
import {
    dataTypesEqual,
    soleMemberIndex,
    type DataType,
} from "../data-types.js";
import type { Value } from "../types.js";
import { valueDataType } from "../values/model.js";
import { writable } from "../emission-transaction.js";
import { isJsonValue } from "../json-bridge.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function unionValue(
    type: DataType<"union">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.dataType && dataTypesEqual(value.dataType, type))
        return value.cpp;
    if (value.dataType?.kind === "union") {
        const source = lowerer.context.allocateTemporaryCppName("union_source");
        const arms = value.dataType.members.map((member, index) => {
            let converted: string | undefined;
            const lines = lowerer.context.captureEmittedLines(() => {
                const projected = lowerer.leafValue(
                    `std::get<${index}>(${source})`,
                    member,
                );
                if (value.engineOwnerParameter)
                    writable(projected).engineOwnerParameter =
                        value.engineOwnerParameter;
                converted = unionValue(type, lowerer, projected, node);
            });
            return converted === undefined
                ? ""
                : `case ${index}: { ${lines.join("\n")} return ${converted}; }`;
        });
        if (arms.every((arm) => arm === "")) return undefined;
        return (
            `([&]() -> ${lowerer.context.dataTypes.cppType(type)} { const auto ${source} = ${value.cpp}; ` +
            `switch (${source}.index()) { ${arms.join(" ")} default: throw std::runtime_error("Value is outside the destination union."); } }())`
        );
    }
    // A parsed value is stored as the member its expression's (narrowed)
    // type names: `typeof v === "number"` selects the number member.
    const expression = lowerer.convertedExpression(node);
    const source =
        (isJsonValue(value) && expression
            ? lowerer.dataTypeAt(expression)
            : undefined) ??
        valueDataType(value) ??
        (ts.isExpression(node) ? lowerer.dataTypeAt(node) : undefined);
    let memberIndex = type.members.findIndex(
        (member) =>
            source &&
            (dataTypesEqual(source, member) ||
                lowerer.spanCompatible(source, member) ||
                (source.kind === "enum" && member.kind === "string")),
    );
    // Record literals and arrays can have a contextual union type. Select the
    // arm through the normal sinks so field conversion and escape rules agree.
    if (memberIndex < 0)
        memberIndex = type.members.findIndex((member) =>
            lowerer.knownValueFitsSink(value, member, node),
        );
    // A function is the union's one function arm, lowered into its storage;
    // beside others, the arm of the signature its place in the program
    // gives it (a record property's declared method).
    if (
        memberIndex < 0 &&
        ((value.kind === "callback" && value.callbackDeclaration) ||
            value.dataType?.kind === "function")
    ) {
        memberIndex = soleMemberIndex(type, "function");
        const contextual =
            memberIndex < 0 && expression
                ? lowerer.context.checker.getContextualType(expression)
                : undefined;
        const signature =
            contextual &&
            lowerer.context.dataTypes.fromStoredTsType(contextual, node);
        if (signature?.kind === "function")
            memberIndex = type.members.findIndex(
                (member) =>
                    member.kind === "function" &&
                    dataTypesEqual(
                        { ...member, identity: true },
                        { ...signature, identity: true },
                    ),
            );
    }
    // A promise is the union's one promise arm, stored as that arm stores
    // one (`T | Promise<T>` returning what an async call returned).
    if (memberIndex < 0 && value.kind === "promise")
        memberIndex = soleMemberIndex(type, "promise");
    // A record stored as the union's one record type converts through
    // the record sink, which decides how the two types share the object.
    const records = type.members.filter((member) => member.kind === "struct");
    if (
        memberIndex < 0 &&
        (source?.kind === "struct" || value.kind === "record") &&
        records.length === 1
    )
        memberIndex = type.members.indexOf(records[0]!);
    // A parsed value never holds a native handle or function: beside those
    // members it is the union's one scalar member, converted as it is read.
    if (memberIndex < 0 && isJsonValue(value)) {
        const documentMembers = type.members.filter(
            (member) => member.kind !== "handle" && member.kind !== "function",
        );
        if (
            documentMembers.length === 1 &&
            ["string", "number", "boolean"].includes(documentMembers[0]!.kind)
        )
            memberIndex = type.members.indexOf(documentMembers[0]!);
    }
    if (memberIndex < 0) return undefined;
    const cpp = lowerer.compileKnownValueForSink(
        value,
        type.members[memberIndex]!,
        node,
    );
    return `${lowerer.context.dataTypes.cppType(type)}{std::in_place_index<${memberIndex}>, ${cpp}}`;
}

export const unionsSinks: DataSinkOperations<"union"> = {
    union: {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: unionValue,
    },
};
