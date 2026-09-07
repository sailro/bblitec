#!/usr/bin/env node
// KHR_interactivity through SDL's frame input tape, for the two scenes that
// run the Khronos Calculator asset: the demo (`calculator`, auto-rotating,
// taps at its frame-180 golden pose) and scene 304 (static camera). Tapping
// the keys runs the asset's flow graph (event/onSelect -> variable/set ->
// pointer/set on the digit materials' KHR_texture_transform offset). The
// asset is a toy: a digit key stores itself and an operator key folds the
// stored number (+1, -1, x2, floor(/2)) through clamp(-99, 99), so "7" then
// "x" reads 07 then 14: the first tap scrolls the ones digit and leaves the
// tens digit, the second scrolls both, and nothing outside the display
// moves. The control is a press without a release at the same frame: the
// demo pauses auto-rotate on pointerdown, so the control shares the taps'
// pose, and the pinned pointer bridge only picks on pointerup. Under
// BBLITE_RUNTIME_TRACE the generated bridge names the node it dispatched,
// asserted here by the asset's own node names.
//
// Usage: node tools/check-calculator-input.mjs [calculator|scene304] [executable]
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { parseGlbJson } from "../dist/src/gltf-document.js";
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from "../dist/src/parity-scene.js";
import { getScene } from "../dist/src/scene-registry.js";

