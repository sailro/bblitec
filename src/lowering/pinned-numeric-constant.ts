import type { LoweringContext } from "./context.js";

/**
 * A numeric pinned constant: `LoweringContext.pinnedNumber` under the name
 * its remaining importers still call. New readers call `pinnedNumber`.
 */
export function pinnedNumericConstant(
    context: LoweringContext,
    modulePath: string,
    name: string,
): number {
    return context.pinnedNumber(modulePath, name);
}
