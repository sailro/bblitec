import { isUndefinedDataType } from "../data-types.js";
import ts from "typescript";
import { absenceKind, declaredContextualType } from "../type-facts.js";
import { hasNonNullAssertion, unwrapExpression } from "../syntax.js";
import { ownEntries } from "../object-statics.js";

import { dataTypesEqual, type DataType } from "../data-types.js";
import type { Value } from "../types.js";
import { isJsonValue } from "../json-bridge.js";
import { eventTargetCpp } from "../dom-targets.js";
import { authoredErrorValue, thrownMessage } from "../error-values.js";
import { provenUndefinedValue } from "../undefined-values.js";
import { rejectionOnlyPromiseCpp, settlesNever } from "../promises.js";
import { DynamicBindingStorageRequired } from "../dynamic-binding-storage.js";
import { NativeRecordStorageRequired } from "../native-record-storage.js";
import {
    compileJsonRecordView,
    compileJsonTupleView,
} from "../json-record-views.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionNumber(
    _dataType: DataType<"number">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    _unwrapped: ts.Expression,
): string {
    return lowerer.context.compileNumber(expression, "double");
}

function expressionBoolean(
    _dataType: DataType<"boolean">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.context.conditions.compileCondition(unwrapped);
}

function expressionBorrowedPlatformEvent(
    dataType: DataType<"borrowed-platform-event">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    const value = lowerer.context.compileValue(unwrapped);
    return (
        valueBorrowedPlatformEvent(dataType, lowerer, value, unwrapped) ??
        lowerer.context.fail(
            unwrapped,
            `A borrowed DOM ${dataType.event} event must come from the active synchronous platform callback.`,
        )
    );
}

function expressionString(
    dataType: DataType<"string">,
    lowerer: DataSinkHost,
    expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.compileStringSink(
        unwrapped,
        dataType,
        hasNonNullAssertion(expression),
    );
}

function expressionJson(
    dataType: DataType<"json">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    return lowerer.compileKnownValueForSink(
        lowerer.context.compileValue(unwrapped),
        dataType,
        unwrapped,
    );
}

/**
 * An object literal stored straight into a document slot is the document
 * itself: an owned object of its own keys, in creation order, each member
 * stored as a document value (a key a conditional spread wrote only while
 * it is own). Undefined for a record with methods or accessors, or one
 * other code can still reach as a compile-time record.
 */
function ownedDocument(
    lowerer: DataSinkHost,
    record: Value,
    node: ts.Node,
): string | undefined {
    const literal = lowerer.convertedExpression(node);
    if (
        !literal ||
        !ts.isObjectLiteralExpression(unwrapExpression(literal)) ||
        Object.keys(record.recordMethods ?? {}).length ||
        Object.keys(record.recordGetters ?? {}).length ||
        Object.keys(record.recordSetters ?? {}).length
    )
        return undefined;
    const entries = ownEntries(lowerer.ownObjectContext(), record, node);
    if (!entries) return undefined;
    const stores = entries.map(({ key, value, presence }) => {
        const stored = `own.emplace_back(${lowerer.context.cppString(key)}, ${lowerer.compileMemberForSink(value, { kind: "json" }, node, key)});`;
        return presence ? `if (${presence.ownCpp}) ${stored}` : stored;
    });
    lowerer.context.reachJson();
    return `([&]() { bbl::js::JsonValue::Object own; ${stores.join(" ")} return bbl::js::JsonValue::from_object(std::move(own)); }())`;
}

