import ts from "typescript";
import { EmissionMap } from "../emission-transaction.js";
import { dataTypesEqual, type DataType } from "../data-types.js";
import type { Value } from "../types.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionEnum(dataType: DataType<"enum">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    const resolved = lowerer.context.resolveStaticExpression(unwrapped);
    if (resolved !== unwrapped) {
        return lowerer.compileForSink(resolved, dataType);
    }
    if (ts.isStringLiteral(unwrapped) ||
        ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
        return lowerer.context.dataTypes.enumMemberCpp(dataType, unwrapped.text, unwrapped);
    }
    const rawValue = lowerer.compileDataPath(unwrapped, "read") ??
        (ts.isCallExpression(unwrapped) ||
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
            ? lowerer.context.compileValue(unwrapped)
            : undefined);
    const value = rawValue?.kind === "data"
        ? lowerer.narrowOptional(rawValue, unwrapped)
        : rawValue;
    if (value?.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    if (value?.kind === "string" ||
        (value?.kind === "data" &&
            value.dataType?.kind === "string")) {
        return lowerer.context.dataTypes.enumFromStringCpp(dataType, value.cpp, unwrapped);
    }
    if (value?.kind === "data" &&
        value.dataType?.kind === "enum") {
        return lowerer.context.dataTypes.enumFromStringCpp(dataType, lowerer.context.dataTypes.enumToStringCpp(value.dataType, value.cpp, unwrapped), unwrapped);
    }
    // An inlined function's tag parameter carries the
    // literal it was called with, so a name bound to a
    // known string names its member just as the literal
    // written in place would.
    if (ts.isIdentifier(unwrapped)) {
        const bound = lowerer.context.lookupIdentifierValue(unwrapped);
        if (bound?.staticString !== undefined) {
            return lowerer.context.dataTypes.enumMemberCpp(dataType, bound.staticString, unwrapped);
        }
    }
    lowerer.context.fail(unwrapped, `Expected a ${dataType.name} literal or value.`);
}

