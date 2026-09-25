import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { unwrapExpression } from "./syntax.js";

/** The single surface uses DPR 1; an application realm observes its window. */
export function devicePixelRatioValue(
    context: Pick<LoweringServices, "libraryGlobal" | "options">,
    node: ts.Expression,
): Value | undefined {
    node = unwrapExpression(node);
    const name = ts.isIdentifier(node)
        ? node.text
        : ts.isPropertyAccessExpression(node)
          ? node.name.text
          : undefined;
    if (name !== "devicePixelRatio" || context.libraryGlobal(node) !== name)
        return undefined;
    return {
        kind: "number",
        dataType: { kind: "number" },
        ...(context.options.workers
            ? { cpp: "bbl::pal::window_device_pixel_ratio()" }
            : { cpp: "1.0", staticNumber: 1 }),
    };
}
