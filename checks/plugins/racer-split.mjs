// Antigravity racer, split-screen: the second player's canvas is created at
// run time and appended to host chrome the retained UI does not project, so
// it never has a layout rectangle. Both panes must still present: each half
// of the image between the HUD row and the hint bar holds a substantial
// number of lit pixels against the black clear colour, and the two halves
// differ because they follow different ships.
import assert from "node:assert/strict";
import { loadPng } from "./support.mjs";

const HUD_ROWS = 80;
const HINT_ROWS = 60;
const DIVIDER = 4;

function paneStatistics(png, right) {
    const start = right ? Math.ceil(png.width / 2) + DIVIDER : 0;
    const end = right ? png.width : Math.floor(png.width / 2) - DIVIDER;
    const top = HUD_ROWS;
    const bottom = png.height - HINT_ROWS;
    let lit = 0;
    let total = 0;
    for (let y = top; y < bottom; y++) for (let x = start; x < end; x++) {
        const offset = (y * png.width + x) * 4;
        ++total;
        if ([0, 1, 2].some((lane) => png.data[offset + lane] > 30)) ++lit;
    }
    return { lit, total, share: lit / total };
}

function halvesDifference(png) {
    const half = Math.floor(png.width / 2) - DIVIDER;
    let sum = 0;
    let count = 0;
    for (let y = HUD_ROWS; y < png.height - HINT_ROWS; y++) for (let x = 0; x < half; x++) {
        const left = (y * png.width + x) * 4;
        const right = (y * png.width + x + Math.ceil(png.width / 2) + DIVIDER) * 4;
        for (let lane = 0; lane < 3; lane++) sum += Math.abs(png.data[left + lane] - png.data[right + lane]);
        count += 3;
    }
    return sum / count;
}

export function check(context) {
    const details = {};
    for (const backend of context.backends) {
        const phase = context.results[backend].split;
        const where = `${backend}/split`;
        const png = loadPng(phase.image);
        const left = paneStatistics(png, false);
        const right = paneStatistics(png, true);
        assert(left.share > 0.5, `${where}: the left pane presents nothing (${left.lit} of ${left.total} pixels lit)`);
        assert(right.share > 0.5, `${where}: the right pane presents nothing (${right.lit} of ${right.total} pixels lit)`);
        const difference = halvesDifference(png);
        assert(difference > 1, `${where}: both panes show the same image (mean difference ${difference.toFixed(3)})`);
        details[where] = { leftLitShare: +left.share.toFixed(3), rightLitShare: +right.share.toFixed(3), halvesDifference: +difference.toFixed(3) };
    }
    return details;
}
