#!/usr/bin/env node
// Original-scene animation and camera controls through SDL's frame input tape.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareImages, imageDimensions } from "../dist/src/parity.js";
import { resolveNativeExecutable, spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from "../dist/src/parity-scene.js";
import { getScene } from "../dist/src/scene-registry.js";

const scene = getScene("scene231");
const executable = resolveNativeExecutable(process.argv[2], scene.buildDirectory);
const generated = resolve(scene.output);
verifyDeployedPayload(executable, generated);
const output = resolve("artifacts/scene231-input");
mkdirSync(output, { recursive: true });
const idle = (count) => Array(count).fill("-");
const phases = [
    { name: "animating", frame: 14, replay: [] },
    { name: "frozen", frame: 70, replay: [] },
    { name: "orbit", frame: 70, replay: [...idle(35), "+UiMouseLeft@640:360", ...Array.from({ length: 12 }, (_, i) => `UiMove@${650 + i * 10}:360`), "-UiMouseLeft@760:360"] },
];
const mad = (first, second) => {
    assert.deepEqual(imageDimensions(first), imageDimensions(second));
    return compareImages(first, second).mad;
};
const results = [];
for (const backend of ["sdl_gpu", "dawn"]) {
    const captures = new Map();
    for (const phase of phases) {
        const stem = resolve(output, `${backend}-${phase.name}`);
        const stamp = stem + ".build-stamp";
        for (const path of [stamp, stem + ".png", stem + ".json"]) rmSync(path, { force: true });
        // Camera controls are intentionally disabled in hidden test passes.
        const captured = spawnNativeMeasured(executable, {
                BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "0",
                BBLITE_MAX_FRAMES: String(phase.frame + 1), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
                BBLITE_SCREENSHOT: stem + ".png", BBLITE_RENDER_CAPTURE: stem + ".json",
                BBLITE_BUILD_STAMP_OUT: stamp,
                BBLITE_FRAME_DELTA_MS: "16", BBLITE_ANIMATION_SEEK_SECONDS: "",
                BBLITE_INPUT_REPLAY: phase.replay.join(","), BBLITE_RUNTIME_TRACE: "1",
                BBLITE_GPU_DEBUG: "1", SDL_ASSERT: "always_ignore",
        }, [], true, 20000);
        writeFileSync(stem + ".log", captured);
        assert(!/validation error|gpu error|exception/i.test(captured), captured);
        verifyBuildIdentity(executable, generated, stamp);
        const capture = JSON.parse(readFileSync(stem + ".json", "utf8"));
        assert.equal(capture.meshes.length, 1);
        assert.equal(capture.meshes[0].boneMatrixCount, 2);
        assert.equal(capture.draws.length, 1);
        assert.equal(capture.draws[0].stage, "transparent");
        captures.set(phase.name, { ...capture, image: stem + ".png" });
    }
    const early = captures.get("animating");
    const frozen = captures.get("frozen");
    const orbit = captures.get("orbit");
    assert.deepEqual(early.camera, frozen.camera, "Animation moved the camera");
    const animationMad = mad(early.image, frozen.image);
    assert(animationMad > 0.05, `Palette updates did not change rendered geometry: ${animationMad}`);
    assert(Math.abs(orbit.camera.alpha - frozen.camera.alpha) > 0.1, "Orbit replay did not turn the camera");
    assert(mad(orbit.image, frozen.image) > 0.05, "Orbit did not change the rendered image");
    results.push({ backend, buildStamp: frozen.buildStamp, animationMad,
        initialAlpha: frozen.camera.alpha, orbitAlpha: orbit.camera.alpha });
}
writeFileSync(resolve(output, "verification.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
