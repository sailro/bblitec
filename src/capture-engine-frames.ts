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
