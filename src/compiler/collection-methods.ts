import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import { optionalPresentCpp, optionalValueCpp, type Value } from "./types.js";
import { compileJsonPropertyKey, isJsonValue } from "./json-bridge.js";

/** Construct from a present iterable; both absent values create an empty owner. */
export function compileCollectionIterable(
    lowerer: DataLowerer,
    source: Value,
    type: DataType<"map" | "set">,
    initialize: (present: Value) => Value,
): Value {
    const optional = source.dataType?.kind === "optional";
    const document = type.kind === "set" && isJsonValue(source);
    if (!optional && !document) return initialize(source);
    const owner = lowerer.context.bindings.pinValueToTemporary(
        source,
        "collection_iterable",
    );
    const result = lowerer.context.allocateTemporaryCppName(
        "collection_initialized",
    );
    const cppType = lowerer.context.dataTypes.cppType(type);
    lowerer.context.emit({
        kind: "open",
        code: `auto ${result} = [&]() -> ${cppType} {`,
    });
    lowerer.context.increaseIndent();
    const construct = (value: Value): void => {
        const initialized = initialize(value);
        lowerer.context.emit({
            kind: "expression",
            code: `return ${initialized.cpp};`,
        });
    };
    const present = optional
        ? optionalPresentCpp(owner.cpp)
        : `!${owner.cpp}.is_null() && !${owner.cpp}.is_undefined()`;
    lowerer.context.emit({ kind: "open", code: `if (${present}) {` });
    lowerer.context.increaseIndent();
    lowerer.context.enterRuntimeControlFlow();
    try {
        if (source.dataType?.kind === "optional") {
            construct(
                lowerer.leafValue(
                    optionalValueCpp(owner.cpp),
                    source.dataType.inner,
                ),
            );
        } else {
            lowerer.context.emit({
                kind: "open",
                code: `if (${owner.cpp}.is_array()) {`,
            });
            lowerer.context.increaseIndent();
            construct(owner);
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
            if (
                type.kind === "set" &&
                (type.element.kind === "string" || type.element.kind === "json")
            ) {
                lowerer.context.emit({
                    kind: "open",
                    code: `else if (${owner.cpp}.is_string()) {`,
                });
                lowerer.context.increaseIndent();
                construct(
                    lowerer.leafValue(`${owner.cpp}.string_value()`, {
                        kind: "string",
                    }),
                );
                lowerer.context.decreaseIndent();
                lowerer.context.emit({ kind: "close", code: "}" });
            }
            lowerer.context.emit({ kind: "open", code: "else {" });
            lowerer.context.increaseIndent();
            lowerer.context.emit({
                kind: "expression",
                code: 'std::rethrow_exception(bbl::js::make_error("TypeError", "Set constructor requires a represented iterable", std::exception_ptr{}));',
            });
            lowerer.context.decreaseIndent();
            lowerer.context.emit({ kind: "close", code: "}" });
        }
    } finally {
        lowerer.context.leaveRuntimeControlFlow();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit({ kind: "close", code: "}" });
    lowerer.context.emit({ kind: "expression", code: `return ${cppType}{};` });
    lowerer.context.decreaseIndent();
    lowerer.context.emit({ kind: "close", code: "}();" });
    lowerer.registerLocal(result, "owned");
    return { kind: "data", cpp: result, dataType: type };
}

export function compileCollectionForEach(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    type: DataType & { kind: "map" | "set" },
): Value {
    if (call.arguments.length !== 1)
        lowerer.context.fail(
            call,
            "Collection.forEach requires one callback and no thisArg.",
        );
    const callback = lowerer.context.unwrap(call.arguments[0]!);
    if (
        !ts.isIdentifier(callback) &&
        !ts.isArrowFunction(callback) &&
        !ts.isFunctionExpression(callback)
    )
        lowerer.context.fail(
            callback,
            "Collection.forEach requires a local function or function literal.",
        );
    const source =
        lowerer.context.allocateTemporaryCppName("foreach_collection");
    const entry = lowerer.context.allocateTemporaryCppName("foreach_entry");
    lowerer.context.emit({
        kind: "declaration",
        type: "auto",
        name: source,
        initializer: owner.cpp,
    });
    // Copy each entry before the callback: deletion or replacement of its
    // collection slot must not alter already evaluated callback arguments.
    // A non-const copy states that intent to clang's range-loop-construct.
    lowerer.context.emit({
        kind: "open",
        code: `for (auto ${entry} : ${source}) {`,
        iteration: true,
    });
    lowerer.context.increaseIndent();
    lowerer.context.bindings.pushScope(lowerer.context.allocateBlockPrefix());
    lowerer.context.enterRuntimeIteration();
    lowerer.context.enterRuntimeControlFlow();
    try {
        const value =
            type.kind === "map"
                ? lowerer.leafValue(`${entry}.second`, type.value)
                : lowerer.leafValue(entry, type.element);
        const key =
            type.kind === "map"
                ? lowerer.leafValue(`${entry}.first`, type.key)
                : value;
        const entryCaptures = [lowerer.context.registerNativeBinding(entry)];
        const result = lowerer.context.compileCallbackWithValues(
            callback,
            [
                { ...value, nativeCaptures: entryCaptures },
                { ...key, nativeCaptures: entryCaptures },
                {
                    ...owner,
                    cpp: source,
                    nativeCaptures: [
                        lowerer.context.registerNativeBinding(source),
                    ],
                },
            ],
            call,
            true,
        );
        lowerer.context.emitDiscardedValue(result);
    } finally {
        lowerer.context.leaveRuntimeControlFlow();
        lowerer.context.leaveRuntimeIteration();
        lowerer.context.bindings.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit({ kind: "close", code: "}" });
    return { kind: "void", cpp: "" };
}

export function compileMapInitializer(
    lowerer: DataLowerer,
    expression: ts.NewExpression,
    type: DataType & { kind: "map" },
): Value {
    if (expression.arguments?.length !== 1)
        lowerer.context.fail(
            expression,
            "new Map expects at most one iterable.",
        );
    return compileEntryCollection(
        lowerer,
        expression.arguments[0]!,
        type,
        true,
    );
}

/** Consume key/value entries for Map constructors and Object.fromEntries. */
export function compileCollectionEntries(
    lowerer: DataLowerer,
    expression: ts.Expression,
    type: DataType<"map"> | undefined,
): Value {
    const input = lowerer.context.unwrap(expression);
    const callee = ts.isCallExpression(input)
        ? lowerer.context.unwrap(input.expression)
        : undefined;
    const owner =
        callee && ts.isPropertyAccessExpression(callee)
            ? lowerer.context.unwrap(callee.expression)
            : undefined;
    const staticOwner =
        owner &&
        (ts.isArrayLiteralExpression(owner) ||
            (ts.isIdentifier(owner) &&
                lowerer.context.bindings.lookupOptional(owner)?.kind ===
                    "tuple"));
    return (
        (type &&
        !type.dictionary &&
        ts.isCallExpression(input) &&
        callee &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "map" &&
        !staticOwner
            ? lowerer.compileDataMethodCall(input, {
                  kind: "vector",
                  element: {
                      kind: "product",
                      elements: [type.key, type.value],
                  },
              })
            : undefined) ?? lowerer.context.compileValue(input)
    );
}

export function compileEntryCollection(
    lowerer: DataLowerer,
    expression: ts.Expression,
    type: DataType & { kind: "map" },
    absentIsEmpty = false,
): Value {
    const input = lowerer.context.unwrap(expression);
    const compileKey = (value: Value, keyType: DataType): string => {
        if (!type.dictionary)
            return lowerer.compileLaneForSink(value, keyType, input);
        const key = compileJsonPropertyKey(lowerer.context, value, input);
        // Heterogeneous pairs can share a union element carrier. Converting
        // that held key uses its document view, including nullable payloads.
        if (
            value.dataType &&
            !["string", "number", "boolean", "enum"].includes(
                value.dataType.kind,
            )
        )
            lowerer.context.reachJson();
        return key;
    };
    if (
        ts.isArrayLiteralExpression(input) &&
        input.elements.every((element) =>
            ts.isArrayLiteralExpression(lowerer.context.unwrap(element)),
        )
    ) {
        const result =
            lowerer.context.allocateTemporaryCppName("map_initialized");
        lowerer.context.emit(
            `${lowerer.context.dataTypes.cppType(type)} ${result};`,
        );
        // The iterable literal evaluates completely before Map consumes it.
        const entries = input.elements.map((element) => {
            const pair = lowerer.context.unwrap(element);
            if (
                !ts.isArrayLiteralExpression(pair) ||
                pair.elements.length !== 2
            )
                lowerer.context.fail(
                    pair,
                    "Map initializer entries must be key/value pairs.",
                );
            let key: Value;
            if (type.dictionary) {
                // ToPropertyKey runs when entries are consumed, after the
                // whole iterable literal has evaluated. Keep the key owner
                // so later entries may still mutate it before conversion.
                key = lowerer.context.bindings.pinValueToTemporary(
                    lowerer.context.compileValue(pair.elements[0]!),
                    "map_key",
                    pair.elements[0],
                );
            } else {
                const cpp = lowerer.compileForRetainedSink(
                    pair.elements[0]!,
                    type.key,
                    "Map key",
                );
                const name =
                    lowerer.context.allocateTemporaryCppName("map_key");
                lowerer.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name,
                    initializer: cpp,
                });
                key = lowerer.leafValue(name, type.key);
            }
            const value = lowerer.compileForRetainedSink(
                pair.elements[1]!,
                type.value,
                "Map value",
            );
            const valueName =
                lowerer.context.allocateTemporaryCppName("map_value");
            lowerer.context.emit({
                kind: "declaration",
                type: "const auto",
                name: valueName,
                initializer: value,
            });
            return { key, valueName };
        });
        for (const entry of entries) {
            const key = compileKey(entry.key, type.key);
            lowerer.context.emit({
                kind: "expression",
                code: `${result}.set(${key}, ${entry.valueName});`,
            });
        }
        lowerer.registerLocal(result, "owned");
        return { kind: "data", cpp: result, dataType: type };
    }
    const initialize = (source: Value): Value => {
        if (
            source.dataType?.kind === "iterator" &&
            source.dataType.asynchronous
        )
            lowerer.context.fail(
                input,
                "Collection entries require a represented synchronous iterable.",
            );
        const iterated = lowerer.iteratedElements(source);
        const element =
            iterated && "range" in iterated ? iterated.element : undefined;
        const collectionType =
            element?.kind === "product" && element.elements.length === 2
                ? {
                      ...type,
                      key:
                          type.dictionary || type.key.kind === "tagged"
                              ? type.key
                              : lowerer.context.dataTypes.collectionKeyStorage(
                                    element.elements[0]!,
                                ),
                      value: element.elements[1]!,
                  }
                : source.dataType?.kind === "map"
                  ? { ...type, value: source.dataType.value }
                  : element?.kind === "vector"
                    ? {
                          ...type,
                          value: lowerer.retainedResultType(
                              {
                                  kind: "data",
                                  cpp: "",
                                  dataType: element.element,
                              },
                              type.value,
                              input,
                          ),
                      }
                    : type;
        const result =
            lowerer.context.allocateTemporaryCppName("map_initialized");
        lowerer.context.emit(
            `${lowerer.context.dataTypes.cppType(collectionType)} ${result};`,
        );
        if (source.kind === "tuple") {
            for (const pair of source.tupleElements ?? []) {
                const lanes =
                    pair.kind === "tuple"
                        ? pair.tupleElements?.length === 2
                            ? pair.tupleElements
                            : undefined
                        : storedPairLanes(lowerer, pair, input);
                if (!lanes)
                    lowerer.context.fail(
                        input,
                        "Collection entries must be key/value pairs.",
                    );
                const key = compileKey(lanes[0]!, collectionType.key);
                const value = lowerer.compileLaneForSink(
                    lanes[1]!,
                    collectionType.value,
                    input,
                );
                lowerer.context.emit({
                    kind: "expression",
                    code: `${result}.set(${key}, ${value});`,
                });
            }
        } else if (source.dataType?.kind === "map") {
            const entry = lowerer.context.allocateTemporaryCppName("map_entry");
            const key = compileKey(
                lowerer.leafValue(`${entry}.first`, source.dataType.key),
                collectionType.key,
            );
            const value = lowerer.compileLaneForSink(
                lowerer.leafValue(`${entry}.second`, source.dataType.value),
                collectionType.value,
                input,
            );
            lowerer.context.emit({
                kind: "expression",
                code: `for (const auto& ${entry} : ${source.cpp}) ${result}.set(${key}, ${value});`,
            });
        } else if (iterated && "range" in iterated) {
            const entry = lowerer.context.allocateTemporaryCppName("map_entry");
            lowerer.context.emit({
                kind: "open",
                code: `for (const auto& ${entry} : ${iterated.range.cpp}) {`,
                iteration: true,
            });
            lowerer.context.increaseIndent();
            lowerer.context.bindings.pushScope(
                lowerer.context.allocateBlockPrefix(),
            );
            lowerer.context.enterRuntimeIteration();
            lowerer.context.enterRuntimeControlFlow();
            try {
                const lanes = nativePairLanes(
                    lowerer,
                    {
                        ...lowerer.leafValue(entry, iterated.element),
                        nativeCaptures: [
                            lowerer.context.registerNativeBinding(entry),
                        ],
                    },
                    input,
                );
                if (!lanes)
                    lowerer.context.fail(
                        input,
                        "Collection entries must be arrays of key/value pairs.",
                    );
                lowerer.context.emit({
                    kind: "expression",
                    code: `if (${entry}.size() < 2) throw std::runtime_error("Collection entry requires a key and value");`,
                });
                const key = lowerer.context.allocateTemporaryCppName("map_key");
                lowerer.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: key,
                    initializer: compileKey(lanes[0], collectionType.key),
                });
                const value =
                    lowerer.context.allocateTemporaryCppName("map_value");
                lowerer.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: value,
                    initializer: lowerer.compileLaneForSink(
                        lanes[1],
                        collectionType.value,
                        input,
                    ),
                });
                lowerer.context.emit({
                    kind: "expression",
                    code: `${result}.set(${key}, ${value});`,
                });
            } finally {
                lowerer.context.leaveRuntimeControlFlow();
                lowerer.context.leaveRuntimeIteration();
                lowerer.context.bindings.popScope();
                lowerer.context.decreaseIndent();
            }
            lowerer.context.emit({ kind: "close", code: "}" });
        } else {
            lowerer.context.fail(
                input,
                "Collection initialization requires key/value pairs or a Map of matching types.",
            );
        }
        lowerer.registerLocal(result, "owned");
        return { kind: "data", cpp: result, dataType: collectionType };
    };
    const source = compileCollectionEntries(lowerer, input, type);
    return absentIsEmpty
        ? compileCollectionIterable(lowerer, source, type, initialize)
        : initialize(source);
}

