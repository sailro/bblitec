import ts from "typescript";

import {
    dataTypesEqual,
    doubleLiteral,
    isUndefinedDataType,
    type DataType,
} from "../data-types.js";
import { optionalValueCpp, presenceFlagCpp, type Value } from "../types.js";

import {
    DynamicBindingStorageRequired,
    initializedVariableDeclaration,
} from "../dynamic-binding-storage.js";
import { unaliasedValue } from "./aliasing.js";
import { ownEntries } from "../object-statics.js";
import {
    argumentOnlyRead,
    arrayCopyObservation,
    arrayLentForCall,
} from "../record-observations.js";
import { unwrapExpression } from "../syntax.js";
import {
    absenceKind,
    admitsUndefined,
    storedAsReadonlyArray,
} from "../type-facts.js";
import {
    requireAbsenceTag,
    requireTupleArraySlot,
} from "../absence-tag-storage.js";
import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionOptional(
    dataType: DataType<"optional">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    _unwrapped: ts.Expression,
): string {
    return lowerer.compileOptionalSink(expression, dataType);
}

function expressionVector(
    dataType: DataType<"vector">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.compileVectorSink(unwrapped, dataType);
}

function expressionMapOrSet(
    dataType: DataType<"map" | "set">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (dataType.kind === "map" && ts.isObjectLiteralExpression(unwrapped)) {
        return lowerer.openRecordLiteral(unwrapped, dataType);
    }
    if (
        dataType.kind === "map" &&
        (ts.isIdentifier(unwrapped) || ts.isPropertyAccessExpression(unwrapped))
    ) {
        const known = lowerer.context.compileValue(unwrapped);
        if (known.kind === "record") {
            return lowerer.compileKnownValueForSink(known, dataType, unwrapped);
        }
    }
    if (ts.isNewExpression(unwrapped)) {
        const created = lowerer.compileMapOrSetNew(unwrapped, dataType);
        if (created?.dataType && dataTypesEqual(created.dataType, dataType)) {
            return created.cpp;
        }
    }
    const value = lowerer.requireDataValue(unwrapped, dataType, expression);
    lowerer.markEscaped(value);
    return value.cpp;
}

/**
 * Into storage that tells `undefined` from `null` (`DataType<"tagged">`): a
 * value that cannot be `undefined` is stored defined, the way its own sink
 * stores it; any other value states which absent value it holds.
 */
function expressionTagged(
    dataType: DataType<"tagged">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    const checker = lowerer.context.checker;
    if (!admitsUndefined(checker.getTypeAtLocation(expression)))
        return `${lowerer.context.dataTypes.cppType(dataType)}{${lowerer.compileForSink(expression, dataType.inner)}, true}`;
    const value = lowerer.context.compileValue(unwrapped);
    const tagged = valueTagged(dataType, lowerer, value, expression);
    if (tagged === undefined)
        lowerer.context.fail(
            expression,
            `Expected a value storable as ${lowerer.context.dataTypes.cppType(dataType.inner)}, received ${value.kind}.`,
        );
    return tagged;
}

function valueTagged(
    dataType: DataType<"tagged">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    const context = lowerer.context;
    const cppType = context.dataTypes.cppType(dataType);
    const inner = dataType.inner;
    if (value.kind === "json-null")
        return value.cpp === "std::nullopt"
            ? `${cppType}{}`
            : `${cppType}{${context.dataTypes.absentValue(inner)}, true}`;
    if (isUndefinedDataType(value.dataType)) {
        context.emitDiscardedValue(value);
        return `${cppType}{}`;
    }
    // Another tagged storage of this type is copied with its state.
    if (
        value.absenceTagStorageCpp !== undefined &&
        value.absenceTagType !== undefined &&
        dataTypesEqual(value.absenceTagType, dataType)
    )
        return value.absenceTagStorageCpp;
    const absence = absenceKind(context.checker, value, node);
    if (absence === "either") {
        requireAbsenceTag(context.checker, context.absenceTags, node, value);
        return context.fail(
            node,
            "A value that may be null or undefined is stored where they are told apart only once one of them is ruled out (narrow the type).",
        );
    }
    const pinned =
        typeof absence === "object" && ts.isExpression(node)
            ? context.bindings.pinValueToTemporary(value, "tagged_source", node)
            : value;
    const {
        slotFoundCpp: _found,
        absenceTagStorageCpp: _storage,
        absenceTagType: _type,
        ...stored
    } = pinned;
    const converted = lowerer.compileKnownValueForSink(stored, inner, node);
    if (typeof absence === "object")
        return `${cppType}{${converted}, static_cast<bool>(${absence.slotFoundCpp})}`;
    if (absence !== "undefined") return `${cppType}{${converted}, true}`;
    // Only `undefined` is absent here: the value is defined when present.
    const slot = context.allocateTemporaryCppName("tagged_slot");
    const present = context.dataTypes.slotPresentCpp(inner, slot);
    return present === undefined
        ? `${cppType}{${converted}, true}`
        : `([&]() { auto ${slot} = ${converted}; return ${cppType}{${slot}, ${present}}; }())`;
}

