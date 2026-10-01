import type ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/**
 * `new WeakRef(target)`: a fresh reference object holding its target. The
 * target is retained strongly, as the weak collections retain their keys
 * ([fidelity](../../docs/fidelity.md)): an implementation that never
 * collects it is a conforming one, so `deref` always answers the target.
 */
export function compileWeakRefNew(
    lowerer: DataLowerer,
    expression: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    if (context.libraryGlobal(expression.expression) !== "WeakRef")
        return undefined;
    const arguments_ = expression.arguments ?? [];
    if (arguments_.length !== 1)
        context.fail(expression, "new WeakRef takes one target.");
    const dataType = lowerer.dataTypeAt(expression);
    if (dataType?.kind !== "weak-ref")
        return context.fail(
            expression,
            "new WeakRef requires a target of the native data model.",
        );
    context.reachJsData();
    const target = lowerer.compileForRetainedSink(
        arguments_[0]!,
        dataType.target,
        "WeakRef",
    );
    return {
        kind: "data",
        cpp: `bbl::js::make_ref<${context.dataTypes.cppType(dataType.target)}>(${target})`,
        dataType,
        impure: true,
    };
}

/** `ref.deref()`: the retained target. */
export function compileWeakRefMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    if (method !== "deref" || owner.dataType?.kind !== "weak-ref")
        return context.fail(call, `WeakRef.${method} is not lowered.`);
    context.expectArgumentCount(call, 0, 0);
    return lowerer.leafValue(`(*(${owner.cpp}))`, owner.dataType.target);
}
