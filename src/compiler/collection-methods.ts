import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { dataTypesEqual, type DataType } from "./data-types.js";
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
    const input = lowerer.context.unwrap(expression.arguments[0]!);
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
        if (!source.dataType || !dataTypesEqual(source.dataType, type))
            lowerer.context.fail(input, "Map initialization requires a pair literal array or a Map of the same key/value types.");
        const entry = lowerer.context.allocateTemporaryCppName("map_entry");
        lowerer.context.emit(`for (const auto& ${entry} : ${source.cpp}) ${result}.set(${entry}.first, ${entry}.second);`);
    }
    lowerer.registerLocal(result, "owned");
    return { kind: "data", cpp: result, dataType: type };
}