/**
 * The lanes of one native pair a compile-time entry list holds, evaluated
 * once; an array pair must carry a key and a value, as the stored form's
 * loop checks.
 */
function storedPairLanes(
    lowerer: DataLowerer,
    pair: Value,
    node: ts.Node,
): readonly [Value, Value] | undefined {
    const kind = pair.dataType?.kind;
    if (
        kind !== "tuple" &&
        kind !== "product" &&
        kind !== "vector" &&
        kind !== "span"
    )
        return undefined;
    const pinned = lowerer.context.bindings.pinValueToTemporary(
        pair,
        "map_entry",
    );
    if (kind === "vector" || kind === "span")
        lowerer.context.emit({
            kind: "expression",
            code: `if (${pinned.cpp}.size() < 2) throw std::runtime_error("Collection entry requires a key and value");`,
        });
    return nativePairLanes(lowerer, pinned, node);
}

/**
 * The key and value lanes of a native entry pair: a fixed tuple's own
 * lanes, or an array's first two elements. Undefined for any other value.
 * An array pair's length is the consumer's to check.
 */
function nativePairLanes(
    lowerer: DataLowerer,
    pair: Value,
    node: ts.Node,
): readonly [Value, Value] | undefined {
    const type = pair.dataType;
    if (type?.kind === "tuple" || type?.kind === "product")
        return [
            lowerer.fixedTupleElement(pair, 0, node)!,
            lowerer.fixedTupleElement(pair, 1, node)!,
        ];
    if (type?.kind !== "vector" && type?.kind !== "span") return undefined;
    return [
        lowerer.leafValue(`${pair.cpp}[0]`, type.element),
        lowerer.leafValue(`${pair.cpp}[1]`, type.element),
    ];
}