function expressionSpanOrTupleOrTable(
    dataType: DataType<"span" | "tuple" | "table">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.spanLikeForSink(unwrapped, dataType);
}

function valueOptional(
    dataType: DataType<"optional">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (dataType.inner.kind === "undefined")
        return lowerer.context.dataTypes.presentValue(
            dataType,
            lowerer.compileKnownValueForSink(value, dataType.inner, node),
        );
    const absent = lowerer.context.dataTypes.absentValue(dataType);
    if (value.kind === "void") {
        lowerer.context.emitDiscardedValue(value);
        return absent;
    }
    if (value.kind === "json-null") {
        return absent;
    }
    // A value that is always undefined is evaluated, then stored absent.
    if (isUndefinedDataType(value.dataType))
        return `(static_cast<void>(${value.cpp}), ${absent})`;
    if (value.dataType?.kind === "optional") {
        const sourceType = value.dataType.inner;
        const source =
            lowerer.context.allocateTemporaryCppName("optional_source");
        let converted = "";
        const lines = lowerer.context.captureEmittedLines(() => {
            converted = lowerer.compileKnownValueForSink(
                lowerer.leafValue(optionalValueCpp(source), sourceType),
                dataType.inner,
                node,
            );
        });
        return (
            `([&]() -> ${lowerer.context.dataTypes.cppType(dataType)} { ` +
            `const auto ${source} = (${value.cpp}).to_optional(); if (!${source}) return ${absent}; ` +
            `${lines.join("\n")} return ${converted}; }())`
        );
    }
    const found = presenceFlagCpp(value);
    if (found !== undefined) {
        let inner = "";
        const lines = lowerer.context.captureEmittedLines(() => {
            inner = lowerer.compileKnownValueForSink(
                value,
                dataType.inner,
                node,
            );
        });
        const cppType = lowerer.context.dataTypes.cppType(dataType);
        if (lines.length)
            return (
                `([&]() -> ${cppType} { if (!(${found})) return ${absent}; ` +
                `${lines.join("\n")} return ${inner}; }())`
            );
        return `(${found} ? ${cppType}{${inner}} : ${absent})`;
    }
    return lowerer.compileKnownValueForSink(value, dataType.inner, node);
}

