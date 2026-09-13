import type ts from "typescript";
import {EmissionWeakMap} from "./emission-transaction.js";
import {renderClosure} from "./closure-captures.js";
import type {Value} from "./types.js";
import type {DataSinkHost} from "./data-sinks/contracts.js";

// Record aliases share this table even when an inline call renames the value.
const views = new EmissionWeakMap<object, Value>();

/** A fixed plain record keeps its existing cells behind an observing view. */
export function compileJsonRecordView(lowerer: DataSinkHost, record: Value, node: ts.Node): string | undefined {
    const properties = record.recordProperties;
    if (record.kind !== "record" || !properties || record.classDeclaration || record.moduleNamespace || record.objectIdentityCpp ||
        Object.keys(record.recordMethods ?? {}).length || Object.keys(record.recordGetters ?? {}).length ||
        Object.keys(record.recordSetters ?? {}).length) return undefined;
    const context = lowerer.context;
    const previous = views.get(properties);
    if (previous) { context.useNativeValue(previous); return previous.cpp; }
    // This path retains the original property table and mutable scalar cells.
    // Supplying a source expression here could instead construct a second record.
    context.materializeEscapingValue(record, "dynamic_record");
    const fields = Object.entries(properties).map(([name, value]) => {
        const nested = value.kind === "record" ? compileJsonRecordView(lowerer, value, node) : undefined;
        return {name, value: nested ? lowerer.leafValue(nested, {kind:"json"}) : value};
    });
    const key = context.allocateTemporaryCppName("dynamic_key");
    const body = context.captureManagedClosureLines(() => {
        context.registerNativeBinding(key);
        for (const field of fields) {
            const value = lowerer.compileKnownValueForSink(field.value, {kind:"json"}, node);
            context.emit(`if (${key} == ${context.cppString(field.name)}) return ${value};`);
        }
        context.emit("return {};");
    });
    const cpp = context.allocateTemporaryCppName("dynamic_record_view");
    context.emit({kind:"declaration", type:"auto", name:cpp,
        initializer:`bbl::js::JsonValue::from_record_view(${renderClosure(body, `std::string_view ${key}`, "bbl::js::JsonValue")}, ` +
            `bbl::js::Array<std::string>{${fields.map(field => context.cppString(field.name)).join(", ")}})`});
    const result = {...lowerer.leafValue(cpp, {kind:"json"}), nativeCaptures:[context.registerNativeBinding(cpp)]};
    views.set(properties, result);
    context.useNativeValue(result);
    return cpp;
}
