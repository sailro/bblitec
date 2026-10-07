import ts from "typescript";

import { callMember, dataTypesEqual, type DataType } from "../data-types.js";
import { isNullishLiteral } from "../symbols.js";
import type { Value } from "../types.js";
import { hasFixedTupleRest } from "../user-functions.js";

import { plainLane } from "./containers.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionFunction(
    dataType: DataType<"function">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (isNullishLiteral(lowerer.context.checker, unwrapped)) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (ts.isIdentifier(unwrapped)) {
        const bound = lowerer.context.bindings.lookupOptional(unwrapped);
        if (
            bound &&
            (bound.kind === "callback" ||
                bound.kind === "data" ||
                bound.kind === "json-null")
        ) {
            return lowerer.compileKnownValueForSink(bound, dataType, unwrapped);
        }
    }
    if (
        ts.isArrowFunction(unwrapped) ||
        ts.isFunctionExpression(unwrapped) ||
        ts.isIdentifier(unwrapped)
    ) {
        if (ts.isIdentifier(unwrapped)) {
            const callback = lowerer.context.compileValue(unwrapped);
            if (callback.kind === "callback" && callback.callbackDeclaration) {
                return lowerer.compileKnownValueForSink(
                    callback,
                    dataType,
                    unwrapped,
                );
            }
        }
        const nativeType = lowerer.dataTypeAt(unwrapped);
        if (
            nativeType?.kind === "function" &&
            nativeType.restParameter !== undefined &&
            dataType.restParameter === undefined &&
            !hasFixedTupleRest(lowerer.context.checker, unwrapped)
        ) {
            const cpp = lowerer.context.compileStoredDataFunction(
                unwrapped,
                nativeType,
            );
            return lowerer.compileKnownValueForSink(
                lowerer.leafValue(cpp, nativeType),
                dataType,
                unwrapped,
            );
        }
        return lowerer.context.compileStoredDataFunction(unwrapped, dataType);
    }
    const value = lowerer.context.compileValue(unwrapped);
    if (
        value.kind === "callback" ||
        value.kind === "void" ||
        value.kind === "json-null"
    ) {
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    }
    if (value.kind === "data" && value.dataType?.kind === "function") {
        return lowerer.compileKnownValueForSink(value, dataType, unwrapped);
    }
    lowerer.context.fail(
        unwrapped,
        "Expected a local function with a native data signature.",
    );
}

/**
 * The signature a value already holds native storage for: a data function
 * value's own type, or the parameter and result types a materialized
 * callback was stored with (its declaration's type when the storage
 * recorded none). A value without storage has no stored signature and is
 * lowered for each sink it reaches.
 */
function storedSignature(
    lowerer: DataSinkHost,
    value: Value,
): DataType<"function"> | undefined {
    if (value.cpp.length === 0) return undefined;
    if (value.kind === "data")
        return value.dataType?.kind === "function" ? value.dataType : undefined;
    if (value.kind !== "callback") return undefined;
    const parameters = value.nativeCallbackParameterTypes;
    if (parameters === undefined) {
        const declared = value.callbackDeclaration
            ? lowerer.dataTypeAt(value.callbackDeclaration)
            : undefined;
        return declared?.kind === "function" ? declared : undefined;
    }
    return parameters.every(
        (parameter): parameter is DataType => parameter !== undefined,
    )
        ? {
              kind: "function",
              parameters: [...parameters],
              ...(value.nativeCallbackReturnType
                  ? { result: value.nativeCallbackReturnType }
                  : {}),
          }
        : undefined;
}

/**
 * Whether every value of the plain lane `from` is a value of `to`: the
 * same lane, or one an optional `to` holds present. Converting between
 * such lanes wraps a value; it never changes or drops one.
 */
function plainLaneWidens(from: DataType, to: DataType): boolean {
    if (!plainLane(from) || !plainLane(to)) return false;
    if (dataTypesEqual(from, to)) return true;
    if (to.kind !== "optional") return false;
    if (from.kind !== "optional") return plainLaneWidens(from, to.inner);
    return (
        (!to.undefinedOnly || from.undefinedOnly === true) &&
        plainLaneWidens(from.inner, to.inner)
    );
}

