import type ts from "typescript";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

/** What the native slot holds: the pin's `(now: number) => void`. */
const SLOT_CPP = "bbl::js::Callback<void(double)>";

type RenderFunctionContext = Pick<
    LoweringServices,
    "dataLowerer" | "dataTypes" | "fail" | "emit" | "allocateTemporaryCppName"
>;

/**
 * `engine._renderFn` as the program types it, which must be the pin's
 * `((now: number) => void) | null`: the frame `startEngine` schedules
 * (`Engine::render_function`, which the frame conductor arms from).
 */
function renderFunctionType(
    context: RenderFunctionContext,
    access: ts.Expression,
): DataType {
    const mapped = context.dataLowerer.dataTypeAt(access);
    if (
        mapped?.kind !== "function" ||
        context.dataTypes.cppType(mapped) !== SLOT_CPP
    )
        return context.fail(
            access,
            "engine._renderFn holds the engine's (now: number) => void frame function.",
        );
    return mapped;
}

/** `engine._renderFn`: empty before `startEngine` and after `stopEngine`. */
export function readEngineRenderFunction(
    context: RenderFunctionContext,
    engine: Value,
    access: ts.PropertyAccessExpression,
): Value {
    return {
        ...context.dataLowerer.leafValue(
            `bbl::engine_render_function(${engine.cpp})`,
            renderFunctionType(context, access),
        ),
        impure: true,
    };
}

/** `engine._renderFn = value`: the frame in flight re-arms with it once it rendered. */
export function emitEngineRenderFunctionWrite(
    context: RenderFunctionContext,
    engine: Value,
    assignment: ts.BinaryExpression,
): void {
    const type = renderFunctionType(context, assignment.left);
    // The owner is evaluated before the assigned value.
    const owner = context.allocateTemporaryCppName("render_function_engine");
    context.emit({
        kind: "declaration",
        type: "auto&",
        name: owner,
        initializer: engine.cpp,
        attributes: "[[maybe_unused]] ",
    });
    context.emit({
        kind: "expression",
        code: `bbl::set_engine_render_function(${owner}, ${context.dataLowerer.compileForSink(assignment.right, type)});`,
    });
}