function valueJson(
    _dataType: DataType<"json">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    lowerer.context.reachJson();
    if (isJsonValue(value)) {
        lowerer.markEscaped(value);
        return value.cpp;
    }
    const expression =
        value.kind === "record" || value.dataType?.kind === "struct"
            ? lowerer.convertedExpression(node)
            : undefined;
    const contextual =
        expression &&
        declaredContextualType(lowerer.context.checker, expression);
    if (contextual && (contextual.flags & ts.TypeFlags.NonPrimitive) !== 0) {
        // An erased object remains writable through its retained aliases.
        // Observing views cannot provide that contract for fixed records.
        if (value.dataType?.kind === "struct") {
            const demand = lowerer.context.dataTypes.documentRecordDemand(
                value.dataType.name,
            );
            if (demand) throw new NativeRecordStorageRequired(demand);
            return lowerer.context.fail(
                node,
                "Erased object storage requires a mutable plain-data document owner.",
            );
        }
        if (value.kind === "record" && expression) {
            const declaration = lowerer.context.bindings.recordDeclaration(
                value,
                expression,
            );
            if (
                declaration &&
                !lowerer.context.dynamicBindings.has(declaration)
            )
                throw new DynamicBindingStorageRequired(declaration, "source");
        }
    }
    if (
        value.kind === "void" &&
        !value.erasedVoidCompletion &&
        provenUndefinedValue(lowerer.context, node)
    ) {
        lowerer.context.emitDiscardedValue(value);
        return "bbl::js::JsonValue{}";
    }
    // An optional's one absent state is the absence its read admits:
    // `undefined` or `null`, or the run-time answer of a read that records
    // whether its slot existed (the read runs first).
    if (
        value.dataType?.kind === "optional" &&
        lowerer.context.dataTypes.jsonValueCpp(
            value.dataType.inner,
            "value",
            node,
        ) !== undefined
    ) {
        const expression = lowerer.convertedExpression(node);
        const absence = expression
            ? absenceKind(lowerer.context.checker, value, expression)
            : value.slotFoundCpp !== undefined
              ? { slotFoundCpp: value.slotFoundCpp }
              : undefined;
        if (typeof absence === "object")
            return `([&]() { const auto slot = ${value.cpp}; return ${absence.slotFoundCpp} ? bbl::js::json_value_or_null(slot) : bbl::js::JsonValue{}; }())`;
        if (absence === "null")
            return `bbl::js::json_value_or_null(${value.cpp})`;
        if (absence === "undefined" || value.dataType.undefinedOnly)
            return `bbl::js::json_value(${value.cpp})`;
    }
    if (value.kind === "json-null")
        return value.cpp === "std::nullopt"
            ? "bbl::js::JsonValue{}"
            : "bbl::js::JsonValue::null_value()";
    if (value.kind === "record" && !value.cpp) {
        const owned = ownedDocument(lowerer, value, node);
        if (owned !== undefined) return owned;
        const view = compileJsonRecordView(lowerer, value, node);
        if (view !== undefined) return view;
    }
    if (value.kind === "tuple" && !value.cpp)
        return compileJsonTupleView(lowerer, value, node);
    const type =
        value.dataType ??
        (value.kind === "number" ||
        value.kind === "boolean" ||
        value.kind === "string"
            ? { kind: value.kind }
            : undefined);
    const cpp =
        value.kind === "number"
            ? lowerer.context.castNumber(value, "double")
            : value.cpp;
    return type
        ? lowerer.context.dataTypes.jsonValueCpp(type, cpp, node)
        : undefined;
}

function valuePromise(
    type: DataType<"promise">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.kind !== "promise") return undefined;
    const types = lowerer.context.dataTypes;
    const result = type.result;
    const expected = result ? types.cppType(result) : "bbl::js::PromiseVoid";
    if (value.promiseType === expected) return value.cpp;
    let converted: string | undefined;
    if (
        value.promiseResult?.kind === "void" &&
        result &&
        (result.kind === "optional" ||
            result.kind === "function" ||
            result.kind === "json" ||
            (result.kind === "struct" && types.isReferenceStruct(result.name)))
    ) {
        converted = `${expected}{}`;
    } else if (
        result?.kind === "optional" &&
        value.promiseType === types.cppType(result.inner)
    ) {
        converted = `${expected}{value}`;
    }
    if (
        !converted &&
        settlesNever(
            lowerer.context.checker,
            lowerer.context.checker.getTypeAtLocation(node),
        )
    )
        return rejectionOnlyPromiseCpp(value.cpp, expected);
    const payload = value.promiseResult;
    const source =
        payload?.dataType ??
        (payload?.kind === "number" ||
        payload?.kind === "string" ||
        payload?.kind === "boolean"
            ? { kind: payload.kind }
            : undefined);
    if (!converted && result && source) {
        // A result view reads the original settlement; ordinary storage
        // conversion must therefore keep every retained object's identity.
        const lines = lowerer.context.captureEmittedLines(() => {
            converted = lowerer.compileKnownValueForSink(
                lowerer.leafValue("value", source),
                result,
                node,
            );
        });
        if (lines.length > 0)
            return lowerer.context.fail(
                node,
                "A Promise result view requires an in-place storage conversion.",
            );
    }
    if (!converted)
        return lowerer.context.fail(
            node,
            `Promise storage requires ${expected}, received ${value.promiseType}.`,
        );
    return `bbl::js::Promise<${expected}>::view(${value.cpp}, []([[maybe_unused]] const ${value.promiseType}& value) -> ${expected} { return ${converted}; })`;
}