/**
 * `cpp`, a C++ name holding a `from` value, converted to `to`: the name
 * itself for one type, else the plain-lane conversion, whose statements
 * are appended to `lines`. `undefined` when `to` does not hold every
 * `from` value.
 */
function widenedLane(
    lowerer: DataSinkHost,
    cpp: string,
    from: DataType,
    to: DataType,
    node: ts.Node,
    lines: string[],
): string | undefined {
    if (dataTypesEqual(from, to)) return cpp;
    if (!plainLaneWidens(from, to)) return undefined;
    let converted = "";
    lines.push(
        ...lowerer.context.captureEmittedLines(() => {
            converted = lowerer.compileKnownValueForSink(
                lowerer.leafValue(cpp, from),
                to,
                node,
            );
        }),
    );
    return converted;
}

/**
 * How a sink of `sink` type invokes a stored value of `source` type: the
 * body of an invoker receiving the sink's parameters, the first `named`
 * by name. It passes the leading sink parameters the value declares
 * (JavaScript ignores the extras), each converted to the value's
 * parameter where that one holds every sink value (a required lane
 * passed to an optional parameter), or for a value declared with a rest
 * parameter the leading ones plus the remaining sink parameters packed
 * into its array; a result the sink does not read is dropped, one it
 * reads converted the same way. `undefined` when the value needs
 * something the sink does not supply.
 */
function adaptedCall(
    lowerer: DataSinkHost,
    source: DataType<"function">,
    sink: DataType<"function">,
    node: ts.Node,
): { named: number; body: string } | undefined {
    if (
        sink.restParameter !== undefined ||
        sink.erasedParameters?.length ||
        source.erasedParameters?.length
    )
        return undefined;
    const lines: string[] = [];
    const fixed = source.restParameter ?? source.parameters.length;
    const names = sink.parameters.map((_, index) => `argument_${index}`);
    const arguments_: string[] = [];
    for (const [index, parameter] of source.parameters
        .slice(0, fixed)
        .entries()) {
        const supplied = sink.parameters[index];
        const argument = supplied
            ? widenedLane(
                  lowerer,
                  names[index]!,
                  supplied,
                  parameter,
                  node,
                  lines,
              )
            : source.optionalParameters?.includes(index)
              ? lowerer.context.dataTypes.absentValue(parameter)
              : undefined;
        if (argument === undefined) return undefined;
        arguments_.push(argument);
    }
    let named = Math.min(fixed, names.length);
    if (source.restParameter !== undefined) {
        const rest = source.parameters[source.restParameter];
        if (
            rest?.kind !== "vector" ||
            !sink.parameters
                .slice(fixed)
                .every((parameter) => dataTypesEqual(parameter, rest.element))
        )
            return undefined;
        named = sink.parameters.length;
        arguments_.push(
            `${lowerer.context.dataTypes.cppType(rest)}{${names.slice(fixed).join(", ")}}`,
        );
    }
    const call = `callback(${arguments_.join(", ")})`;
    if (sink.result === undefined)
        return {
            named,
            body: [...lines, `static_cast<void>(${call});`].join(" "),
        };
    if (source.result === undefined) return undefined;
    if (dataTypesEqual(source.result, sink.result))
        return { named, body: [...lines, `return ${call};`].join(" ") };
    lines.push(`const auto result = ${call};`);
    const result = widenedLane(
        lowerer,
        "result",
        source.result,
        sink.result,
        node,
        lines,
    );
    return result === undefined
        ? undefined
        : { named, body: [...lines, `return ${result};`].join(" ") };
}

/**
 * The runtime's signature adapter around a stored value: a capture-less
 * invoker receives the sink's parameters, the first `named` by name, and
 * runs `body` (`adaptedCall`) over the value; the value keeps its
 * identity and environment. The invoker spells its parameter from the
 * storage itself, because materialized storage may declare parameters by
 * reference where the data type spells them by value.
 */