function valueVector(
    dataType: DataType<"vector">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (
        value.kind === "data" &&
        value.dataType?.kind === "tuple" &&
        dataType.element.kind === "number"
    ) {
        requireGrowableTuple(lowerer, value, node);
        lowerer.context.reachJsData();
        lowerer.markEscaped(value);
        return `bbl::js::Array<double>{(${value.cpp}).retained_storage()}`;
    }
    if (
        value.kind === "handle-collection" &&
        value.handleCollection &&
        dataType.element.kind === "handle" &&
        value.handleCollection.elementKind === dataType.element.handle
    ) {
        lowerer.context.reachJsData();
        return (
            `bbl::js::array_from_iterable<${lowerer.context.dataTypes.cppType(dataType.element)}>(` +
            `${value.handleCollection.containerCpp})`
        );
    }
    if (value.kind === "tuple") {
        lowerer.context.reachJsData();
        const elements = value.tupleElements ?? [];
        elements.forEach((entry, index) =>
            lowerer.context.sceneManifest.recordDataLightSlot(entry, index),
        );
        return `bbl::js::Array<${lowerer.context.dataTypes.cppType(dataType.element)}>{${elements
            .map((entry, index) =>
                lowerer.compileMemberForSink(
                    entry,
                    dataType.element,
                    node,
                    index,
                ),
            )
            .join(", ")}}`;
    }
    if (
        value.kind === "data" &&
        value.dataType &&
        dataTypesEqual(value.dataType, dataType)
    ) {
        return value.cpp;
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "span" &&
        dataTypesEqual(value.dataType.element, dataType.element)
    ) {
        lowerer.context.fail(
            node,
            "A borrowed array view cannot retain JavaScript array identity in owning storage.",
        );
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "vector" &&
        (value.dataType.element.kind === "struct" ||
            value.dataType.element.kind === "map") &&
        dataType.element.kind === "struct"
    ) {
        lowerer.context.reachJsData();
        const source =
            lowerer.context.allocateTemporaryCppName("project_source");
        const item = lowerer.context.allocateTemporaryCppName("project_item");
        const result =
            lowerer.context.allocateTemporaryCppName("project_result");
        const destinationCpp = lowerer.context.dataTypes.cppType(dataType);
        // The projection is a second array. JavaScript keeps one, so the
        // records of an array the program still holds share one layout,
        // and a callee that only reads the array borrows a copy for the
        // call; a new array is the projection's own, its elements judged
        // one by one unless nothing else holds them either.
        const array = lowerer.convertedExpression(node);
        const unaliased = unaliasedValue(lowerer, value, node);
        if (!unaliased && value.dataType.element.kind === "struct")
            lowerer.context.dataTypes.storeRecordAs(
                value.dataType.element,
                dataType.element,
                node,
                lowerer.context,
                {
                    sharedArray: true,
                    lentForCall:
                        array !== undefined &&
                        arrayLentForCall(lowerer.context, array),
                },
            );
        const projected = lowerer.compileMemberForSink(
            {
                ...lowerer.leafValue(item, value.dataType.element),
                ...(unaliased === "elements"
                    ? { unaliased: "object" as const }
                    : {}),
            },
            dataType.element,
            node,
        );
        return (
            `[&]() { auto ${source} = ${value.cpp}; ` +
            `${destinationCpp} ${result}; ` +
            `${result}.reserve(${source}.size()); ` +
            `for (const auto& ${item} : ${source}) { ` +
            `${result}.push_back(${projected}); } ` +
            `return ${result}; }()`
        );
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "vector" &&
        !dataTypesEqual(value.dataType.element, dataType.element)
    )
        return convertedElementsCopy(
            dataType,
            lowerer,
            value,
            value.dataType.element,
            node,
        );
    // A numeric tuple stored as an array of other lanes (`[number, number]`
    // beside `[number, number, boolean]`) converts its lanes the same way.
    if (value.kind === "data" && value.dataType?.kind === "tuple")
        return convertedElementsCopy(
            dataType,
            lowerer,
            value,
            { kind: "number" },
            node,
        );
    return undefined;
}

/** A lane with no identity of its own: a number, string, boolean or literal union, or a union or optional of them. */
export function plainLane(type: DataType): boolean {
    switch (type.kind) {
        case "number":
        case "boolean":
        case "string":
        case "enum":
        case "undefined":
            return true;
        case "optional":
            return plainLane(type.inner);
        case "union":
            return type.members.every(plainLane);
        default:
            return false;
    }
}

/**
 * An array stored as an array of another element type (literal-union
 * lanes as strings, a lane as an optional one, record lanes as another
 * record type) is a second array, each element converted as it is stored.
 * JavaScript keeps one array, so the copy is admitted only where nothing
 * can tell the two apart: nothing else holds the array (a fresh one, whose
 * elements are then judged one by one), the callee it is handed to only
 * reads it and nothing the call runs changes it, or its lanes are plain
 * values and no change or identity use in the program reaches an array
 * that may be either one.
 */
