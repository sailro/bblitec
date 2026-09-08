// Offscreen (worker) windows: the window trace lines
// `window frame=<n> now-ms=<t> canvas=<id>:<sequence>@<w>x<h> ...` name each
// canvas's presented-frame sequence. While the host button is held
// (frames 80-180 of the blocked phase) the main realm presents at most
// 8 frames and the worker at least 50; the button (the red row-35
// pixels) sits centred and its label expands while blocked; after the
// second press releases it the label contracts, the main realm resumes
// (more than 80 frames after frame 500) and the resize reaches both
// engines (700x279 canvases).
import assert from "node:assert/strict";
import { loadPng } from "./support.mjs";

const samples = (log) => [...log.matchAll(/window frame=(\d+) now-ms=([\d.]+)((?: canvas=\d+:\d+@\d+x\d+)+)/g)].map((match) => ({
    frame: Number(match[1]), time: Number(match[2]),
    canvases: [...match[3].matchAll(/canvas=(\d+):(\d+)@(\d+)x(\d+)/g)].map((canvas) => ({
        id: Number(canvas[1]), sequence: Number(canvas[2]), width: Number(canvas[3]), height: Number(canvas[4]),
    })).sort((left, right) => left.id - right.id),
}));

export function check(context) {
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const frames = samples(phase.log);
            assert(frames.length > 100 && frames.every((frame) => frame.canvases.length === 2), `${where}: missing two-canvas progress`);
            const blocked = frames.filter((frame) => frame.frame >= 80 && frame.frame <= 180);
            const mainDelta = blocked.at(-1).canvases[0].sequence - blocked[0].canvases[0].sequence;
            const workerDelta = blocked.at(-1).canvases[1].sequence - blocked[0].canvases[1].sequence;
            assert(mainDelta <= 8 && workerDelta >= 50, `${where}: the block did not isolate the main realm: ${mainDelta}/${workerDelta}`);
            const png = loadPng(phase.image);
            let left = png.width;
            let right = -1;
            for (let x = 0; x < png.width; ++x) {
                const pixel = (35 * png.width + x) * 4;
                const r = png.data[pixel], g = png.data[pixel + 1], b = png.data[pixel + 2];
                if (r > 90 && r > g * 1.4 && r > b * 1.4) { left = Math.min(left, x); right = x + 1; }
            }
            const center = (left + right) / 2;
            assert(Math.abs(center - png.width / 2) <= 1, `${where}: the button is off centre: ${center}`);
            if (phase.id === "blocked") {
                assert(right - left > 270, `${where}: the block label did not expand`);
            } else {
                assert(right - left < 220, `${where}: the unblock did not restore the short label`);
                const late = frames.filter((frame) => frame.frame >= 500);
                assert(late.at(-1).canvases[0].sequence - late[0].canvases[0].sequence > 80, `${where}: the main realm did not resume`);
                assert(late.every((frame) => frame.canvases.every((canvas) => canvas.width === 700 && canvas.height === 279)), `${where}: the responsive resize did not reach both engines`);
            }
            details[where] = { mainFramesWhileBlocked: mainDelta, workerFramesWhileBlocked: workerDelta, buttonCenter: center, viewport: [png.width, png.height] };
            context.log(`${where}: main ${mainDelta} / worker ${workerDelta} frames while blocked, button centre ${center}`);
        }
    }
    return { details };
}
