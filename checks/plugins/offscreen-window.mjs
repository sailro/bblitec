// Offscreen (worker) windows: the window trace lines
// `window frame=<n> now-ms=<t> canvas=<id>:<sequence>@<w>x<h> ...` name each
// canvas's presented-frame sequence. While the main realm is blocked
// (frames 80-180 of each phase) the main realm presents at most
// 8 frames and the worker at least 50; the button (the red row-35
// pixels) sits centred and its label expands while blocked; after the
// second press releases it the label contracts, the main realm resumes
// (more than 80 frames after frame 800) and the resize reaches both
// engines (700x279 canvases).
import assert from "node:assert/strict";
import { loadPng, windowSamples } from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/** @import { FrameSample } from "./support.mjs" */

/**
 * The main and worker canvas sequences of one frame sample.
 * @param {FrameSample | undefined} sample
 * @param {string} where
 */
function sequences(sample, where) {
    const [main, worker] = sample?.canvases ?? [];
    assert(main && worker, `${where}: missing two-canvas sample`);
    return { main: main.sequence, worker: worker.sequence };
}

/** @param {PluginContext} context */
export function check(context) {
    /** @type {Record<string, { mainFramesWhileBlocked: number, workerFramesWhileBlocked: number, buttonCenter: number, viewport: number[] }>} */
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend] ?? {})) {
            const where = `${backend}/${phase.id}`;
            const frames = windowSamples(phase.log);
            assert(
                frames.length > 100 &&
                    frames.every((frame) => frame.canvases.length === 2),
                `${where}: missing two-canvas progress`,
            );
            const blocked = frames.filter(
                (frame) => frame.frame >= 80 && frame.frame <= 180,
            );
            const blockedEnd = sequences(blocked.at(-1), where);
            const blockedStart = sequences(blocked[0], where);
            const mainDelta = blockedEnd.main - blockedStart.main;
            const workerDelta = blockedEnd.worker - blockedStart.worker;
            assert(
                mainDelta <= 8 && workerDelta >= 50,
                `${where}: the block did not isolate the main realm: ${mainDelta}/${workerDelta}`,
            );
            const png = loadPng(phase.image);
            let left = png.width;
            let right = -1;
            for (let x = 0; x < png.width; ++x) {
                const pixel = (35 * png.width + x) * 4;
                const r = png.data.readUInt8(pixel),
                    g = png.data.readUInt8(pixel + 1),
                    b = png.data.readUInt8(pixel + 2);
                if (r > 90 && r > g * 1.4 && r > b * 1.4) {
                    left = Math.min(left, x);
                    right = x + 1;
                }
            }
            const center = (left + right) / 2;
            assert(
                Math.abs(center - png.width / 2) <= 1,
                `${where}: the button is off centre: ${center}`,
            );
            if (phase.id.startsWith("blocked")) {
                assert(
                    right - left > 270,
                    `${where}: the block label did not expand`,
                );
            } else {
                assert(
                    right - left < 220,
                    `${where}: the unblock did not restore the short label`,
                );
                const late = frames.filter((frame) => frame.frame >= 800);
                assert(
                    sequences(late.at(-1), where).main -
                        sequences(late[0], where).main >
                        80,
                    `${where}: the main realm did not resume`,
                );
                assert(
                    late.every((frame) =>
                        frame.canvases.every(
                            (canvas) =>
                                canvas.width === 700 && canvas.height === 279,
                        ),
                    ),
                    `${where}: the responsive resize did not reach both engines`,
                );
            }
            details[where] = {
                mainFramesWhileBlocked: mainDelta,
                workerFramesWhileBlocked: workerDelta,
                buttonCenter: center,
                viewport: [png.width, png.height],
            };
            context.log(
                `${where}: main ${mainDelta} / worker ${workerDelta} frames while blocked, button centre ${center}`,
            );
        }
    }
    return { details };
}