function renderSignatureAdapter(
    lowerer: DataSinkHost,
    cpp: string,
    sink: DataType<"function">,
    named: number,
    body: string,
): string {
    const cppType = (type: DataType): string =>
        lowerer.context.dataTypes.cppType(type);
    const parameters = sink.parameters
        .map(
            (type, index) =>
                `, ${cppType(type)}${index < named ? ` argument_${index}` : ""}`,
        )
        .join("");
    const result = sink.result ? cppType(sink.result) : "void";
    return `bbl::js::adapt_callback<${cppType(sink)}>(${cpp}, [](std::remove_cvref_t<decltype(${cpp})>& callback${parameters}) -> ${result} { ${body} })`;
}

function valueFunction(
    dataType: DataType<"function">,
    lowerer: DataSinkHost,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.kind === "void") {
        lowerer.context.emitDiscardedValue(value);
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (value.kind === "json-null") {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    // A callable record is called as its own call.
    const callType =
        value.kind === "data" && value.dataType?.kind === "struct"
            ? lowerer.context.dataTypes.structCall(value.dataType.name)
            : undefined;
    if (callType) {
        lowerer.context.useNativeValue(value);
        return lowerer.compileKnownValueForSink(
            lowerer.leafValue(`(${value.cpp})->${callMember}`, callType),
            dataType,
            node,
        );
    }
    // A value with storage is shared as it is or adapted to the sink; its
    // identity is the storage's own, whether or not the sink compares it.
    // Only a declaration without storage, or one whose storage cannot serve
    // the sink, is lowered for the sink -- and a lowering that reaches
    // itself again refuses rather than recursing.
    const stored = storedSignature(lowerer, value);
    if (stored) {
        if (dataType.undefinedCompletion && !stored.undefinedCompletion)
            lowerer.context.fail(
                node,
                "A stored callback requires a proven undefined completion.",
            );
        if (
            dataTypesEqual(
                { ...stored, identity: true },
                { ...dataType, identity: true },
            )
        )
            return value.cpp;
        if (stored.generic || dataType.generic)
            lowerer.context.fail(
                node,
                "Stored generic function conversion requires matching concrete signature families.",
            );
        const adapted = adaptedCall(lowerer, stored, dataType, node);
        if (adapted) {
            // Parameters the sink does not declare read only what it passes;
            // arguments the value does not declare are dropped.
            if (
                stored.restParameter !== undefined ||
                stored.parameters.length > dataType.parameters.length
            )
                lowerer.noteArgumentsPastSignature(dataType, "reads", node);
            else if (stored.parameters.length < dataType.parameters.length)
                lowerer.noteArgumentsPastSignature(stored, "passes", node);
            return renderSignatureAdapter(
                lowerer,
                value.cpp,
                dataType,
                adapted.named,
                adapted.body,
            );
        }
    }
    if (value.kind === "callback" && value.callbackDeclaration) {
        const nativeType = lowerer.dataTypeAt(value.callbackDeclaration);
        if (
            nativeType?.kind === "function" &&
            nativeType.restParameter !== undefined &&
            dataType.restParameter === undefined &&
            !hasFixedTupleRest(
                lowerer.context.checker,
                value.callbackDeclaration,
            )
        ) {
            const cpp = lowerer.context.compileStoredDataFunction(
                value.callbackDeclaration,
                nativeType,
                value.callbackRecordOwner,
            );
            return lowerer.compileKnownValueForSink(
                lowerer.leafValue(cpp, nativeType),
                dataType,
                value.callbackDeclaration,
            );
        }
        return lowerer.context.compileStoredDataFunction(
            value.callbackDeclaration,
            dataType,
            value.callbackRecordOwner,
        );
    }
    return undefined;
}

export const functionsSinks: DataSinkOperations<"function"> = {
    function: { expression: expressionFunction, value: valueFunction },
};
