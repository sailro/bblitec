// Scenes 227 and 228: pane isolation over the two canvases of one engine.
// Each pane is the half of the image beside the 8-px divider below the
// 40-px header row; a pane's difference from the baseline is its mean
// absolute channel difference. A left drag must change only the left
// pane (more than 1), a right drag only the right, the crossing drag
// only the left, and idle neither. After a resize each pane must still
// hold more than a thousand geometry pixels against its own clear colour.
import assert from "node:assert/strict";
import { loadPng } from "./support.mjs";

function paneDifference(actual, expected, right) {
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    const start = right ? Math.ceil(actual.width / 2) + 4 : 0;
    const end = right ? actual.width : Math.floor(actual.width / 2) - 4;
    let total = 0;
    for (let y = 40; y < actual.height; y++) for (let x = start; x < end; x++)
        for (let lane = 0; lane < 3; lane++) {
            const offset = (y * actual.width + x) * 4 + lane;
            total += Math.abs(actual.data[offset] - expected.data[offset]);
        }
    return total / ((end - start) * (actual.height - 40) * 3);
}

export function check(context) {
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        const baseline = loadPng(results.baseline.image);
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const png = loadPng(phase.image);
            if (phase.id === "resize") {
                assert.deepEqual([png.width, png.height], [1000, 600], `${where}: the window did not resize`);
                // Count geometry against each canvas's own clear colour; a
                // coloured clear alone must fail.
                for (const right of [false, true]) {
                    const start = right ? Math.ceil(png.width / 2) + 4 : 0;
                    const end = right ? png.width : Math.floor(png.width / 2) - 4;
                    const background = (40 * png.width + start) * 4;
                    let geometryPixels = 0;
                    for (let y = 40; y < png.height; y++) for (let x = start; x < end; x++) {
                        const offset = (y * png.width + x) * 4;
                        if ([0, 1, 2].some((lane) => Math.abs(png.data[offset + lane] - png.data[background + lane]) > 30)) ++geometryPixels;
                    }
                    assert(geometryPixels > 1000, `${where}: the resized ${right ? "right" : "left"} canvas lost its geometry`);
                }
                details[where] = { dimensions: [png.width, png.height] };
                continue;
            }
            const left = paneDifference(png, baseline, false);
            const right = paneDifference(png, baseline, true);
            if (phase.id === "idle") assert(left === 0 && right === 0, `${where}: idle canvases changed`);
            if (phase.id === "left" || phase.id === "crossing") {
                assert(left > 1, `${where}: left camera input did not change its canvas`);
                assert.equal(right, 0, `${where}: the left drag changed the right camera`);
            }
            if (phase.id === "right") {
                assert(right > 1, `${where}: right camera input did not change its canvas`);
                assert.equal(left, 0, `${where}: the right drag changed the left camera`);
            }
            details[where] = { left, right };
        }
    }
    return { details };
}
