import ts from "typescript";
import {
    dataTypesEqual,
    functionArmIndex,
    soleMemberIndex,
    type DataType,
} from "../data-types.js";
import type { Value } from "../types.js";
import { valueDataType } from "../values/model.js";
import { writable } from "../emission-transaction.js";
import { isJsonValue } from "../json-bridge.js";
import { declaredContextualType } from "../type-facts.js";
import {
    unwrappedKnownValue,
    type DataSinkHost,
    type DataSinkOperations,
} from "./contracts.js";

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
    // A callback keeps its declaration's checked signature even when a
    // container stores it without an expression or contextual type of its
    // own. Reads and writes select the same arm even when equivalent
    // declarations carry different completion proofs.
    let memberIndex: number;
    if (
        (value.kind === "callback" && value.callbackDeclaration) ||
        value.dataType?.kind === "function"
    ) {
        memberIndex = functionArmIndex(type, () => {
            const declaration = value.callbackDeclaration;
            return declaration
                ? lowerer.context.dataTypes.fromStoredTsType(
                      lowerer.context.checker.getTypeAtLocation(declaration),
                      declaration,
                  )
                : value.dataType;
        });
        if (memberIndex < 0) return undefined;
    } else
        memberIndex = type.members.findIndex(
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
    // Beside other record types it converts as the one its position
    // declares: a discriminated literal's field, the member its
    // discriminant selects.
    if (
        memberIndex < 0 &&
        (source?.kind === "struct" || value.kind === "record") &&
        records.length > 1 &&
        expression
    ) {
        const declared = declaredContextualType(
            lowerer.context.checker,
            expression,
        );
        const stored =
            declared &&
            lowerer.context.dataTypes.fromStoredTsType(declared, expression);
        if (stored?.kind === "struct")
            memberIndex = type.members.findIndex((member) =>
                dataTypesEqual(member, stored),
            );
    }
    // An array stored as the union's one array type converts through the
    // array sink, which decides how its elements are stored as that type's.
    const arrays = type.members.filter((member) => member.kind === "vector");
    if (memberIndex < 0 && source?.kind === "vector" && arrays.length === 1)
        memberIndex = type.members.indexOf(arrays[0]!);
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
        expression: unwrappedKnownValue,
        value: unionValue,
    },
};
