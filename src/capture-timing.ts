/**
 * Wall-clock settling shared by both browser screenshot harnesses.
 *
 * Registered scenes pin their measured pose explicitly. An ad-hoc source
 * cannot do that without changing the source under test, so its native
 * measured run simulates this same elapsed span at the fixed rate below.
 */
export const captureSettleMilliseconds = 3000;

/** Deterministic callback rate for an ad-hoc native measured run. */
const adHocCaptureFramesPerSecond = 60;

/** The deterministic clock shared by explicit and wall-clock capture poses. */
export function fixedCaptureEnvironment(): Record<string, string> {
    return {
        BBLITE_FRAME_DELTA_MS: String(1000 / adHocCaptureFramesPerSecond),
    };
}

/**
 * The native frame options that reproduce a browser settle interval: the
 * harness's own by default, or a longer span a scene waits out. One frame
 * names both the screenshot and the engine frame a Window captures.
 */
export function adHocCaptureEnvironment(
    settleMilliseconds = captureSettleMilliseconds,
): Record<string, string> {
    // A timeout resolves no earlier than its requested span; select the
    // first fixed-rate frame strictly beyond that boundary. Besides matching
    // browser scheduling, this avoids a float32 delta sum landing one ulp
    // below an integral timer boundary.
    const elapsedFrameCount =
        Math.floor((settleMilliseconds * adHocCaptureFramesPerSecond) / 1000) +
        1;
    return {
        ...fixedCaptureEnvironment(),
        // Frame zero intentionally reports no elapsed time. The screenshot
        // index therefore equals the number of elapsed fixed steps needed to
        // cross the wall-clock boundary rather than being one less than it.
        BBLITE_SCREENSHOT_FRAME: String(elapsedFrameCount),
        BBLITE_CAPTURE_ENGINE_FRAME: String(elapsedFrameCount),
    };
}