function valueNumber(
    _dataType: DataType<"number">,
    lowerer: DataSinkHost,
    value: Value,
    _node: ts.Node,
): string | undefined {
    // A parsed document coerces at the sink, which is where
    // JavaScript coerces one: `Number(document)`.
    if (isJsonValue(value)) {
        return lowerer.context.castNumber(value, "double");
    }
    if (value.kind !== "number") return undefined;
    // A data-model number is a native double, which is the
    // width `castNumber` writes a static lane at.
    return lowerer.context.castNumber(value, "double");
}

function valueBoolean(
    _dataType: DataType<"boolean">,
    _lowerer: DataSinkHost,
    value: Value,
    _node: ts.Node,
): string | undefined {
    if (value.kind === "boolean") return value.cpp;
    if (isJsonValue(value)) {
        return `${value.cpp}.truthy()`;
    }
    return undefined;
}

function valueBorrowedPlatformEvent(
    dataType: DataType<"borrowed-platform-event">,
    lowerer: DataSinkHost,
    value: Value,
    _node: ts.Node,
): string | undefined {
    if (value.kind === "dom-event" && dataType.event === "event")
        return `${value.cpp}.borrowed_event()`;
    const compatible =
        dataType.event === "error" || dataType.event === "rejection"
            ? value.nativeErrorEvent &&
              value.recordProperties?.type?.staticString ===
                  (dataType.event === "error" ? "error" : "unhandledrejection")
            : dataType.event === "event"
              ? value.kind === "platform-keyboard-event" ||
                value.kind === "platform-mouse-event" ||
                value.kind === "custom-event"
              : value.kind === `platform-${dataType.event}-event`;
    if (!compatible) return undefined;
    return dataType.event === "event"
        ? `bbl::js::BorrowedEvent(${value.cpp})`
        : `${lowerer.context.dataTypes.cppType(dataType)}(${value.cpp})`;
}

function valueString(
    _dataType: DataType<"string">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
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
    if (value.kind === "data" && value.dataType?.kind === "string") {
        return value.cpp;
    }
    if (value.kind === "data" && value.dataType?.kind === "enum") {
        return lowerer.context.dataTypes.enumToStringCpp(
            value.dataType,
            value.cpp,
            node,
        );
    }
    if (isJsonValue(value)) {
        return `${value.cpp}.to_string()`;
    }
    return undefined;
}

/** An opaque reference kind: a value of the same data type, as it is. */
const opaqueSink = {
    expression: (
        type: DataType,
        lowerer: DataSinkHost,
        expression: ts.Expression,
        unwrapped: ts.Expression,
    ): string => lowerer.requireDataValue(unwrapped, type, expression).cpp,
    value: (
        type: DataType,
        _lowerer: DataSinkHost,
        value: Value,
    ): string | undefined =>
        value.dataType && dataTypesEqual(value.dataType, type)
            ? value.cpp
            : undefined,
};

/** A leaf only a value of its own kind converts to. */
function sameKindSink<K extends "symbol" | "bigint" | "i64array" | "u64array">(
    kind: K,
): DataSinkOperations<K>[K] {
    return {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: (_type, _lowerer, value) =>
            value.dataType?.kind === kind ? value.cpp : undefined,
    };
}

export const scalarsSinks: DataSinkOperations<
    | "module-namespace"
    | "weak-key"
    | "undefined"
    | "null"
    | "error"
    | "file"
    | "blob"
    | "file-list"
    | "event-target"
    | "deferred-platform-object"
    | "search-params"
    | "http-response"
    | "gpu-adapter"
    | "gpu-adapter-info"
    | "promise"
    | "storage"
    | "date"
    | "regexp"
    | "date-time-format"
    | "text-decoder"
    | "text-encoder"
    | "collator"
    | "number-format"
    | "plural-rules"
    | "list-format"
    | "weak-ref"
    | "number"
    | "symbol"
    | "bigint"
    | "i64array"
    | "u64array"
    | "boolean"
    | "string"
    | "json"
    | "borrowed-platform-event"
