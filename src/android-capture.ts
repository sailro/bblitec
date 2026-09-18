import type { SceneDefinition } from "./scene-registry.js";
import type { NativeBackend } from "./tooling/artifacts.js";
import { measuredRunEnvironment } from "./tooling/native-run.js";

export function androidCaptureSettings(
    scene: SceneDefinition | undefined,
    { canvasOnly = false, backend = "sdl_gpu" }: { canvasOnly?: boolean; backend?: NativeBackend } = {},
): { captureFrame: string; captureEnvironment: Record<string, string> } {
    const captureEnvironment = measuredRunEnvironment({
        environment: scene?.parity?.nativeEnvironment ?? {},
        ...(!scene ? { frame: 5, maxFrames: 8 } : {}),
        backend,
        extra: { BBLITE_GPU_BACKEND: backend, ...(canvasOnly ? { BBLITE_CAPTURE_UI: "0" } : {}) },
    });
    const captureFrame = captureEnvironment.BBLITE_SCREENSHOT_FRAME ?? "0";
    delete captureEnvironment.BBLITE_SCREENSHOT_FRAME;
    return { captureFrame, captureEnvironment };
}

export function verifyAndroidNativeRun(log: string, runId: string, backend: NativeBackend): void {
    let selections = 0, exits = 0;
    let selected: string | undefined, exitStatus: string | undefined;
    for (const match of log.matchAll(/\b(?:GPU backend: (\S+)|Native exit: (-?\d+)) run=(\S+)/g)) {
        if (match[3] !== runId) continue;
        if (match[1] !== undefined) { selections++; selected = match[1]; }
        else { exits++; exitStatus = match[2]; }
    }
    if (selections !== 1 || selected !== backend) {
        throw new Error(`The Android app did not select ${backend} for this run; inspect logcat.txt.`);
    }
    if (exits !== 1) {
        throw new Error("The Android app did not report one native exit within 90 seconds; inspect logcat.txt and ensure the device is unlocked.");
    }
    if (exitStatus !== "0") throw new Error(`The Android app exited with status ${exitStatus}; inspect logcat.txt.`);
}
