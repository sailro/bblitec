import type { SceneDefinition } from "./scene-registry.js";
import { nativeCaptureFrameBudget } from "./tooling/native-run.js";

export function androidCaptureSettings(
    scene: SceneDefinition | undefined,
    canvasOnly = false,
): { captureFrame: string; captureEnvironment: Record<string, string> } {
    const captureEnvironment: Record<string, string> = scene
        ? { ...scene.parity?.nativeEnvironment, BBLITE_TEST_PASS: "1" }
        : { BBLITE_MAX_FRAMES: "8" };
    const captureFrame = scene
        ? captureEnvironment.BBLITE_SCREENSHOT_FRAME ?? "0"
        : "5";
    if (scene) {
        captureEnvironment.BBLITE_MAX_FRAMES = String(nativeCaptureFrameBudget(captureEnvironment));
        delete captureEnvironment.BBLITE_SCREENSHOT_FRAME;
    }
    if (canvasOnly) captureEnvironment.BBLITE_CAPTURE_UI = "0";
    return { captureFrame, captureEnvironment };
}
