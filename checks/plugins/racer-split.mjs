// Both source canvases must present populated views following different ships.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, parse } from "node:path";
import { loadPng, windowSamples } from "./support.mjs";

/**
 * @import { PNG } from "pngjs"
 * @import { PluginContext, PluginOutcome } from "../../dist/src/tooling/check-run.js"
 */

const HUD_ROWS = 80;
const HINT_ROWS = 60;
const DIVIDER = 4;
// The editor HUD starts at x=993 at the declared 1280x720 viewport.
const EDITOR_SCENE_WIDTH = 980;

/**
 * @typedef {PluginContext["results"][string][string]} PhaseResult
 * @typedef {{ selection: number, drag: number, nudge: number, reset: number, restored: number, firstSequence: number, lastSequence: number }} EditorDetails
 */

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
 * Compare only the scene, never the changing DOM label or button highlights.
 * @param {PNG} first
 * @param {PNG} second
 */
function editorDifference(first, second) {
    for (const image of [first, second])
        assert.deepEqual([image.width, image.height], [1280, 720]);
    let sum = 0;
    for (let y = 0; y < first.height; y++)
        for (let x = 0; x < EDITOR_SCENE_WIDTH; x++) {
            const offset = (y * first.width + x) * 4;
            for (let lane = 0; lane < 3; lane++)
                sum += Math.abs(
                    first.data.readUInt8(offset + lane) -
                        second.data.readUInt8(offset + lane),
                );
        }
    return sum / (EDITOR_SCENE_WIDTH * first.height * 3);
}

/**
 * @param {PluginContext} context
 * @param {PhaseResult} phase
 * @returns {EditorDetails}
 */
function checkEditor(context, phase) {
    const where = `${phase.backend}/${phase.id}`;
    const declared = context.spec.phases.find((entry) => entry.id === phase.id);
    const frames =
        declared?.env?.BBLITE_SCREENSHOT_FRAMES?.split(",").map(Number);
    assert(
        frames?.length === 4,
        `${where}: editor/pick/drag/nudge checkpoints required`,
    );
    const [editorFrame, pickedFrame, dragFrame, nudgeFrame] = frames;
    assert(
        editorFrame !== undefined &&
            pickedFrame !== undefined &&
            dragFrame !== undefined &&
            nudgeFrame !== undefined &&
            frames.every(Number.isInteger) &&
            editorFrame >= 0 &&
            editorFrame < pickedFrame &&
            pickedFrame < dragFrame &&
            dragFrame < nudgeFrame &&
            nudgeFrame < phase.frame,
        `${where}: ordered checkpoints must precede reset`,
    );
    const samples = windowSamples(phase.log);
    if (phase.id === "editor-after-all-modes")
        assert(
            samples.some((sample) => sample.canvases.length === 2),
            `${where}: lifecycle never presented split-screen`,
        );
    const editorSamples = samples.filter(
        (sample) => sample.frame >= editorFrame,
    );
    assert(editorSamples.length >= 3, `${where}: missing editor frame samples`);
    let previous;
    for (const sample of editorSamples) {
        assert.equal(
            sample.canvases.length,
            1,
            `${where}: editor must own one canvas`,
        );
        const canvas = sample.canvases[0];
        assert(canvas);
        assert.deepEqual(
            canvas.rectangle,
            [0, 0, 1280, 720],
            `${where}: full editor canvas`,
        );
        if (previous) {
            assert.equal(
                canvas.id,
                previous.id,
                `${where}: editor canvas identity changed`,
            );
            assert(
                canvas.sequence > previous.sequence,
                `${where}: editor canvas stopped advancing at window frame ${sample.frame} (serial ${canvas.sequence})`,
            );
        }
        previous = canvas;
    }
    assert.match(
        phase.log,
        /camera frame=\d+ kind=arc-rotate\b/,
        `${where}: editor orbit camera never rendered`,
    );
    const imagePath = parse(phase.image);
    const images = frames.map((frame) => {
        const path = join(
            imagePath.dir,
            `${imagePath.name}.frame-${frame}.png`,
        );
        assert.equal(
            readFileSync(`${path}.build-stamp`, "utf8").trim(),
            phase.buildStamp,
            `${where}: checkpoint ${frame} belongs to a different build`,
        );
        return loadPng(path);
    });
    const [editor, picked, dragged, nudged] = images;
    assert(editor && picked && dragged && nudged);
    const reset = loadPng(phase.image);
    const differences = {
        selection: editorDifference(editor, picked),
        drag: editorDifference(picked, dragged),
        nudge: editorDifference(dragged, nudged),
        reset: editorDifference(nudged, reset),
        restored: editorDifference(picked, reset),
    };
    // Passing control: selection MAD 0.19, drag 5.43, nudge 1.53,
    // reset 5.66, restored 0.002. Frozen/HUD-only changes have scene MAD 0.
    assert(
        differences.selection > 0.05,
        `${where}: picking did not change scene selection`,
    );
    /** @type {Array<"drag" | "nudge" | "reset">} */
    const actions = ["drag", "nudge", "reset"];
    for (const action of actions) {
        const difference = differences[action];
        assert(
            difference > 0.1,
            `${where}: ${action} did not change track geometry (MAD ${difference})`,
        );
    }
    assert(
        differences.restored < 0.05,
        `${where}: reset did not restore the picked scene (MAD ${differences.restored})`,
    );
    const first = editorSamples[0]?.canvases[0];
    assert(first && previous);
    return {
        ...differences,
        firstSequence: first.sequence,
        lastSequence: previous.sequence,
    };
}

/**
 * @param {PluginContext} context
 * @returns {PluginOutcome}
 */
export function check(context) {
    /** @type {Record<string, { leftLitShare: number, rightLitShare: number, halvesDifference: number } | EditorDetails>} */
    const details = {};
    for (const backend of context.backends) {
        // runCheck supplies only selected phases for --phase.
        assert(
            Object.keys(context.results[backend] ?? {}).length > 0,
            `${backend}: missing phases`,
        );
        for (const id of ["split", "split-reentered"]) {
            const phase = context.results[backend]?.[id];
            if (!phase) continue;
            const where = `${backend}/${id}`;
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
        if (editor) {
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
        for (const id of [
            "editor-after-all-modes",
            "editor-after-attract-escape",
        ]) {
            const phase = context.results[backend]?.[id];
            if (phase)
                details[`${backend}/${id}`] = checkEditor(context, phase);
        }
    }
    return { details };
}
