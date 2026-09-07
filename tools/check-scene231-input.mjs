#!/usr/bin/env node
// Original-scene animation and camera controls through SDL's frame input tape.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const executable = resolve(process.argv[2] ?? "native/build-scene231-release/bblite_native.exe");
const output = resolve("artifacts/scene231-input");
mkdirSync(output, { recursive: true });
const idle = (count) => Array(count).fill("-");
const phases = [
    { name: "animating", frame: 14, replay: [] },
    { name: "frozen", frame: 70, replay: [] },
    { name: "orbit", frame: 70, replay: [...idle(35), "+UiMouseLeft@640:360", ...Array.from({ length: 12 }, (_, i) => `UiMove@${650 + i * 10}:360`), "-UiMouseLeft@760:360"] },
];
const mad = (first, second) => {
    const a = PNG.sync.read(readFileSync(first));
    const b = PNG.sync.read(readFileSync(second));
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let sum = 0;
    for (let i = 0; i < a.data.length; ++i) if (i % 4 !== 3) sum += Math.abs(a.data[i] - b.data[i]);
    return sum / (a.width * a.height * 3);
};
const results = [];
for (const backend of ["sdl_gpu", "dawn"]) {
    const captures = new Map();
    for (const phase of phases) {
        const stem = resolve(output, `${backend}-${phase.name}`);
        const run = spawnSync(executable, [], {
            cwd: resolve("generated/scene231"), timeout: 20000, encoding: "utf8",
            // Camera controls are intentionally disabled in hidden test passes.
            env: { ...process.env, BBLITE_GPU_BACKEND: backend, BBLITE_TEST_PASS: "0",
                BBLITE_MAX_FRAMES: String(phase.frame + 1), BBLITE_SCREENSHOT_FRAME: String(phase.frame),
                BBLITE_SCREENSHOT: stem + ".png", BBLITE_RENDER_CAPTURE: stem + ".json",
                BBLITE_FRAME_DELTA_MS: "16", BBLITE_ANIMATION_SEEK_SECONDS: "",
                BBLITE_INPUT_REPLAY: phase.replay.join(","), BBLITE_RUNTIME_TRACE: "1",
                BBLITE_GPU_DEBUG: "1", SDL_ASSERT: "always_ignore" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const captured = (run.stdout ?? "") + (run.stderr ?? "");
        writeFileSync(stem + ".log", captured);
        assert.equal(run.status, 0, run.error?.message ?? captured);
        assert(!/validation error|gpu error|exception/i.test(captured), captured);
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
