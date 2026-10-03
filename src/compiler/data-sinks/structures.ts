import ts from "typescript";
import { EmissionMap } from "../emission-transaction.js";
import {
    dataTypesEqual,
    type DataStructField,
    type DataType,
} from "../data-types.js";
import {
    isStringValue,
    optionalPresentCpp,
    optionalValueCpp,
    type Value,
} from "../types.js";
import { isJsonValue } from "../json-bridge.js";
import { isNullishLiteral } from "../symbols.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionEnum(
    dataType: DataType<"enum">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    const resolved = lowerer.context.resolveStaticExpression(unwrapped);
    if (resolved !== unwrapped) {
        return lowerer.compileForSink(resolved, dataType);
    }
    if (
        ts.isStringLiteral(unwrapped) ||
        ts.isNoSubstitutionTemplateLiteral(unwrapped)
    ) {
        return lowerer.context.dataTypes.enumMemberCpp(
            dataType,
            unwrapped.text,
            unwrapped,
        );
    }
    const rawValue =
        lowerer.compileDataPath(unwrapped, "read") ??
        (ts.isCallExpression(unwrapped) ||
        ts.isIdentifier(unwrapped) ||
        ts.isPropertyAccessExpression(unwrapped) ||
        ts.isElementAccessExpression(unwrapped)
            ? lowerer.context.compileValue(unwrapped)
            : undefined);
    const value =
        rawValue?.kind === "data"
            ? lowerer.narrowOptional(rawValue, expression)
            : rawValue;
    if (value) {
        const compiled = valueEnum(dataType, lowerer, value, unwrapped);
        if (compiled !== undefined) return compiled;
    }
    // An inlined function's tag parameter carries the
    // literal it was called with, so a name bound to a
    // known string names its member just as the literal
    // written in place would.
    if (ts.isIdentifier(unwrapped)) {
        const bound = lowerer.context.bindings.lookupOptional(unwrapped);
        if (bound?.staticString !== undefined) {
            return lowerer.context.dataTypes.enumMemberCpp(
                dataType,
                bound.staticString,
                unwrapped,
            );
        }
    }
    lowerer.context.fail(
        unwrapped,
        `Expected a ${dataType.name} literal or value.`,
    );
}

