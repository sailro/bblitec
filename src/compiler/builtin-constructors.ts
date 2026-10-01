import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

type Context = Pick<LoweringServices, "unwrap" | "libraryGlobal" | "bindings">;

/** Resolve immutable constructor aliases without evaluating a getter or call. */
export function resolvedBuiltinConstructor(
    context: Context,
    expression: ts.Expression,
): Value["builtinConstructor"] {
    const global = context.libraryGlobal(expression);
    if (global === "ResizeObserver" || global === "MutationObserver")
        return global;
    const boundValue = (expression: ts.Expression): Value | undefined => {
        const node = context.unwrap(expression);
        if (ts.isIdentifier(node)) return context.bindings.lookupOptional(node);
        if (ts.isPropertyAccessExpression(node)) {
            const owner = boundValue(node.expression);
            if (
                owner?.recordGetters?.[node.name.text] ||
                owner?.recordSetters?.[node.name.text]
            )
                return undefined;
            return owner?.recordProperties?.[node.name.text];
        }
        return undefined;
    };
    return boundValue(expression)?.builtinConstructor;
}
