// KHR_interactivity through SDL's frame input tape, for the two scenes
// that run the Khronos Calculator asset (the demo, auto-rotating, tapping
// at its frame-180 golden pose; scene 304, static camera). Tapping the
// keys runs the asset's flow graph (event/onSelect -> variable/set ->
// pointer/set on the digit materials' KHR_texture_transform offset). The
// asset is a toy: a digit key stores itself and an operator key folds the
// stored number (+1, -1, x2, floor(/2)) through clamp(-99, 99), so "7"
// then "x" reads 07 then 14: the first tap scrolls the ones digit and
// leaves the tens digit, the second scrolls both, and nothing outside
// the display moves. Under BBLITE_RUNTIME_TRACE the generated bridge
// names the node it dispatched, asserted here by the asset's own node
// names.
//
// options: { layout: { tens: {x,y,width,height}, ones: {...} },
//            dispatches: { <phase>: ["Button 7", ...] } }
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseGlbJson } from "../../dist/src/gltf-document.js";
import { loadPng, readManifest } from "./support.mjs";

const inside = (rect, x, y) =>
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

/** Mean absolute channel difference inside each digit cell and over the rest. */
function digitMad(firstPath, secondPath, layout) {
    const first = loadPng(firstPath);
    const second = loadPng(secondPath);
    assert.deepEqual([first.width, first.height], [second.width, second.height]);
    const sums = { tens: 0, ones: 0, rest: 0 };
    const counts = { tens: 0, ones: 0, rest: 0 };
    for (let y = 0; y < first.height; y++) {
        for (let x = 0; x < first.width; x++) {
            const offset = (y * first.width + x) * 4;
            let difference = 0;
            for (let channel = 0; channel < 3; channel++) {
                difference += Math.abs(first.data[offset + channel] - second.data[offset + channel]);
            }
            const cell = inside(layout.tens, x, y) ? "tens" : inside(layout.ones, x, y) ? "ones" : "rest";
            sums[cell] += difference;
            counts[cell] += 3;
        }
    }
    return { tens: sums.tens / counts.tens, ones: sums.ones / counts.ones, rest: sums.rest / counts.rest };
}

export function check(context) {
    const { layout, dispatches } = context.options;
    // The keys' glTF nodes, by the names the asset gives them, from the
    // packaged glTF the executable loads.
    const manifest = readManifest(context);
    const packaged = manifest.assets.filter((asset) => asset.kind === "gltf");
    assert.equal(packaged.length, 1, `${context.scene.id} packages ${packaged.length} glTF assets`);
    const document = parseGlbJson(resolve(context.target.output, "assets", packaged[0].output));
    const nodeNamed = (name) => {
        const index = document.nodes.findIndex((node) => node.name === name);
        assert(index >= 0, `The asset has no node named ${name}`);
        return index;
    };
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        for (const [phaseId, names] of Object.entries(dispatches)) {
            const phase = results[phaseId];
            assert(phase, `${backend}: phase ${phaseId} did not run`);
            const dispatched = [...phase.log.matchAll(/flow-graph pointer node=(\d+)/g)].map((match) => Number(match[1]));
            assert.deepEqual(dispatched, names.map(nodeNamed), `${backend} ${phaseId}: the bridge dispatched nodes ${JSON.stringify(dispatched)}`);
        }
        const firstTap = digitMad(results.press.image, results.seven.image, layout);
        const secondTap = digitMad(results.seven.image, results["seven-times"].image, layout);
        // 00 -> 07: the ones digit scrolls, the tens digit and the scene hold.
        assert(firstTap.ones > 2, `${backend}: tapping 7 did not move the ones digit: ${JSON.stringify(firstTap)}`);
        assert(firstTap.tens < 0.05, `${backend}: tapping 7 moved the tens digit: ${JSON.stringify(firstTap)}`);
        assert.equal(firstTap.rest, 0, `${backend}: tapping 7 changed pixels outside the display: ${JSON.stringify(firstTap)}`);
        // 07 -> 14: both digits scroll, the scene holds.
        assert(secondTap.tens > 2, `${backend}: tapping x did not move the tens digit: ${JSON.stringify(secondTap)}`);
        assert(secondTap.ones > 2, `${backend}: tapping x did not move the ones digit: ${JSON.stringify(secondTap)}`);
        assert.equal(secondTap.rest, 0, `${backend}: tapping x changed pixels outside the display: ${JSON.stringify(secondTap)}`);
        details[backend] = { firstTap, secondTap };
        context.log(`${backend}: 7 moves ones by ${firstTap.ones.toFixed(2)}, x moves tens by ${secondTap.tens.toFixed(2)} and ones by ${secondTap.ones.toFixed(2)}`);
    }
    return { details };
}
