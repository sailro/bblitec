/**
 * The pin's own MAX_LIGHTS, so the lights buffer is sized by it. The pin
 * declares it `let` because `setMaxLights` grows it at run time; its
 * initial value is the capacity this port freezes, and activation refuses
 * the growth.
 */
import { type LoweringContext } from "./context.js";
import { type ModuleValue } from "./pinned-record-lowerer.js";

const MODULE = "src/light/types.ts";

export function pinnedMaxLights(context: LoweringContext): number {
    return context.pinnedNumber(MODULE, "MAX_LIGHTS", { frozen: true });
}

/** MAX_LIGHTS as a lowered library reads it: the frozen capacity. */
export function pinnedMaxLightsValue(
    context: LoweringContext,
): readonly [string, ModuleValue] {
    return [
        `${MODULE}#MAX_LIGHTS`,
        { shape: { kind: "number" }, cpp: String(pinnedMaxLights(context)) },
    ];
}
