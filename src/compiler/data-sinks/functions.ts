import ts from "typescript";

import { dataTypesEqual, type DataType } from "../data-types.js";
import type { Value } from "../types.js";

import type { DataSinkHost, DataSinkOperations } from "./contracts.js";

function expressionFunction(
    dataType: DataType<"function">,
    lowerer: DataSinkHost,
    _expression: ts.Expression,
    unwrapped: ts.Expression,
): string {
    if (
        unwrapped.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(unwrapped) &&
            unwrapped.text === "undefined" &&
            !lowerer.context.lookupIdentifierValue(unwrapped))
    ) {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    if (ts.isIdentifier(unwrapped)) {
        const bound = lowerer.context.lookupIdentifierValue(unwrapped);
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
            dataType.restParameter === undefined
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
    if (value.kind === "callback") {
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
 * How a sink of `sink` type invokes a stored value of `source` type: the
 * leading sink parameters the value declares, by name (JavaScript ignores
 * the extras), or for a value declared with a rest parameter the leading
 * ones plus the remaining sink parameters packed into its array; a result
 * the sink does not read is dropped. `undefined` when the value needs
 * something the sink does not supply.
 */
function adaptedArguments(
    lowerer: DataSinkHost,
    source: DataType<"function">,
    sink: DataType<"function">,
): { named: number; arguments_: string[] } | undefined {
    if (
        sink.restParameter !== undefined ||
        sink.erasedParameters?.length ||
        source.erasedParameters?.length
    )
        return undefined;
    if (
        sink.result !== undefined &&
        (source.result === undefined ||
            !dataTypesEqual(source.result, sink.result))
    )
        return undefined;
    const fixed = source.restParameter ?? source.parameters.length;
    if (
        sink.parameters.length < fixed ||
        !source.parameters
            .slice(0, fixed)
            .every((parameter, index) =>
                dataTypesEqual(parameter, sink.parameters[index]!),
            )
    ) {
        return undefined;
    }
    const names = sink.parameters.map((_, index) => `argument_${index}`);
    if (source.restParameter === undefined)
        return { named: fixed, arguments_: names.slice(0, fixed) };
    const rest = source.parameters[source.restParameter];
    if (
        rest?.kind !== "vector" ||
        !sink.parameters
            .slice(fixed)
            .every((parameter) => dataTypesEqual(parameter, rest.element))
    )
        return undefined;
    return {
        named: sink.parameters.length,
        arguments_: [
            ...names.slice(0, fixed),
            `${lowerer.context.dataTypes.cppType(rest)}{${names.slice(fixed).join(", ")}}`,
        ],
    };
}

/**
 * The runtime's signature adapter around a stored value: a capture-less
 * invoker receives the sink's parameters, the first `named` by name, and
 * calls the value with `arguments_`; the value keeps its identity and
 * environment. The invoker spells its parameter from the storage itself,
 * because materialized storage may declare parameters by reference where
 * the data type spells them by value.
 */
function renderSignatureAdapter(
    lowerer: DataSinkHost,
    cpp: string,
    sink: DataType<"function">,
    named: number,
    arguments_: readonly string[],
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
    return (
        `bbl::js::adapt_callback<${cppType(sink)}>(${cpp}, [](std::remove_cvref_t<decltype(${cpp})>& callback${parameters}) -> ${result} { ` +
        `${sink.result ? "return " : "static_cast<void>("}callback(${arguments_.join(", ")})${sink.result ? "" : ")"}; })`
    );
}

function valueFunction(
    dataType: DataType<"function">,
    lowerer: DataSinkHost,
    value: Value,
    _node: ts.Node,
): string | undefined {
    if (value.kind === "json-null") {
        return `${lowerer.context.dataTypes.cppType(dataType)}{}`;
    }
    // A value with storage is shared as it is or adapted to the sink; its
    // identity is the storage's own, whether or not the sink compares it.
    // Only a declaration without storage, or one whose storage cannot serve
    // the sink, is lowered for the sink -- and a lowering that reaches
    // itself again refuses rather than recursing.
    const stored = storedSignature(lowerer, value);
    if (stored) {
        if (
            dataTypesEqual(
                { ...stored, identity: true },
                { ...dataType, identity: true },
            )
        )
            return value.cpp;
        const adapted = adaptedArguments(lowerer, stored, dataType);
        if (adapted)
            return renderSignatureAdapter(
                lowerer,
                value.cpp,
                dataType,
                adapted.named,
                adapted.arguments_,
            );
    }
    if (value.kind === "callback" && value.callbackDeclaration) {
        const nativeType = lowerer.dataTypeAt(value.callbackDeclaration);
        if (
            nativeType?.kind === "function" &&
            nativeType.restParameter !== undefined &&
            dataType.restParameter === undefined
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
