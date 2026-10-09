import type ts from "typescript";
import { EmissionWeakMap } from "./emission-transaction.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import type { CapturedClosure } from "./closure-captures.js";
import type { Value } from "./types.js";
import type { DataSinkHost } from "./data-sinks/contracts.js";

// Record aliases share this table even when an inline call renames the value.
const views = new EmissionWeakMap<object, Value>();

function sharedGetter(
    lowerer: DataSinkHost,
    body: CapturedClosure,
    parameter: string,
    parameterType: string,
): string {
    const context = lowerer.context;
    const name = context.allocateTemporaryCppName("dynamic_view_getter");
    const shared = context.nativeEmission.registerSharedNativeFunction(
        name,
        [
            `struct ${name} {`,
            "    template<typename Environment>",
            `    bbl::js::JsonValue operator()([[maybe_unused]] Environment& ${body.environment}, [[maybe_unused]] ${parameterType} ${parameter}) const {`,
            ...body.lines.map((line) => `        ${line}`),
            "    }",
            "};",
        ],
        [...body.localBindings, body.environment, parameter],
    );
    return `bbl::js::make_closure(${body.initializer}, bblscene::${shared}{})`;
}

export function compileJsonTupleView(
    lowerer: DataSinkHost,
    tuple: Value,
    node: ts.Node,
): string | undefined {
    const elements = tuple.tupleElements;
    if (tuple.kind !== "tuple" || !elements || tuple.cpp) return undefined;
    const context = lowerer.context;
    const previous = views.get(elements);
    if (previous) {
        context.useNativeValue(previous);
        return previous.cpp;
    }
    const values = elements.map((value) => {
        const nested =
            compileJsonRecordView(lowerer, value, node) ??
            compileJsonTupleView(lowerer, value, node);
        return nested ? lowerer.leafValue(nested, { kind: "json" }) : value;
    });
    const index = context.allocateTemporaryCppName("dynamic_index");
    const body = context.captureManagedClosureLines(() => {
        context.registerNativeBinding(index);
        values.forEach((value, slot) => {
            const cpp = lowerer.compileMemberForSink(
                value,
                { kind: "json" },
                node,
                slot,
            );
            context.emit(`if (${index} == ${slot}) return ${cpp};`);
        });
        context.emit({
            kind: "control",
            code: "return {};",
            transfer: "return",
        });
    });
    const cpp = context.allocateTemporaryCppName("dynamic_tuple_view");
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer: `bbl::js::JsonValue::from_tuple_view(${sharedGetter(lowerer, body, index, "std::size_t")}, ${values.length})`,
    });
    const result = {
        ...lowerer.leafValue(cpp, { kind: "json" }),
        nativeCaptures: [
            context.registerNativeBinding(
                cpp,
                false,
                false,
                "bbl::js::JsonValue",
            ),
        ],
    };
    views.set(elements, result);
    context.useNativeValue(result);
    return cpp;
}

/** Plain record facts that either JSON ownership strategy can preserve. */
export function isPlainJsonRecord(record: Value): boolean {
    return (
        record.kind === "record" &&
        !record.classDeclaration &&
        !record.moduleNamespace &&
        !record.objectIdentityCpp &&
        Object.keys(record.recordMethods ?? {}).length === 0 &&
        Object.keys(record.recordGetters ?? {}).length === 0 &&
        Object.keys(record.recordSetters ?? {}).length === 0
    );
}

/** A fixed plain record keeps its existing cells behind an observing view. */
export function compileJsonRecordView(
    lowerer: DataSinkHost,
    record: Value,
    node: ts.Node,
): string | undefined {
    const properties = record.recordProperties;
    if (!isPlainJsonRecord(record) || !properties) return undefined;
    const context = lowerer.context;
    const expression = lowerer.convertedExpression(node);
    const declaration =
        expression && context.bindings.recordDeclaration(record, expression);
    if (declaration) {
        // A retained alias needs one owner in the source binding's scope.
        // A cached view created here could belong to a nested callback.
        if (context.dynamicBindings.has(declaration))
            context.fail(
                node,
                "A retained record requires a represented document owner.",
            );
        throw new DynamicBindingStorageRequired(declaration, "source");
    }
    const previous = views.get(properties);
    if (previous) {
        context.useNativeValue(previous);
        return previous.cpp;
    }
    // This path retains the original property table and mutable scalar cells.
    // Supplying a source expression here could instead construct a second record.
    context.bindings.materializeEscapingValue(record, "dynamic_record");
    const fields = Object.entries(properties).map(([name, value]) => {
        const nested =
            compileJsonRecordView(lowerer, value, node) ??
            compileJsonTupleView(lowerer, value, node);
        return {
            name,
            value: nested ? lowerer.leafValue(nested, { kind: "json" }) : value,
        };
    });
    const key = context.allocateTemporaryCppName("dynamic_key");
    const body = context.captureManagedClosureLines(() => {
        context.registerNativeBinding(key);
        for (const field of fields) {
            const value = lowerer.compileMemberForSink(
                field.value,
                { kind: "json" },
                node,
                field.name,
            );
            context.emit(
                `if (${key} == ${context.cppString(field.name)}) return ${value};`,
            );
        }
        context.emit({
            kind: "control",
            code: "return {};",
            transfer: "return",
        });
    });
    const cpp = context.allocateTemporaryCppName("dynamic_record_view");
    context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer:
            `bbl::js::JsonValue::from_record_view(${sharedGetter(lowerer, body, key, "std::string_view")}, ` +
            `bbl::js::Array<std::string>{${fields.map((field) => context.cppString(field.name)).join(", ")}})`,
    });
    const result = {
        ...lowerer.leafValue(cpp, { kind: "json" }),
        nativeCaptures: [
            context.registerNativeBinding(
                cpp,
                false,
                false,
                "bbl::js::JsonValue",
            ),
        ],
    };
    views.set(properties, result);
    context.useNativeValue(result);
    return cpp;
}
