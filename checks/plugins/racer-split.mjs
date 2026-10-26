// Both source canvases must present populated views following different ships.
import assert from "node:assert/strict";
import { loadPng, windowSamples } from "./support.mjs";

/**
 * @import { PNG } from "pngjs"
 * @import { PluginContext, PluginOutcome } from "../../dist/src/tooling/check-run.js"
 */

const HUD_ROWS = 80;
const HINT_ROWS = 60;
const DIVIDER = 4;

/** @param {string} log */
function canvasViews(log) {
    const sample = windowSamples(log).at(-1);
    assert(sample, "missing Window canvas trace");
    return sample.canvases
        .map((canvas) => {
            assert(canvas.rectangle, "missing canvas layout rectangle");
            return {
                backing: [canvas.width, canvas.height],
                rectangle: canvas.rectangle,
            };
        })
        .sort((a, b) => Number(a.rectangle[0]) - Number(b.rectangle[0]));
}

/**
 * @param {PNG} png
 * @param {boolean} right
 */
function paneStatistics(png, right) {
    const start = right ? Math.ceil(png.width / 2) + DIVIDER : 0;
    const end = right ? png.width : Math.floor(png.width / 2) - DIVIDER;
    const top = HUD_ROWS;
    const bottom = png.height - HINT_ROWS;
    let lit = 0;
    let total = 0;
    for (let y = top; y < bottom; y++)
        for (let x = start; x < end; x++) {
            const offset = (y * png.width + x) * 4;
            ++total;
            if (
                [0, 1, 2].some((lane) => png.data.readUInt8(offset + lane) > 30)
            )
                ++lit;
        }
    return { lit, total, share: lit / total };
}

/** @param {PNG} png */
function halvesDifference(png) {
    const half = Math.floor(png.width / 2) - DIVIDER;
    let sum = 0;
    let count = 0;
    for (let y = HUD_ROWS; y < png.height - HINT_ROWS; y++)
        for (let x = 0; x < half; x++) {
            const left = (y * png.width + x) * 4;
            const right =
                (y * png.width + x + Math.ceil(png.width / 2) + DIVIDER) * 4;
            for (let lane = 0; lane < 3; lane++)
                sum += Math.abs(
                    png.data.readUInt8(left + lane) -
                        png.data.readUInt8(right + lane),
                );
            count += 3;
        }
    return sum / count;
}

/**
 * @param {PluginContext} context
 * @returns {PluginOutcome}
 */
export function check(context) {
    /** @type {Record<string, { leftLitShare: number, rightLitShare: number, halvesDifference: number }>} */
    const details = {};
    for (const backend of context.backends) {
        for (const id of ["split", "split-reentered"]) {
            const phase = context.results[backend]?.[id];
            const where = `${backend}/${id}`;
            assert(phase, `${where}: missing phase`);
            const png = loadPng(phase.image);
            const half = png.width / 2;
            assert.deepEqual(
                canvasViews(phase.log),
                [
                    {
                        backing: [half, png.height],
                        rectangle: [0, 0, half, png.height],
                    },
                    {
                        backing: [half, png.height],
                        rectangle: [half, 0, half, png.height],
                    },
                ],
                `${where}: each player must own one half-width canvas`,
            );
            const left = paneStatistics(png, false);
            const right = paneStatistics(png, true);
            assert(
                left.share > 0.5,
                `${where}: the left pane presents nothing (${left.lit} of ${left.total} pixels lit)`,
            );
            assert(
                right.share > 0.5,
                `${where}: the right pane presents nothing (${right.lit} of ${right.total} pixels lit)`,
            );
            const difference = halvesDifference(png);
            assert(
                difference > 1,
                `${where}: both panes show the same image (mean difference ${difference.toFixed(3)})`,
            );
            details[where] = {
                leftLitShare: +left.share.toFixed(3),
                rightLitShare: +right.share.toFixed(3),
                halvesDifference: +difference.toFixed(3),
            };
        }
        const editor = context.results[backend]?.["editor-after-split"];
        assert(editor, `${backend}: missing editor-after-split phase`);
        const png = loadPng(editor.image);
        assert.deepEqual(
            canvasViews(editor.log),
            [
                {
                    backing: [png.width, png.height],
                    rectangle: [0, 0, png.width, png.height],
                },
            ],
            `${backend}/editor-after-split: the editor must reclaim the full canvas`,
        );
    }
    return { details };
}
