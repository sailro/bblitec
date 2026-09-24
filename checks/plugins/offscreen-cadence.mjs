// Offscreen cadence: the presented-frame rate of each native canvas from
// the window trace (from frame 120 to the end of the run), beside the
// browser's main and worker requestAnimationFrame rates. A measurement:
// the rates are reported, and only their presence is asserted.
import assert from "node:assert/strict";
import { observedStep, requireObservations } from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {{ frames: number, seconds: number, framesPerSecond: number, degreesPerSecond: number }} Cadence
 * @typedef {{ main?: Cadence, worker?: Cadence }} BrowserCadence the `cadence` step's extras
 * @typedef {{ canvas: number, seconds: number, framesPerSecond: number, degreesPerSecond: number }} CanvasCadence
 */

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    const browser = /** @type {BrowserCadence} */ (
        observedStep(observations, "cadence").extras ?? {}
    );
    const { main, worker } = browser;
    assert(
        main && worker,
        "the browser observation carries no main/worker rates",
    );
    /** @type {Record<string, CanvasCadence[]>} */
    const native = {};
    for (const backend of context.backends) {
        const run = context.results[backend]?.run;
        assert(run, `${backend}: missing phase run`);
        const rows = [
            ...run.log.matchAll(
                /window frame=(\d+) now-ms=([\d.]+)((?: canvas=\d+:\d+@\d+x\d+)+)/g,
            ),
        ].map(([, frame, time, canvases]) => {
            assert(canvases !== undefined);
            return {
                frame: Number(frame),
                time: Number(time),
                canvases: new Map(
                    [...canvases.matchAll(/canvas=(\d+):(\d+)@/g)].map(
                        (canvas) => [Number(canvas[1]), Number(canvas[2])],
                    ),
                ),
            };
        });
        const first = rows.find((row) => row.frame >= 120);
        const last = rows.at(-1);
        assert(
            first &&
                last &&
                first.canvases.size === 2 &&
                last.canvases.size === 2,
            `${backend}: missing native canvas samples`,
        );
        const seconds = (last.time - first.time) / 1000;
        const rates = [...first.canvases]
            .sort(([left], [right]) => left - right)
            .map(([id, start]) => {
                const end = last.canvases.get(id);
                assert(end !== undefined, `${backend}: canvas ${id} vanished`);
                const framesPerSecond = (end - start) / seconds;
                return {
                    canvas: id,
                    seconds,
                    framesPerSecond,
                    degreesPerSecond:
                        (framesPerSecond * 0.0035 * 180) / Math.PI,
                };
            });
        native[backend] = rates;
        context.log(
            `${backend}: ${rates.map((row) => `canvas ${row.canvas} ${row.framesPerSecond.toFixed(1)} fps`).join(", ")}`,
        );
    }
    context.log(
        `browser: main ${main.framesPerSecond.toFixed(1)} fps, worker ${worker.framesPerSecond.toFixed(1)} fps`,
    );
    return { details: { browser, native } };
}