// Client-pixel positions of the "7" and "x" keys and of the display's two
// digit cells at each scene's golden pose, read off its golden.
const SCENES = {
    calculator: {
        seven: "516:343",
        times: "706:340",
        tens: { x: 745, y: 245, width: 55, height: 75 },
        ones: { x: 800, y: 245, width: 55, height: 75 },
    },
    scene304: {
        seven: "500:378",
        times: "683:325",
        tens: { x: 692, y: 228, width: 40, height: 46 },
        ones: { x: 732, y: 228, width: 42, height: 46 },
    },
};
const argumentList = process.argv.slice(2);
const sceneId = Object.hasOwn(SCENES, argumentList[0]) ? argumentList.shift() : "calculator";
const [executableOverride] = argumentList;
const layout = SCENES[sceneId];
const scene = getScene(sceneId);
// The taps land on the scene's golden pose: the registry's reference frame
// where the demo's auto-rotate defines one, and a short settle for a static
// camera, whose graph attached at add and started on the first tick.
const settle = scene.parity.referenceFrame ?? 30;
const executable = resolveNativeExecutable(executableOverride, scene.buildDirectory);
const generated = resolve(scene.output);
verifyDeployedPayload(executable, generated);
const output = resolve(`artifacts/${sceneId}-input`);
mkdirSync(output, { recursive: true });
const idle = (count) => Array(count).fill("-");
// The keys' glTF nodes, by the names the asset gives them: the bridge's
// trace names the node it dispatched, so a moved pose fails by name and
// not only by an unchanged digit. The nodes come from the packaged glTF
// the executable loads, named by the generated manifest.
const manifest = JSON.parse(readFileSync(resolve(generated, "manifest.json"), "utf8"));
const packaged = manifest.assets.filter((asset) => asset.kind === "gltf");
assert.equal(packaged.length, 1, `${sceneId} packages ${packaged.length} glTF assets`);
const document = parseGlbJson(resolve(generated, "assets", packaged[0].output));
const nodeNamed = (name) => {
    const index = document.nodes.findIndex((node) => node.name === name);
    assert(index >= 0, `The asset has no node named ${name}`);
    return index;
};
const sevenNode = nodeNamed("Button 7");
const timesNode = nodeNamed("Button multiply");
const tap = (key) => [`+UiMouseLeft@${key}`, `-UiMouseLeft@${key}`];
const frame = settle + 10;
const phases = [
    { name: "press", replay: [...idle(settle), `+UiMouseLeft@${layout.seven}`], dispatches: [] },
    { name: "seven", replay: [...idle(settle), ...tap(layout.seven)], dispatches: [sevenNode] },
    { name: "seven-times", replay: [...idle(settle), ...tap(layout.seven), ...idle(3), ...tap(layout.times)], dispatches: [sevenNode, timesNode] },
];
const loadPng = (path) => PNG.sync.read(readFileSync(path));
const inside = (rect, x, y) =>
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
// Mean absolute channel difference inside each digit cell and over the rest.
const digitMad = (firstPath, secondPath) => {
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
    return {
        tens: sums.tens / counts.tens,
        ones: sums.ones / counts.ones,
        rest: sums.rest / counts.rest,
    };
};
const results = [];
for (const backend of ["sdl_gpu", "dawn"]) {
    const images = new Map();
    let buildStamp;
    for (const phase of phases) {
        const stem = resolve(output, `${backend}-${phase.name}`);
        const stamp = stem + ".build-stamp";
        for (const path of [stamp, stem + ".png"]) rmSync(path, { force: true });
        // Pointer callbacks are only attached outside hidden test passes.
        const captured = spawnNativeMeasured(executable, {
            // The registry's own capture environment (its fixed clock and
            // reference frame) first, so the tape's settle frame is the
            // golden's pose; then this check's own frame window over it,
            // since the screenshot has to follow the release.
            ...scene.parity.nativeEnvironment,
            BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "0",
            BBLITE_MAX_FRAMES: String(frame + 1), BBLITE_SCREENSHOT_FRAME: String(frame),
            BBLITE_SCREENSHOT: stem + ".png", BBLITE_BUILD_STAMP_OUT: stamp,
            BBLITE_ANIMATION_SEEK_SECONDS: "",
            BBLITE_INPUT_REPLAY: phase.replay.join(","), BBLITE_RUNTIME_TRACE: "1",
            BBLITE_GPU_DEBUG: "1", SDL_ASSERT: "always_ignore",
        }, [], true, 30000);
        writeFileSync(stem + ".log", captured);
        assert(!/validation error|gpu error|exception/i.test(captured), captured);
        // The container's runtime list, as attach filled it: one runtime for
        // the asset's one graph.
        assert.match(captured, /flow-graph attach asset=\S+ runtimes=1\b/, `${backend} ${phase.name}: no attach with one runtime`);
        const dispatched = [...captured.matchAll(/flow-graph pointer node=(\d+)/g)].map((match) => Number(match[1]));
        assert.deepEqual(dispatched, phase.dispatches, `${backend} ${phase.name}: the bridge dispatched nodes ${JSON.stringify(dispatched)}`);
        verifyBuildIdentity(executable, generated, stamp);
        buildStamp = readFileSync(stamp, "utf8").trim();
        images.set(phase.name, stem + ".png");
    }
    const firstTap = digitMad(images.get("press"), images.get("seven"));
    const secondTap = digitMad(images.get("seven"), images.get("seven-times"));
    // 00 -> 07: the ones digit scrolls, the tens digit and the scene hold.
    assert(firstTap.ones > 2, `Tapping 7 did not move the ones digit: ${JSON.stringify(firstTap)}`);
    assert(firstTap.tens < 0.05, `Tapping 7 moved the tens digit: ${JSON.stringify(firstTap)}`);
    assert.equal(firstTap.rest, 0, `Tapping 7 changed pixels outside the display: ${JSON.stringify(firstTap)}`);
    // 07 -> 14: both digits scroll, the scene holds.
    assert(secondTap.tens > 2, `Tapping x did not move the tens digit: ${JSON.stringify(secondTap)}`);
    assert(secondTap.ones > 2, `Tapping x did not move the ones digit: ${JSON.stringify(secondTap)}`);
    assert.equal(secondTap.rest, 0, `Tapping x changed pixels outside the display: ${JSON.stringify(secondTap)}`);
    results.push({ scene: sceneId, backend, buildStamp, firstTap, secondTap });
}
writeFileSync(resolve(output, "verification.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
