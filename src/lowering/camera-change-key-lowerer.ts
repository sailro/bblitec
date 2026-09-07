import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";

/** A shared header for consumers of the pin's camera projection/version key.
 * The guard also permits embedding it in a standalone generated cache header. */
export function cameraChangeKeyHeader(context: LoweringContext): string {
    const body = lowerPinnedFunction(context, "src/camera/camera.ts", "_cameraChangeKey", [
        { pinned: "camera", kind: "record", annotation: "Camera", cpp: "camera", cppType: "Camera", mutableRecord: true },
    ], { cppName: "scene_camera_change_key", returns: "double", templateParameters: ["class Camera"], booleanOr: true,
        memberBindings: new Map([
            ["camera._projFov", { cpp: "camera.projection_fov", type: "scalar" }],
            ["camera._projNear", { cpp: "camera.projection_near", type: "scalar" }],
            ["camera._projFar", { cpp: "camera.projection_far", type: "scalar" }],
            ["camera._projRev", { cpp: "camera.projection_revision", type: "scalar" }],
            ["camera.worldMatrixVersion", { cpp: "camera.world_matrix_version", type: "scalar" }],
            ["camera.fov", { cpp: "camera.fov", type: "scalar" }],
            ["camera.nearPlane", { cpp: "camera.near_plane", type: "scalar" }],
            ["camera.farPlane", { cpp: "camera.far_plane", type: "scalar" }],
        ]),
    });
    return `#ifndef BBLITE_UPSTREAM_CAMERA_CHANGE_KEY_HPP
#define BBLITE_UPSTREAM_CAMERA_CHANGE_KEY_HPP
namespace bbl::upstream {
${body}
} // namespace bbl::upstream
#endif
`;
}
