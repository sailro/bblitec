import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { unwrapExpression } from "./syntax.js";

/**
 * The single surface uses DPR 1; a Window realm reads its global's
 * property, which a definition can replace (`defineDevicePixelRatio`).
 */
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
        // A display change or a definition changes what the next read sees.
        ...(context.options.workers
            ? {
                  cpp: "static_cast<double>(*bbl::pal::realm_device_pixel_ratio())",
                  impure: true as const,
              }
            : { cpp: "1.0", staticNumber: 1 }),
    };
}

/** `Object.defineProperty(globalThis, "devicePixelRatio", { get })` in a Window realm. */
export function defineDevicePixelRatio(
    getterCpp: string,
    configurable: boolean,
): string {
    return `bbl::pal::WorkerRealm::current().define_device_pixel_ratio(${getterCpp}, ${configurable});`;
}