function expressionStruct(dataType: DataType<"struct">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    if (ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind ===
            ts.SyntaxKind.QuestionQuestionToken) {
        const selected = lowerer.compileNullishCoalesce(unwrapped);
        if (selected) {
            return lowerer.compileKnownValueForSink(selected, dataType, unwrapped);
        }
    }
    if (ts.isConditionalExpression(unwrapped) &&
        lowerer.context.dataTypes.isReferenceStruct(dataType.name)) {
        return (`(${lowerer.context.compileCondition(unwrapped.condition)} ? ` +
            `${lowerer.compileForSink(unwrapped.whenTrue, dataType)} : ` +
            `${lowerer.compileForSink(unwrapped.whenFalse, dataType)})`);
    }
    if (lowerer.context.dataTypes.isReferenceStruct(dataType.name) &&
        (unwrapped.kind ===
            ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(unwrapped) &&
                unwrapped.text === "undefined" &&
                !lowerer.context.lookupIdentifierValue(unwrapped)))) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
        if (unwrapped.properties.some((property) => ts.isSpreadAssignment(property))) {
            const temporary = lowerer.context.allocateTemporaryCppName("spread");
            lowerer.emitSpreadStructDeclaration(temporary, unwrapped, dataType);
            lowerer.registerLocal(temporary, "owned");
            return temporary;
        }
        return lowerer.structLiteral(unwrapped, dataType);
    }
    if (ts.isCallExpression(unwrapped) ||
        ts.isNewExpression(unwrapped) ||
        ts.isIdentifier(unwrapped) ||
        unwrapped.kind === ts.SyntaxKind.ThisKeyword ||
        ts.isPropertyAccessExpression(unwrapped) ||
        ts.isElementAccessExpression(unwrapped)) {
        const known = lowerer.context.compileValue(unwrapped);
        if (known.kind === "record") {
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
        if (known.kind === "data" &&
            known.dataType?.kind === "struct") {
            lowerer.markEscaped(known);
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function expressionEnummap(dataType: DataType<"enummap">, lowerer: DataSinkHost, _expression: ts.Expression, unwrapped: ts.Expression): string {
    if (ts.isObjectLiteralExpression(unwrapped)) {
        return lowerer.enumMapLiteral(unwrapped, dataType);
    }
    const value = lowerer.requireDataValue(unwrapped, dataType);
    lowerer.markEscaped(value);
    return value.cpp;
}

function valueEnum(dataType: DataType<"enum">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.staticString !== undefined) {
        return lowerer.context.dataTypes.enumMemberCpp(dataType, value.staticString, node);
    }
    if (value.kind === "string" ||
        (value.kind === "data" &&
            value.dataType?.kind === "string")) {
        return lowerer.context.dataTypes.enumFromStringCpp(dataType, value.cpp, node);
    }
    if (value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueStruct(dataType: DataType<"struct">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.dataType?.kind === "struct" &&
        value.dataType.name === dataType.name &&
        lowerer.context.dataTypes.isClassStruct(dataType.name)) {
        // A shared class instance is already the `Ref` the sink
        // stores, whether it was just constructed (a record over
        // that Ref) or read back out of a container.
        lowerer.context.dataTypes.cppType(dataType);
        return value.cpp;
    }
    if (lowerer.context.dataTypes.isClassStruct(dataType.name) &&
        value.kind === "record") {
        lowerer.context.fail(node, `An instance of '${dataType.name}' constructed before ` +
            "anything stored one is a compile-time record; " +
            "storing it here would mint a second object with " +
            "the same fields rather than share this one.");
    }
    if (value.kind === "json-null" &&
        lowerer.context.dataTypes.isReferenceStruct(dataType.name)) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (value.kind === "record") {
        lowerer.context.dataTypes.cppType(dataType);
        const fields = lowerer.context.dataTypes.structFields(dataType.name, node);
        const aggregate = `bblscene::${dataType.name}${lowerer.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
            .map((field) => {
            if (field.type.kind === "function") {
                const method = value.recordMethods?.[field.sourceName] ??
                    value.classDeclaration?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) &&
                        ts.isIdentifier(member.name) &&
                        member.name.text ===
                            field.sourceName);
                if (method) {
                    return lowerer.context.compileStoredDataFunction(method, field.type, value);
                }
            }
            const property = value.recordProperties?.[field.sourceName];
            if (!property) {
                if (field.defaultWhenMissing) {
                    return "{}";
                }
                if (field.type.kind ===
                    "optional") {
                    return "std::nullopt";
                }
                lowerer.context.fail(node, `Compile-time record is missing required field '${field.sourceName}'.`);
            }
            return lowerer.compileKnownValueForSink(property, field.type, node);
        })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "struct") {
        const sourceType = value.dataType;
        if (dataTypesEqual(sourceType, dataType)) {
            return value.cpp;
        }
        const sourceFields = new EmissionMap(lowerer.context.dataTypes
            .structFields(sourceType.name, node)
            .map((field) => [
            field.sourceName,
            field,
        ]));
        const sourceArrow = lowerer.context.dataTypes.isReferenceStruct(sourceType.name);
        const fields = lowerer.context.dataTypes.structFields(dataType.name, node);
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
                lowerer.context.fail(node, `Struct ${sourceType.name} is missing required destination field '${field.sourceName}'.`);
            }
            return lowerer.compileKnownValueForSink(lowerer.leafValue(`${value.cpp}${sourceArrow ? "->" : "."}${source.name}`, source.type), field.type, node);
        })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    if (value.kind === "data" &&
        value.dataType?.kind === "map" &&
        value.dataType.key.kind === "string") {
        const sourceMap = value.dataType;
        const fields = lowerer.context.dataTypes.structFields(dataType.name, node);
        const aggregate = `bblscene::${dataType.name}${lowerer.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
            .map((field) => {
            if (field.type.kind !== "optional" ||
                !dataTypesEqual(sourceMap.value, field.type.inner)) {
                lowerer.context.fail(node, `Open string record cannot project field '${field.sourceName}' into ${dataType.name}; destination fields must be compatible optionals.`);
            }
            return `${value.cpp}.get(${lowerer.context.cppString(field.sourceName)})`;
        })
            .join(", ")}}`;
        return lowerer.context.dataTypes.isReferenceStruct(dataType.name)
            ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
            : aggregate;
    }
    return undefined;
}

function valueEnummap(dataType: DataType<"enummap">, lowerer: DataSinkHost, value: Value, node: ts.Node): string | undefined {
    if (value.kind === "record") {
        const members = lowerer.context.dataTypes.enumMembers(dataType.enumName);
        const properties = value.recordProperties ?? {};
        const written = Object.keys(properties);
        const unknown = written.find((name) => !members.includes(name));
        if (unknown) {
            lowerer.context.fail(node, `'${unknown}' is not a member of ${dataType.enumName}.`);
        }
        const compiled = new EmissionMap(written.map((name) => [
            name,
            lowerer.compileKnownValueForSink(properties[name]!, dataType.element, node),
        ]));
        const reordered = members.some((member, index) => written[index] !== member);
        if (reordered) {
            for (const key of written) {
                const temporary = lowerer.context.allocateTemporaryCppName("slot");
                lowerer.context.emit({ kind: "declaration", type: lowerer.context.dataTypes.cppType(dataType.element), name: temporary, initializer: compiled.get(key)! });
                lowerer.registerLocal(temporary, "owned");
                compiled.set(key, temporary);
            }
        }
        const slots = members.map((member) => {
            const slot = compiled.get(member);
            if (slot === undefined) {
                lowerer.context.fail(node, `Compile-time record is missing the '${member}' slot.`);
            }
            return slot;
        });
        lowerer.context.reachJsData();
        return `${lowerer.context.dataTypes.cppType(dataType)}{${slots.join(", ")}}`;
    }
    if (value.dataType &&
        dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

export const structuresSinks: DataSinkOperations<"enum" | "struct" | "enummap"> = {
    "enum": { expression: expressionEnum, value: valueEnum },
    "struct": { expression: expressionStruct, value: valueStruct },
    "enummap": { expression: expressionEnummap, value: valueEnummap }
};