function convertedElementsCopy(
    dataType: DataType<"vector">,
    lowerer: DataSinkHost,
    value: Value,
    element: DataType,
    node: ts.Node,
): string {
    const array = lowerer.convertedExpression(node);
    const unaliased = unaliasedValue(lowerer, value, node);
    const lent =
        !unaliased &&
        array !== undefined &&
        arrayLentForCall(lowerer.context, array);
    if (!unaliased && !lent) {
        const checker = lowerer.context.checker;
        const target = array && checker.getContextualType(array);
        const observed =
            !array ||
            !target ||
            !plainLane(element) ||
            !plainLane(dataType.element)
                ? "the array may still be reached through another reference"
                : arrayCopyObservation(
                      lowerer.context,
                      checker.getTypeAtLocation(array),
                      target,
                  );
        if (observed !== undefined) {
            // An array of ArrayLike slots takes the kind of its elements.
            lowerer.requireNumericSlot(value, dataType, node);
            lowerer.context.fail(
                node,
                `An array stored as an array of another element type is a copy, and ${observed}; JavaScript keeps one array.`,
            );
        }
    }
    lowerer.context.reachJsData();
    const source = lowerer.context.allocateTemporaryCppName("convert_source");
    const item = lowerer.context.allocateTemporaryCppName("convert_item");
    const result = lowerer.context.allocateTemporaryCppName("convert_result");
    let converted = "";
    const lines = lowerer.context.captureEmittedLines(() => {
        converted = lowerer.compileMemberForSink(
            {
                ...lowerer.leafValue(item, element),
                ...(unaliased === "elements"
                    ? { unaliased: "object" as const }
                    : {}),
            },
            dataType.element,
            node,
        );
    });
    return (
        `[&]() { auto ${source} = ${value.cpp}; ` +
        `${lowerer.context.dataTypes.cppType(dataType)} ${result}; ` +
        `${result}.reserve(${source}.size()); ` +
        `for (const auto& ${item} : ${source}) { ` +
        `${lines.join("\n")} ${result}.push_back(${converted}); } ` +
        `return ${result}; }()`
    );
}

/**
 * A number array holding a tuple is the tuple itself, and can grow. The
 * tuple's fixed native storage cannot follow that growth, so it is adopted
 * only when nothing else holds the tuple, the callee it is handed to only
 * reads it or the slot is typed as a readonly array; a tuple binding
 * instead takes growable array storage, and any other tuple refuses.
 */
function requireGrowableTuple(
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): void {
    const converted = lowerer.convertedExpression(node);
    const expression = converted && unwrapExpression(converted);
    if (unaliasedValue(lowerer, value, node)) return;
    // A callee that only reads the array cannot grow or retain it, nor can
    // a slot typed as a readonly array.
    if (
        expression &&
        (argumentOnlyRead(lowerer.context.checker, expression) ||
            storedAsReadonlyArray(lowerer.context.checker, converted))
    )
        return;
    const declaration =
        (expression && ts.isIdentifier(expression)
            ? initializedVariableDeclaration(
                  lowerer.context.checker,
                  expression,
              )
            : undefined) ??
        lowerer.context.bindings.variableDeclarationOf(value.cpp);
    if (declaration && !lowerer.context.dynamicBindings.has(declaration))
        throw new DynamicBindingStorageRequired(declaration, "array");
    // A record property's tuples take growable array storage likewise.
    requireTupleArraySlot(lowerer.context.tupleArraySlots, value);
    lowerer.context.fail(
        node,
        "A fixed-length tuple stored as a number array could grow through that array, which its native storage cannot follow; give it number[] storage or store a copy ([...tuple]).",
    );
}

