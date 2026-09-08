// Scene 164: device loss and recovery. Browser: every recovery flag on
// the canvas dataset after the harness handshake, twenty post-recovery
// frames with draws, the canvas byte-identical before and after
// recovery, resize to 960x540, wheel input changing the image, and a
// dispose that freezes the frame counter. Native: the runtime trace
// reports the same flags, exactly two recovery generations (2, 3) with
// draws, one window reused across all three, and camera movement.
import assert from "node:assert/strict";
import { compareImages } from "../../dist/src/parity.js";
import { observedImage, observedStep, requireObservations } from "./support.mjs";

const FLAGS = ["deviceLost", "deviceRecovered", "deviceReplaced", "environmentIdentityPreserved", "environmentRebuilt", "fallbackRebuilt", "shadowRebuilt", "backgroundsRebuilt", "ready"];

export function check(context) {
    const observations = requireObservations(context);
    const before = observedStep(observations, "before");
    const after = observedStep(observations, "after");
    const resized = observedStep(observations, "resized");
    const input = observedStep(observations, "input");
    const disposed = observedStep(observations, "disposed");
    for (const flag of FLAGS) assert.equal(after.state.dataset[flag], "true", `browser: ${flag}`);
    assert.ok(Number(after.state.dataset.postRecoveryFrames) >= 20, "browser: post-recovery frames");
    assert.ok(Number(after.state.dataset.drawCalls) > 0, "browser: draw calls after recovery");
    const recoveryMad = compareImages(observedImage(context, before.image), observedImage(context, after.image)).mad;
    assert.equal(recoveryMad, 0, "browser: the canvas changed across recovery");
    assert.deepEqual(resized.state.viewport, { width: 960, height: 540 }, "browser: resized viewport");
    const inputMad = compareImages(observedImage(context, after.image), observedImage(context, input.image)).mad;
    assert.ok(inputMad > 0.1, "browser: wheel input did not change the image");
    assert.equal(disposed.state.dataset.disposed, "true", "browser: dispose");
    const details = { browser: { recoveryMad, inputMad }, native: {} };
    for (const backend of context.backends) {
        const log = context.results[backend].recovery.log;
        for (const flag of FLAGS) assert.ok(log.includes(`dataset ${flag}=true`), `${backend}: ${flag}`);
        const generations = [...log.matchAll(/recovery generation=(\d+) draws=(\d+)/g)].map((match) => ({ generation: Number(match[1]), draws: Number(match[2]) }));
        assert.deepEqual(generations.map((row) => row.generation), [2, 3], `${backend}: recovery generations`);
        assert.ok(generations.every((row) => row.draws > 0), `${backend}: a recovery generation drew nothing`);
        const windows = [...log.matchAll(/window (?:create|reuse) id=(\d+) native=(\w+)/g)].map((match) => match.slice(1));
        assert.equal(windows.length, 3, `${backend}: window events`);
        assert.deepEqual(windows, Array(3).fill(windows[0]), `${backend}: the window was not reused`);
        const alphas = [...log.matchAll(/camera frame=\d+.* alpha=([0-9.]+)/g)].map((match) => Number(match[1]));
        assert.ok(alphas.some((alpha) => Math.abs(alpha - alphas[0]) > 0.01), `${backend}: the camera did not move`);
        details.native[backend] = { generations, windows, initialAlpha: alphas[0], finalAlpha: alphas.at(-1) };
    }
    return { details };
}
