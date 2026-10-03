import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

/** Inspect existing record metadata without evaluating a receiver or getter. */
export function boundRecordValue(
    context: Pick<LoweringServices, "unwrap" | "bindings">,
    expression: ts.Expression,
): Value | undefined {
    const node = context.unwrap(expression);
    if (ts.isIdentifier(node)) return context.bindings.lookupOptional(node);
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    const owner = boundRecordValue(context, node.expression);
    if (
        owner?.recordGetters?.[node.name.text] ||
        owner?.recordSetters?.[node.name.text]
    )
        return undefined;
    return owner?.recordProperties?.[node.name.text];
}