> = {
    "module-namespace": {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (type, _lowerer, value) =>
            value.dataType && dataTypesEqual(type, value.dataType)
                ? value.cpp
                : undefined,
    },
    "weak-key": {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (_type, lowerer, value, node) => {
            const type = value.dataType;
            if (type?.kind === "weak-key") return value.cpp;
            if (type?.kind === "function" && (type.identity || type.generic))
                return `(${value.cpp}).weak_identity()`;
            if (
                value.kind === "callback" &&
                !value.cpp &&
                ts.isExpression(node)
            ) {
                const declaration =
                    lowerer.context.bindings.callbackDeclaration(value, node);
                if (declaration)
                    throw new DynamicBindingStorageRequired(
                        declaration,
                        "callback",
                    );
            }
            if (type?.kind === "struct") {
                lowerer.context.dataTypes.markStoredObjectReferences(type);
                return `(${value.cpp}).weak_identity()`;
            }
            const global = ts.isExpression(node)
                ? lowerer.context.libraryGlobal(node)
                : undefined;
            if (
                type?.kind === "event-target" ||
                value.kind === "ui-element" ||
                value.domEventTargetCpp !== undefined ||
                global === "window" ||
                global === "globalThis" ||
                global === "document"
            ) {
                const target = eventTargetCpp(lowerer.context, value, node);
                return target && `bbl::dom_target_weak_identity(${target})`;
            }
            return lowerer.context.fail(
                node,
                "A weak object key requires an owned record or represented DOM target.",
            );
        },
    },
    null: {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (_type, lowerer, value) => {
            if (value.dataType?.kind === "null")
                return `(static_cast<void>(${value.cpp}), bbl::js::Null{})`;
            if (value.kind !== "json-null" || value.cpp === "std::nullopt")
                return undefined;
            lowerer.context.emitDiscardedValue(value);
            return "bbl::js::Null{}";
        },
    },
    undefined: {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (_type, lowerer, value, node) => {
            if (isUndefinedDataType(value.dataType))
                return `(static_cast<void>(${value.cpp}), bbl::js::Undefined{})`;
            if (
                value.erasedVoidCompletion ||
                (value.kind === "void" &&
                    !provenUndefinedValue(lowerer.context, node))
            )
                lowerer.context.fail(
                    node,
                    "A stored void field requires a proven undefined completion.",
                );
            if (
                value.kind === "void" ||
                (value.kind === "json-null" && value.cpp === "std::nullopt")
            ) {
                lowerer.context.emitDiscardedValue(value);
                return "bbl::js::Undefined{}";
            }
            return undefined;
        },
    },
    "gpu-adapter": opaqueSink,
    file: opaqueSink,
    blob: opaqueSink,
    "file-list": opaqueSink,
    "deferred-platform-object": opaqueSink,
    "gpu-adapter-info": opaqueSink,
    error: {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (_type, lowerer, value, node) => {
            if (value.dataType?.kind === "error") return value.cpp;
            const authored = authoredErrorValue(lowerer.context, value);
            if (authored) return authored.cpp;
            if (!value.nativeError) return undefined;
            const message = thrownMessage(value);
            return message
                ? `bbl::js::make_error("Error", ${lowerer.compileKnownValueForSink(
                      message,
                      { kind: "string" },
                      node,
                  )})`
                : undefined;
        },
    },
    "search-params": {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: (_type, _lowerer, value) =>
            value.dataType?.kind === "search-params" ? value.cpp : undefined,
    },
    "event-target": {
        expression: (type, lowerer, expression) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(expression),
                type,
                expression,
            ),
        value: (_type, lowerer, value, node) =>
            eventTargetCpp(lowerer.context, value, node),
    },
    "http-response": {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: (_type, _lowerer, value) =>
            value.dataType?.kind === "http-response" ? value.cpp : undefined,
    },
    promise: {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: valuePromise,
    },
    storage: {
        expression: (type, lowerer, _expression, unwrapped) =>
            lowerer.compileKnownValueForSink(
                lowerer.context.compileValue(unwrapped),
                type,
                unwrapped,
            ),
        value: (_type, _lowerer, value) =>
            value.dataType?.kind === "storage" ? value.cpp : undefined,
    },
    "date-time-format": opaqueSink,
    "text-decoder": opaqueSink,
    "text-encoder": opaqueSink,
    collator: opaqueSink,
    "number-format": opaqueSink,
    "plural-rules": opaqueSink,
    "list-format": opaqueSink,
    "weak-ref": opaqueSink,
    date: opaqueSink,
    regexp: opaqueSink,
    number: { expression: expressionNumber, value: valueNumber },
    symbol: sameKindSink("symbol"),
    bigint: sameKindSink("bigint"),
    i64array: sameKindSink("i64array"),
    u64array: sameKindSink("u64array"),
    boolean: { expression: expressionBoolean, value: valueBoolean },
    string: { expression: expressionString, value: valueString },
    json: { expression: expressionJson, value: valueJson },
    "borrowed-platform-event": {
        expression: expressionBorrowedPlatformEvent,
        value: valueBorrowedPlatformEvent,
    },
};