function expressionStruct(
    dataType: DataType<"struct">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (
        ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
        const selected = lowerer.compileNullishCoalesce(unwrapped);
        if (selected) {
            return lowerer.compileKnownValueForSink(
                selected,
                dataType,
                unwrapped,
            );
        }
    }
    if (
        lowerer.context.dataTypes.isReferenceStruct(dataType.name) &&
        isNullishLiteral(lowerer.context.checker, unwrapped)
    ) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
        if (
            unwrapped.properties.some((property) =>
                ts.isSpreadAssignment(property),
            )
        ) {
            const temporary =
                lowerer.context.allocateTemporaryCppName("spread");
            lowerer.emitSpreadStructDeclaration(temporary, unwrapped, dataType);
            lowerer.registerLocal(temporary, "owned");
            return temporary;
        }
        return lowerer.structLiteral(unwrapped, dataType);
    }
    if (
        ts.isCallExpression(unwrapped) ||
        ts.isNewExpression(unwrapped) ||
        ts.isIdentifier(unwrapped) ||
        unwrapped.kind === ts.SyntaxKind.ThisKeyword ||
        ts.isPropertyAccessExpression(unwrapped) ||
        ts.isElementAccessExpression(unwrapped)
    ) {
        const known = lowerer.context.compileValue(unwrapped);
        if (
            known.kind === "record" ||
            ((known.kind === "json-null" ||
                known.dataType?.kind === "optional") &&
                lowerer.context.dataTypes.isReferenceStruct(dataType.name))
        ) {
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
        if (
            known.kind === "data" &&
            (known.dataType?.kind === "struct" ||
                known.dataType?.kind === "map")
        ) {
            lowerer.markEscaped(known);
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.ownedCpp ?? value.cpp;
}

function expressionEnummap(
    dataType: DataType<"enummap">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (ts.isObjectLiteralExpression(unwrapped)) {
        return lowerer.enumMapLiteral(unwrapped, dataType);
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function valueEnum(
    dataType: DataType<"enum">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (isJsonValue(value)) {
        return lowerer.context.dataTypes.enumFromStringCpp(
            dataType,
            `${value.cpp}.to_string()`,
            node,
        );
    }
    if (value.staticString !== undefined) {
        return lowerer.context.dataTypes.enumMemberCpp(
            dataType,
            value.staticString,
            node,
        );
    }
    if (isStringValue(value)) {
        return lowerer.context.dataTypes.enumFromStringCpp(
            dataType,
            value.cpp,
            node,
        );
    }
    if (
        value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)
    ) {
        return value.cpp;
    }
    if (value.dataType?.kind === "enum") {
        return lowerer.context.dataTypes.enumFromStringCpp(
            dataType,
            lowerer.context.dataTypes.enumToStringCpp(
                value.dataType,
                value.cpp,
                node,
            ),
            node,
        );
    }
    return undefined;
}

function valueStruct(
    dataType: DataType<"struct">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (
        value.dataType?.kind === "optional" &&
        lowerer.context.dataTypes.isReferenceStruct(dataType.name)
    ) {
        const source = lowerer.context.allocateTemporaryCppName(
            "optional_record_source",
        );
        const target = lowerer.context.dataTypes.cppType(dataType);
        const present = lowerer.leafValue(
            optionalValueCpp(source),
            value.dataType.inner,
        );
        let converted = "";
        const lines = lowerer.context.captureEmittedLines(() => {
            converted = lowerer.compileKnownValueForSink(
                present,
                dataType,
                node,
            );
        });
        return (
            `([&]() -> ${target} {\n` +
            `    const auto& ${source} = ${value.cpp};\n` +
            `    if (!${optionalPresentCpp(source)}) return {};\n` +
            lines.map((line) => `    ${line}\n`).join("") +
            `    return ${converted};\n}())`
        );
    }
    if (
        value.dataType?.kind === "struct" &&
        value.dataType.name === dataType.name &&
        lowerer.context.dataTypes.isClassStruct(dataType.name)
    ) {
        // A shared class instance is already the `Ref` the sink
        // stores, whether it was just constructed (a record over
        // that Ref) or read back out of a container.
        lowerer.context.dataTypes.cppType(dataType);
        return value.ownedCpp ?? value.cpp;
    }
    if (
        lowerer.context.dataTypes.isClassStruct(dataType.name) &&
        value.kind === "record"
    ) {
        lowerer.context.fail(
            node,
            `An instance of '${dataType.name}' constructed before ` +
                "anything stored one is a compile-time record; " +
                "storing it here would mint a second object with " +
                "the same fields rather than share this one.",
        );
    }
    if (
        value.kind === "json-null" &&
        lowerer.context.dataTypes.isReferenceStruct(dataType.name)
    ) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "struct" &&
        dataTypesEqual(value.dataType, dataType)
    ) {
        return value.ownedCpp ?? value.cpp;
    }
    // A structural view of a stored class binds its prototype methods to
    // the retained receiver, just as a view of a local class record does.
    value = lowerer.context.classLowerer.hydrate(value, node) ?? value;
    if (value.kind === "record") {
        lowerer.context.dataTypes.cppType(dataType);
        const fields = lowerer.context.dataTypes.structFields(
            dataType.name,
            node,
            "accessors",
        );
        const aggregate = `bblscene::${dataType.name}${lowerer.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
            .map((field) => {
                const getter = value.recordGetters?.[field.sourceName];
                const setter = value.recordSetters?.[field.sourceName];
                if (getter || setter)
                    return accessorSlot(lowerer, field, value, node);
                if (field.type.kind === "function") {
                    const method =
                        value.recordMethods?.[field.sourceName] ??
                        lowerer.context.classLowerer.viewMethod(
                            value,
                            field.sourceName,
                            node,
                        );
                    if (method) {
                        lowerer.context.recordProxies.requireIndependentFunction(
                            field,
                            method,
                        );
                        const callback =
                            lowerer.context.compileStoredDataFunction(
                                method,
                                field.type,
                                value,
                                ts.isMethodDeclaration(method) &&
                                    ts.isClassDeclaration(method.parent),
                            );
                        return lowerer.context.dataTypes.structFieldInitializerCpp(
                            field,
                            callback,
                        );
                    }
                }
                const property = value.recordProperties?.[field.sourceName];
                if (property?.callbackDeclaration)
                    lowerer.context.recordProxies.requireIndependentFunction(
                        field,
                        property.callbackDeclaration,
                    );
                const stored = property
                    ? lowerer.compileKnownValueForSink(
                          property,
                          field.type,
                          node,
                      )
                    : field.defaultWhenMissing
                      ? "{}"
                      : field.type.kind === "optional"
                        ? "std::nullopt"
                        : lowerer.context.fail(
                              node,
                              `Compile-time record is missing required field '${field.sourceName}'.`,
                          );
                return lowerer.context.dataTypes.structFieldInitializerCpp(
                    field,
                    stored,
                );
            })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    if (value.kind === "data" && value.dataType?.kind === "struct") {
        const sourceType = value.dataType;
        const sourceFields = new EmissionMap(
            lowerer.context.dataTypes
                .structFields(sourceType.name, node, "accessors")
                .map((field) => [field.sourceName, field]),
        );
        const sourceArrow = lowerer.context.dataTypes.isReferenceStruct(
            sourceType.name,
        );
        const fields = lowerer.context.dataTypes.structFields(
            dataType.name,
            node,
            "accessors",
        );
        const aggregate = `bblscene::${dataType.name}${lowerer.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
            .map((field) => {
                const source = sourceFields.get(field.sourceName);
                if (!source) {
                    if (field.defaultWhenMissing) {
                        return "{}";
                    }
                    if (field.type.kind === "optional") {
                        return "std::nullopt";
                    }
                    lowerer.context.fail(
                        node,
                        `Struct ${sourceType.name} is missing required destination field '${field.sourceName}'.`,
                    );
                }
                const sourceCpp = `${value.cpp}${sourceArrow ? "->" : "."}${source.name}`;
                // One object seen through two record types keeps its
                // accessors; a stored value becomes the target's cell.
                if (source.accessor || field.accessor) {
                    if (
                        source.accessor !== field.accessor ||
                        !dataTypesEqual(source.type, field.type)
                    )
                        lowerer.context.fail(
                            node,
                            `Property '${field.sourceName}' is an accessor in one of '${sourceType.name}' and '${dataType.name}' but not the other.`,
                        );
                    return sourceCpp;
                }
                return lowerer.compileKnownValueForSink(
                    lowerer.leafValue(sourceCpp, source.type),
                    field.type,
                    node,
                );
            })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "map" &&
        value.dataType.key.kind === "string"
    ) {
        const sourceMap = value.dataType;
        const fields = lowerer.context.dataTypes.structFields(
            dataType.name,
            node,
            "accessors",
        );
        const aggregate = `bblscene::${dataType.name}${lowerer.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
            .map((field) => {
                const key = lowerer.context.cppString(field.sourceName);
                const optional =
                    field.type.kind === "optional" &&
                    dataTypesEqual(sourceMap.value, field.type.inner);
                // A closed record asserted from the open one is a view of
                // it: reads and writes reach its entries, and a read of an
                // absent entry refuses there, as an asserted read does.
                if (
                    field.accessor &&
                    (optional || dataTypesEqual(sourceMap.value, field.type))
                )
                    return `bbl::js::${optional ? "optional_entry_accessor" : "entry_accessor"}<${lowerer.context.dataTypes.cppType(field.type)}>(${value.cpp}, ${key})`;
                if (!field.accessor && optional)
                    return `${value.cpp}.get(${key})`;
                return lowerer.context.fail(
                    node,
                    `Open string record cannot project field '${field.sourceName}' into ${dataType.name}; destination fields must be compatible optionals.`,
                );
            })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    return undefined;
}

/** A record's accessor property: its getter and setter in the field's accessor slot. */
function accessorSlot(
    lowerer: DataSinkHost,
    field: DataStructField,
    record: Value,
    node: ts.Node,
): string {
    const getter = record.recordGetters?.[field.sourceName];
    const setter = record.recordSetters?.[field.sourceName];
    if (!getter)
        lowerer.context.fail(
            node,
            `Property '${field.sourceName}' has a setter without a getter; a native record reads every property it stores.`,
        );
    if (!field.accessor)
        lowerer.context.fail(
            node,
            `Property '${field.sourceName}' is an accessor; the native record stores it as data.`,
        );
    const set = setter
        ? lowerer.context.compileStoredAccessor(
              record,
              setter,
              field.type,
              field.accessorReceiver
                  ? { kind: "struct", name: field.accessorReceiver }
                  : undefined,
          )
        : "{}";
    return `${lowerer.context.dataTypes.structFieldCppType(field)}(${lowerer.context.compileStoredAccessor(
        record,
        getter,
        field.type,
        field.accessorReceiver
            ? { kind: "struct", name: field.accessorReceiver }
            : undefined,
    )}, ${set})`;
}

function valueEnummap(
    dataType: DataType<"enummap">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.kind === "record") {
        const members = lowerer.context.dataTypes.enumMembers(
            dataType.enumName,
        );
        const properties = value.recordProperties ?? {};
        const written = Object.keys(properties);
        const unknown = written.find((name) => !members.includes(name));
        if (unknown) {
            lowerer.context.fail(
                node,
                `'${unknown}' is not a member of ${dataType.enumName}.`,
            );
        }
        const compiled = new EmissionMap(
            written.map((name) => [
                name,
                lowerer.compileKnownValueForSink(
                    properties[name]!,
                    dataType.element,
                    node,
                ),
            ]),
        );
        const reordered = members.some(
            (member, index) => written[index] !== member,
        );
        if (reordered) {
            for (const key of written) {
                const temporary =
                    lowerer.context.allocateTemporaryCppName("slot");
                lowerer.context.emit({
                    kind: "declaration",
                    type: lowerer.context.dataTypes.cppType(dataType.element),
                    name: temporary,
                    initializer: compiled.get(key)!,
                });
                lowerer.registerLocal(temporary, "owned");
                compiled.set(key, temporary);
            }
        }
        const slots = members.map((member) => {
            const slot = compiled.get(member);
            if (slot === undefined) {
                lowerer.context.fail(
                    node,
                    `Compile-time record is missing the '${member}' slot.`,
                );
            }
            return slot;
        });
        lowerer.context.reachJsData();
        return `${lowerer.context.dataTypes.cppType(dataType)}{${slots.join(", ")}}`;
    }
    if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

export const structuresSinks: DataSinkOperations<
    "enum" | "struct" | "enummap"
> = {
    enum: { expression: expressionEnum, value: valueEnum },
    struct: { expression: expressionStruct, value: valueStruct },
    enummap: { expression: expressionEnummap, value: valueEnummap },
};
