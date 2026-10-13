import { EmissionWeakMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { sharedPinnedContext } from "../lowering/context.js";
import { lowerSurfaceResize } from "../lowering/surface-resize.js";

const resizers = new EmissionWeakMap<object, string>();

/** The lowered `resizeSurface` a cap write installs in an application realm. */
export function surfaceResizeFunction(
    context: Pick<
        LoweringServices,
        "nativeEmission" | "allocateTemporaryCppName"
    >,
): string {
    let name = resizers.get(context);
    if (!name) {
        name = context.allocateTemporaryCppName("resize_surface");
        const lowered = lowerSurfaceResize(sharedPinnedContext(), name);
        context.nativeEmission.registerNativeFunction(
            lowered.prototype,
            lowered.lines,
        );
        resizers.set(context, name);
    }
    return name;
}
