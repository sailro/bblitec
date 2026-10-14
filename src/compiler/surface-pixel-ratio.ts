import type { LoweringServices } from "./lowering-services.js";
import { sharedPinnedContext } from "../lowering/context.js";
import { lowerSurfaceResize } from "../lowering/surface-resize.js";

/** The lowered `resizeSurface` every application-realm engine installs. */
export function surfaceResizeFunction(
    context: Pick<LoweringServices, "nativeEmission">,
): string {
    return context.nativeEmission.lowerOnce("resize_surface", (name) =>
        lowerSurfaceResize(sharedPinnedContext(), name),
    );
}
