/**
 * Wall-clock settling shared by both browser screenshot harnesses.
 *
 * Registered scenes pin their measured pose explicitly. An ad-hoc source
 * cannot do that without changing the source under test, so its native
 * measured run simulates this same elapsed span at the fixed rate below.
 */
export const captureSettleMilliseconds = 3000;

/** Deterministic callback rate for an ad-hoc native measured run. */
export const adHocCaptureFramesPerSecond = 60;

/** The native frame options that reproduce the browser settle interval. */
export function adHocCaptureEnvironment(): Record<string, string> {
    // A timeout resolves no earlier than its requested span; select the
    // first fixed-rate frame strictly beyond that boundary. Besides matching
    // browser scheduling, this avoids a float32 delta sum landing one ulp
    // below an integral timer boundary.
    const frameCount = Math.floor(
        (captureSettleMilliseconds * adHocCaptureFramesPerSecond) / 1000,
    ) + 1;
    return {
        BBLITE_FRAME_DELTA_MS: String(1000 / adHocCaptureFramesPerSecond),
        BBLITE_SCREENSHOT_FRAME: String(frameCount - 1),
    };
}
