import type ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { boundRecordValue } from "./bound-record-value.js";

type Context = Pick<LoweringServices, "unwrap" | "libraryGlobal" | "bindings">;

/** Resolve immutable constructor aliases without evaluating a getter or call. */
export function resolvedBuiltinConstructor(
    context: Context,
    expression: ts.Expression,
): Value["builtinConstructor"] {
    const global = context.libraryGlobal(expression);
    if (global === "ResizeObserver" || global === "MutationObserver")
        return global;
    return boundRecordValue(context, expression)?.builtinConstructor;
}