function valueMap(
    dataType: DataType<"map">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.kind === "record") {
        // A key a conditional spread wrote is stored while it is own, in
        // creation order.
        const entries = ownEntries(lowerer.ownObjectContext(), value, node)!;
        const conditional = entries.some(
            (entry) => entry.presence !== undefined,
        );
        const stores = entries.map(({ key: name, value: entry, presence }) => {
            const key =
                dataType.key.kind === "string"
                    ? lowerer.context.cppString(name)
                    : dataType.key.kind === "number"
                      ? doubleLiteral(Number(name))
                      : lowerer.context.fail(
                            node,
                            "Compile-time open Records require string or number keys.",
                        );
            const stored = lowerer.compileMemberForSink(
                entry,
                dataType.value,
                node,
                name,
            );
            if (!conditional) return `{${key}, ${stored}}`;
            return presence
                ? `if (${presence.ownCpp}) own.set(${key}, ${stored});`
                : `own.set(${key}, ${stored});`;
        });
        lowerer.context.reachJsData();
        const cppType = lowerer.context.dataTypes.cppType(dataType);
        return conditional
            ? `[&]() { ${cppType} own; ${stores.join(" ")} return own; }()`
            : `${cppType}{${stores.join(", ")}}`;
    }
    if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueSpan(
    dataType: DataType<"span">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (
        value.kind === "handle-collection" &&
        value.handleCollection &&
        dataType.element.kind === "handle" &&
        value.handleCollection.elementKind === dataType.element.handle
    ) {
        lowerer.context.reachJsData();
        return (
            `bbl::js::array_from_iterable<${lowerer.context.dataTypes.cppType(dataType.element)}>(` +
            `${value.handleCollection.containerCpp})`
        );
    }
    if (value.kind === "tuple") {
        lowerer.context.reachJsData();
        (value.tupleElements ?? []).forEach((entry, index) =>
            lowerer.context.sceneManifest.recordDataLightSlot(entry, index),
        );
        return `bbl::js::Array<${lowerer.context.dataTypes.cppType(dataType.element)}>{${(
            value.tupleElements ?? []
        )
            .map((entry, index) =>
                lowerer.compileMemberForSink(
                    entry,
                    dataType.element,
                    node,
                    index,
                ),
            )
            .join(", ")}}`;
    }
    if (value.dataType && lowerer.spanCompatible(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueSetOrTable(
    dataType: DataType<"set" | "table">,
    _lowerer: DataSinkHost,
    value: Value,
    _node: ts.Node,
): string | undefined {
    if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    return undefined;
}

function valueTuple(
    dataType: DataType<"tuple">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (
        value.kind === "tuple" &&
        (value.tupleElements?.length ?? 0) === dataType.arity
    ) {
        return `bbl::js::Tuple<${dataType.arity}>{${value
            .tupleElements!.map((entry) =>
                lowerer.compileKnownValueForSink(
                    entry,
                    { kind: "number" },
                    node,
                ),
            )
            .join(", ")}}`;
    }
    if (value.dataType && dataTypesEqual(value.dataType, dataType)) {
        return value.cpp;
    }
    // A number array asserted as a tuple stays the same array; its length
    // is checked where the assertion runs.
    if (
        value.kind === "data" &&
        value.dataType?.kind === "vector" &&
        value.dataType.element.kind === "number"
    ) {
        lowerer.context.reachJsData();
        return `bbl::js::array_as_tuple<${dataType.arity}>(${value.cpp})`;
    }
    return undefined;
}

function valueProduct(
    dataType: DataType<"product">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (
        value.kind === "tuple" &&
        value.tupleElements?.length === dataType.elements.length
    ) {
        lowerer.context.reachJsData();
        return `${lowerer.context.dataTypes.cppType(dataType)}{${value.tupleElements
            .map((entry, index) =>
                lowerer.compileMemberForSink(
                    entry,
                    dataType.elements[index]!,
                    node,
                    index,
                ),
            )
            .join(", ")}}`;
    }
    return value.dataType && dataTypesEqual(value.dataType, dataType)
        ? value.cpp
        : undefined;
}

const identityContainerSink = {
    expression: (
        type: DataType<"iterator" | "arguments">,
        lowerer: DataSinkHost,
        expression: ts.Expression,
        unwrapped: ts.Expression,
    ) =>
        // A traced collection cursor is stored where any iterator is.
        type.kind === "iterator"
            ? lowerer.compileKnownValueForSink(
                  lowerer.context.compileValue(unwrapped),
                  type,
                  unwrapped,
              )
            : lowerer.requireDataValue(unwrapped, type, expression).cpp,
    value: (
        type: DataType<"iterator" | "arguments">,
        _lowerer: DataSinkHost,
        value: Value,
    ) =>
        value.dataType && dataTypesEqual(type, value.dataType)
            ? value.cpp
            : undefined,
};

export const containersSinks: DataSinkOperations<
    | "optional"
    | "tagged"
    | "vector"
    | "map"
    | "set"
    | "iterator"
    | "arguments"
    | "span"
    | "tuple"
    | "product"
    | "table"
> = {
    iterator: identityContainerSink,
    arguments: identityContainerSink,
    product: {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: valueProduct,
    },
    optional: { expression: expressionOptional, value: valueOptional },
    tagged: { expression: expressionTagged, value: valueTagged },
    vector: { expression: expressionVector, value: valueVector },
    map: { expression: expressionMapOrSet, value: valueMap },
    set: { expression: expressionMapOrSet, value: valueSetOrTable },
    span: { expression: expressionSpanOrTupleOrTable, value: valueSpan },
    tuple: { expression: expressionSpanOrTupleOrTable, value: valueTuple },
    table: { expression: expressionSpanOrTupleOrTable, value: valueSetOrTable },
};
