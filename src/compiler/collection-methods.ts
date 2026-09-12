import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";

export function compileCollectionForEach(lowerer: DataLowerer, call: ts.CallExpression, owner: Value,
    type: DataType & { kind: "map" | "set" }): Value {
    if (call.arguments.length !== 1) lowerer.context.fail(call, "Collection.forEach requires one callback and no thisArg.");
    const callback = lowerer.context.unwrap(call.arguments[0]!);
    if (!ts.isIdentifier(callback) && !ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
        lowerer.context.fail(callback, "Collection.forEach requires a local function or function literal.");
    const source = lowerer.context.allocateTemporaryCppName("foreach_collection");
    const entry = lowerer.context.allocateTemporaryCppName("foreach_entry");
    lowerer.context.emit({ kind: "declaration", type: "auto", name: source, initializer: owner.cpp });
    // Copy each entry before the callback: deletion or replacement of its
    // collection slot must not alter already evaluated callback arguments.
    lowerer.context.emit(`for (const auto ${entry} : ${source}) {`);
    lowerer.context.increaseIndent();
    lowerer.context.pushScope(lowerer.context.allocateBlockPrefix());
    lowerer.context.enterRuntimeIteration();
    lowerer.context.enterRuntimeControlFlow();
    try {
        const value = type.kind === "map" ? lowerer.leafValue(`${entry}.second`, type.value) : lowerer.leafValue(entry, type.element);
        const key = type.kind === "map" ? lowerer.leafValue(`${entry}.first`, type.key) : value;
        const entryCaptures = [lowerer.context.registerNativeBinding(entry)];
        const result = lowerer.context.compileCallbackWithValues(callback, [
            { ...value, nativeCaptures: entryCaptures },
            { ...key, nativeCaptures: entryCaptures },
            { ...owner, cpp: source, nativeCaptures: [lowerer.context.registerNativeBinding(source)] },
        ], call, true);
        lowerer.context.emitDiscardedValue(result);
    } finally {
        lowerer.context.leaveRuntimeControlFlow();
        lowerer.context.leaveRuntimeIteration();
        lowerer.context.popScope();
        lowerer.context.decreaseIndent();
    }
    lowerer.context.emit("}");
    return { kind: "void", cpp: "" };
}

export function compileMapInitializer(lowerer: DataLowerer, expression: ts.NewExpression,
    type: DataType & { kind: "map" }): Value {
    if (expression.arguments?.length !== 1) lowerer.context.fail(expression, "new Map expects at most one iterable.");
    return compileEntryCollection(lowerer, expression.arguments[0]!, type);
}

/** Consume key/value entries for Map constructors and Object.fromEntries. */
export function compileEntryCollection(lowerer: DataLowerer, expression: ts.Expression,
    type: DataType & { kind: "map" }): Value {
    const input = lowerer.context.unwrap(expression);
    const result = lowerer.context.allocateTemporaryCppName("map_initialized");
    lowerer.context.emit(`${lowerer.context.dataTypes.cppType(type)} ${result};`);
    if (ts.isArrayLiteralExpression(input)) {
        // The iterable literal evaluates completely before Map consumes it.
        const entries = input.elements.map(element => {
            const pair = lowerer.context.unwrap(element);
            if (!ts.isArrayLiteralExpression(pair) || pair.elements.length !== 2)
                lowerer.context.fail(pair, "Map initializer entries must be key/value pairs.");
            const key = lowerer.compileForRetainedSink(pair.elements[0]!, type.key, "Map key");
            const keyName = lowerer.context.allocateTemporaryCppName("map_key");
            lowerer.context.emit({ kind: "declaration", type: "const auto", name: keyName, initializer: key });
            const value = lowerer.compileForRetainedSink(pair.elements[1]!, type.value, "Map value");
            const valueName = lowerer.context.allocateTemporaryCppName("map_value");
            lowerer.context.emit({ kind: "declaration", type: "const auto", name: valueName, initializer: value });
            return { keyName, valueName };
        });
        for (const entry of entries) lowerer.context.emit(`${result}.set(${entry.keyName}, ${entry.valueName});`);
    } else {
        const source = lowerer.context.compileValue(input);
        if (source.kind === "tuple") {
            for (const pair of source.tupleElements ?? []) {
                if (pair.kind !== "tuple" || pair.tupleElements?.length !== 2)
                    lowerer.context.fail(input, "Collection entries must be key/value pairs.");
                const key = lowerer.compileKnownValueForSink(pair.tupleElements[0]!, type.key, input);
                const value = lowerer.compileKnownValueForSink(pair.tupleElements[1]!, type.value, input);
                lowerer.context.emit(`${result}.set(${key}, ${value});`);
            }
        } else if (source.dataType?.kind === "map") {
            const entry = lowerer.context.allocateTemporaryCppName("map_entry");
            const key = lowerer.compileKnownValueForSink(lowerer.leafValue(`${entry}.first`, source.dataType.key), type.key, input);
            const value = lowerer.compileKnownValueForSink(lowerer.leafValue(`${entry}.second`, source.dataType.value), type.value, input);
            lowerer.context.emit(`for (const auto& ${entry} : ${source.cpp}) ${result}.set(${key}, ${value});`);
        } else if (source.dataType?.kind === "vector" || source.dataType?.kind === "span") {
            const pair = source.dataType.element;
            const element = pair.kind === "tuple" ? { kind: "number" } as const
                : pair.kind === "vector" || pair.kind === "span" ? pair.element : undefined;
            if (!element && pair.kind !== "product") lowerer.context.fail(input, "Collection entries must be arrays of key/value pairs.");
            const entry = lowerer.context.allocateTemporaryCppName("map_entry");
            const entryValue = lowerer.leafValue(entry, pair);
            const lane = (index: number) => lowerer.fixedTupleElement(entryValue, index, input) ??
                lowerer.leafValue(`${entry}[${index}]`, element!);
            const key = lowerer.compileKnownValueForSink(lane(0), type.key, input);
            const value = lowerer.compileKnownValueForSink(lane(1), type.value, input);
            lowerer.context.emit(`for (const auto& ${entry} : ${source.cpp}) {`);
            lowerer.context.increaseIndent();
            lowerer.context.emit(`if (${entry}.size() < 2) throw std::runtime_error("Collection entry requires a key and value");`);
            lowerer.context.emit(`${result}.set(${key}, ${value});`);
            lowerer.context.decreaseIndent();
            lowerer.context.emit("}");
        } else {
            lowerer.context.fail(input, "Collection initialization requires key/value pairs or a Map of matching types.");
        }
    }
    lowerer.registerLocal(result, "owned");
    return { kind: "data", cpp: result, dataType: type };
}
