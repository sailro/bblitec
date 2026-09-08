// Offscreen cadence: the presented-frame rate of each native canvas from
// the window trace (from frame 120 to the end of the run), beside the
// browser's main and worker requestAnimationFrame rates. A measurement:
// the rates are reported, and only their presence is asserted.
import assert from "node:assert/strict";
import { observedStep, requireObservations } from "./support.mjs";

export function check(context) {
    const observations = requireObservations(context);
    const browser = observedStep(observations, "cadence").extras;
    assert(browser.main && browser.worker, "the browser observation carries no main/worker rates");
    const native = {};
    for (const backend of context.backends) {
        const log = context.results[backend].run.log;
        const rows = [...log.matchAll(/window frame=(\d+) now-ms=([\d.]+)((?: canvas=\d+:\d+@\d+x\d+)+)/g)]
            .map((match) => ({ frame: Number(match[1]), time: Number(match[2]),
                canvases: new Map([...match[3].matchAll(/canvas=(\d+):(\d+)@/g)].map((canvas) => [Number(canvas[1]), Number(canvas[2])])) }));
        const first = rows.find((row) => row.frame >= 120);
        const last = rows.at(-1);
        assert(first && last && first.canvases.size === 2 && last.canvases.size === 2, `${backend}: missing native canvas samples`);
        const seconds = (last.time - first.time) / 1000;
        native[backend] = [...first.canvases].sort(([left], [right]) => left - right).map(([id, start]) => {
            const framesPerSecond = (last.canvases.get(id) - start) / seconds;
            return { canvas: id, seconds, framesPerSecond, degreesPerSecond: framesPerSecond * 0.0035 * 180 / Math.PI };
        });
        context.log(`${backend}: ${native[backend].map((row) => `canvas ${row.canvas} ${row.framesPerSecond.toFixed(1)} fps`).join(", ")}`);
    }
    context.log(`browser: main ${browser.main.framesPerSecond.toFixed(1)} fps, worker ${browser.worker.framesPerSecond.toFixed(1)} fps`);
    return { details: { browser, native } };
}
