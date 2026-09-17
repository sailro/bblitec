/** Frame-count capture for independent engines, including module workers.
 * The adapter delegates rendering and readiness to the pinned startEngine.
 * Only its RAF timestamps and final cancellation differ during capture. */
export const engineCaptureEntryUrl = "/__capture/engine-entry.js";

export function engineFrameCaptureModule(targetFrame: number, entryUrl: string): string {
    if (!Number.isSafeInteger(targetFrame) || targetFrame < 0) {
        throw new Error("Engine capture frame must be a nonnegative integer.");
    }
    return `export * from ${JSON.stringify(entryUrl)};
import { startEngine as startPinnedEngine } from ${JSON.stringify(entryUrl)};
let nextEngine = 0;
const realm = crypto.randomUUID();
export function startEngine(engine) {
    const id = realm + ":" + nextEngine++;
    const ready = startPinnedEngine(engine);
    const render = engine._renderFn;
    if (typeof render !== "function") throw new Error("Pinned engine RAF contract changed.");
    cancelAnimationFrame(engine._animFrameId);
    let frame = 0;
    engine._renderFn = () => {
        render(frame * (1000 / 60));
        if (frame++ === ${targetFrame}) {
            cancelAnimationFrame(engine._animFrameId);
            engine._device.queue.onSubmittedWorkDone().then(() => {
                // A transferred OffscreenCanvas updates its placeholder at a
                // rendering opportunity after the producing task completes.
                requestAnimationFrame(() => requestAnimationFrame(async () => {
                    const result = await fetch("/__capture/engines?id=" + encodeURIComponent(id), { method: "POST" });
                    if (!result.ok) throw new Error("Engine capture completion failed.");
                }));
            });
        }
    };
    engine._animFrameId = requestAnimationFrame(engine._renderFn);
    return ready;
}
`;
}

/** Evaluated in the browser; the caller must await this asynchronous polling loop. */
export async function waitForCapturedEngines(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const response = await fetch("/__capture/engines");
        if (!response.ok) throw new Error("Engine capture status request failed.");
        const state: { completed: number; expected: number } = await response.json();
        if (state.completed > state.expected) {
            throw new Error("More engines started than the capture declares.");
        }
        if (state.completed === state.expected) return;
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for every engine to reach the capture frame.");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
}
