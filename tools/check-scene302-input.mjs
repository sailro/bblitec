#!/usr/bin/env node
// Run once against each generated mode: authored ?seekTime=2 and no query.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareImages, imageDimensions } from "../dist/src/parity.js";
import { spawnNativeMeasured, verifyBuildIdentity, verifyDeployedPayload } from "../dist/src/parity-scene.js";

const [mode, executableArgument, generatedArgument] = process.argv.slice(2);
assert(["frozen", "live"].includes(mode) && executableArgument && generatedArgument,
    "Usage: node tools/check-scene302-input.mjs frozen|live <executable> <generated-directory>");
const executable = resolve(executableArgument);
const generated = resolve(generatedArgument);
verifyDeployedPayload(executable, generated);
const output = resolve(`artifacts/scene302-input/${mode}`);
mkdirSync(output, { recursive: true });
const idle = count => Array(count).fill("-");
const frames = mode === "frozen" ? [10, 70] : [80, 120];
const phases = [
    { name: "early", frame: frames[0], replay: [] },
    { name: "later", frame: frames[1], replay: [] },
    { name: "orbit", frame: frames[1], replay: [...idle(35), "+UiMouseLeft@640:360",
        ...Array.from({ length: 12 }, (_, i) => `UiMove@${650 + i * 10}:360`), "-UiMouseLeft@760:360"] },
];
const results = [];
for (const backend of ["sdl_gpu", "dawn"]) {
    const captures = new Map();
    for (const phase of phases) {
        const stem = resolve(output, `${backend}-${phase.name}`);
        const stamp = stem + ".build-stamp";
        for (const path of [stamp, stem + ".png", stem + ".json"]) rmSync(path, { force: true });
        const log = spawnNativeMeasured(executable, {
            BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "0",
            BBLITE_MAX_FRAMES: String(phase.frame + 1), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
            BBLITE_SCREENSHOT: stem + ".png", BBLITE_RENDER_CAPTURE: stem + ".json",
            BBLITE_BUILD_STAMP_OUT: stamp, BBLITE_FRAME_DELTA_MS: String(1000 / 60),
            // Input/state replay uses one sample; parity keeps the authored MSAA.
            BBLITE_MSAA: "1",
            BBLITE_ANIMATION_SEEK_SECONDS: "", BBLITE_INPUT_REPLAY: phase.replay.join(","),
            BBLITE_RUNTIME_TRACE: "1", BBLITE_GPU_DEBUG: "1", SDL_ASSERT: "always_ignore",
        }, [], true);
        writeFileSync(stem + ".log", log);
        assert(!/validation error|gpu error|exception/i.test(log), log);
        verifyBuildIdentity(executable, generated, stamp);
        const capture = JSON.parse(readFileSync(stem + ".json", "utf8"));
        const draws = capture.draws.filter(draw => draw.pipeline === "billboard");
        assert.equal(draws.length, 1);
        assert(draws[0].instanceCount > 100, "The source did not produce a visible particle population");
        captures.set(phase.name, { ...capture, particles: draws[0].instanceCount, image: stem + ".png" });
    }
    const early = captures.get("early");
    const later = captures.get("later");
    const orbit = captures.get("orbit");
    assert.deepEqual(imageDimensions(early.image), imageDimensions(later.image));
    assert.deepEqual(early.camera, later.camera, "Particle animation moved the camera");
    const motion = compareImages(early.image, later.image);
    if (mode === "frozen") {
        assert.equal(early.particles, later.particles);
        assert.equal(motion.mad, 0, "The authored zero-speed state changed after registration");
    } else {
        assert(motion.totalPixels - motion.exactMatch > 100, "The moving emitter did not change visible pixels");
        assert(later.particles > early.particles, "The live source stopped spawning particles before its lifetime bound");
    }
    assert(Math.abs(orbit.camera.alpha - later.camera.alpha) > 0.1, "Orbit replay did not turn the camera");
    const orbitMad = compareImages(later.image, orbit.image).mad;
    assert(orbitMad > 0.01, "Orbit did not change the rendered particles");
    results.push({ backend, mode, buildStamp: later.buildStamp, earlyParticles: early.particles,
        laterParticles: later.particles, motionMad: motion.mad,
        changedPixels: motion.totalPixels - motion.exactMatch, orbitMad });
}
writeFileSync(resolve(output, "verification.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
