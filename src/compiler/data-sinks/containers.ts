import ts from "typescript";

import { dataTypesEqual, doubleLiteral, type DataType } from "../data-types.js";
import { optionalValueCpp, presenceFlagCpp, type Value } from "../types.js";

import { DynamicBindingStorageRequired } from "../dynamic-binding-storage.js";
import {
    yieldsFreshObject,
    yieldsFreshRecordElements,
} from "../fresh-records.js";
import { argumentOnlyRead, arrayLentForCall } from "../record-observations.js";
import { resolvedSymbol } from "../symbols.js";
import { unwrapExpression } from "../syntax.js";
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
        // Elements of a fresh array are records nothing else reaches. The
        // array is the converted expression's value, never its container's.
        const array = lowerer.convertedExpression(node);
        const own = array ? lowerer.dataTypeAt(array) : undefined;
        const freshElements =
            array !== undefined &&
            own?.kind === "vector" &&
            dataTypesEqual(own.element, value.dataType.element) &&
            yieldsFreshRecordElements(lowerer.context.checker, array);
        // The projection is a second array. JavaScript keeps one, so the
        // records of an array the program still holds share one layout;
        // where none holds both types, a callee that only reads the array
        // borrows the copy for the call.
        if (
            !freshElements &&
            value.dataType.element.kind === "struct" &&
            !(array && yieldsFreshArray(lowerer, array))
        )
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
                ...(freshElements ? { freshRecord: true as const } : {}),
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
    return undefined;
}

/**
 * A number array holding a tuple is the tuple itself, and can grow. The
 * tuple's fixed native storage cannot follow that growth, so it is adopted
 * only when nothing else holds the tuple or the callee it is handed to only
 * reads it; a tuple binding instead takes growable array storage, and any
 * other tuple refuses.
 */
function requireGrowableTuple(
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): void {
    const converted = lowerer.convertedExpression(node);
    const expression = converted && unwrapExpression(converted);
    const own = expression ? lowerer.dataTypeAt(expression) : undefined;
    // A call that creates its result owns it; a selection (`??`, `?:`)
    // marked fresh may still yield a stored tuple.
    if (
        own?.kind === "tuple" &&
        expression &&
        ((value.freshData && ts.isCallExpression(expression)) ||
            yieldsFreshObject(lowerer.context.checker, expression))
    )
        return;
    // A callee that only reads the array cannot grow or retain it.
    if (expression && argumentOnlyRead(lowerer.context.checker, expression))
        return;
    const named =
        expression && ts.isIdentifier(expression)
            ? resolvedSymbol(lowerer.context.checker, expression)
                  ?.valueDeclaration
            : undefined;
    const declaration =
        named && ts.isVariableDeclaration(named) && named.initializer
            ? named
            : lowerer.context.bindings.variableDeclarationOf(value.cpp);
    if (declaration && !lowerer.context.dynamicBindings.has(declaration))
        throw new DynamicBindingStorageRequired(declaration, "array");
    lowerer.context.fail(
        node,
        "A fixed-length tuple stored as a number array could grow through that array, which its native storage cannot follow; give it number[] storage or store a copy ([...tuple]).",
    );
}

/** Methods and statics that return a new array of the receiver's elements. */
const ARRAY_COPIES = new Set([
    "concat",
    "filter",
    "flat",
    "flatMap",
    "map",
    "slice",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
    "from",
    "of",
    "values",
]);

/** Whether an array expression evaluates to an array no other reference holds. */
function yieldsFreshArray(
    lowerer: DataSinkHost,
    expression: ts.Expression,
): boolean {
    const unwrapped = unwrapExpression(expression);
    return (
        yieldsFreshObject(lowerer.context.checker, unwrapped) ||
        (ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ARRAY_COPIES.has(unwrapped.expression.name.text) &&
            (lowerer.context.checker.isArrayLikeType(
                lowerer.context.checker.getTypeAtLocation(
                    unwrapped.expression.expression,
                ),
            ) ||
                ["Array", "Object"].includes(
                    lowerer.context.libraryGlobal(
                        unwrapped.expression.expression,
                    ) ?? "",
                )))
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
        const entries = Object.entries(value.recordProperties ?? {}).map(
            ([name, member]) => lowerer.recordMemberEntry(name, member, node),
        );
        const conditional = entries.some(
            (entry) => entry.presentCpp !== undefined,
        );
        const stores = entries.map(
            ({ key: name, value: entry, presentCpp }) => {
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
                return presentCpp
                    ? `if (${presentCpp}) own.set(${key}, ${stored});`
                    : `own.set(${key}, ${stored});`;
            },
        );
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
    ) => lowerer.requireDataValue(unwrapped, type, expression).cpp,
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
    vector: { expression: expressionVector, value: valueVector },
    map: { expression: expressionMapOrSet, value: valueMap },
    set: { expression: expressionMapOrSet, value: valueSetOrTable },
    span: { expression: expressionSpanOrTupleOrTable, value: valueSpan },
    tuple: { expression: expressionSpanOrTupleOrTable, value: valueTuple },
    table: { expression: expressionSpanOrTupleOrTable, value: valueSetOrTable },
};
