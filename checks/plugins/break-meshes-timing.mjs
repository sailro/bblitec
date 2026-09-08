// Break Meshes: the physics step rate. The demo steps its world one fixed
// 12.5 ms step per rendered frame (its scene clock is 1000/60 ms), so at a
// controlled frame rate the simulated seconds per step and per two
// seconds of frames are fixed, and at the live display rate the simulated
// seconds per wall second must match the browser's within 5%. The browser
// observation records the world's afterStep samples; the native run's
// `[physics] step` trace lines are its samples.
//
// options: { fps: number | null }   (null = the live display rate)
import assert from "node:assert/strict";
import { assertObservationProvenance, observedStep, requireObservations } from "./support.mjs";

function summarize(samples) {
    assert(samples.length > 30, "Insufficient physics steps");
    const seconds = samples.slice(1).reduce((sum, sample) => sum + sample.seconds, 0);
    const wallSeconds = (samples.at(-1).now - samples[0].now) / 1000;
    return { steps: samples.length - 1, seconds, wallSeconds, simulatedPerWallSecond: seconds / wallSeconds };
}

const controlledTime = (samples) => ({ steps: samples.length, seconds: samples.reduce((sum, sample) => sum + sample.seconds, 0) });

export function check(context) {
    const { fps } = context.options;
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const timing = observedStep(observations, "timing");
    const observed = timing.extras.observed;
    assert.equal(observed.sceneFixed, 1000 / 60, "Do not change the BBL reference's scene clock");
    assert.equal(observed.worldFixed, 12.5, "Do not change the BBL reference's physics clock");
    const browserSamples = fps === null ? observed.samples : observed.samples.slice(0, fps * 2 + 1);
    const browser = {
        implementation: "browser", fps,
        ...(fps === null ? summarize(browserSamples) : controlledTime(browserSamples.slice(1))),
        dynamicBodies: observed.dynamicBodies,
    };
    assert(Math.abs(browser.seconds / browser.steps - 0.0125) < 1e-8, `browser step length: ${JSON.stringify(browser)}`);
    if (fps !== null) assert(Math.abs(browser.seconds - fps * 2 * 0.0125) < 1e-5, `browser controlled time: ${JSON.stringify(browser)}`);
    const results = [browser];
    for (const backend of context.backends) {
        const phase = context.results[backend].run;
        const samples = [];
        const firstPositions = new Map();
        const lastPositions = new Map();
        const started = Date.now();
        for (const line of phase.log.split(/\r?\n/)) {
            const match = line.match(/^\[physics\] step (\d+) dt ([\d.]+) body (\d+) pos (.*)$/);
            if (!match) continue;
            const [, step, dt, body, position] = match;
            // The trace carries no wall clock; the step index stands in for it
            // at the frame rate the run was paced to.
            if (+body === 0) samples.push({ seconds: +dt, now: started + samples.length * (fps === null ? 1000 / 60 : 1000 / fps) });
            if (+step === 0) firstPositions.set(body, position);
            lastPositions.set(body, position);
        }
        assert(firstPositions.size > 100, `${backend}: missing demo physics bodies`);
        const movedBodies = [...lastPositions].filter(([body, position]) => firstPositions.get(body) !== position).length;
        assert(movedBodies >= 14, `${backend}: shatter input did not move the pieces: ${movedBodies}`);
        // The original world override also steps on frame zero; exclude that
        // priming frame when measuring the following two seconds.
        const measured = fps === null ? samples.slice(120, -20) : samples.slice(1);
        const native = { implementation: backend, fps, ...(fps === null ? summarize(measured) : controlledTime(measured)), movedBodies };
        assert(Math.abs(native.seconds / native.steps - browser.seconds / browser.steps) < 1e-8, `${backend}: step length ${JSON.stringify(native)}`);
        if (fps !== null) {
            assert.equal(measured.length, fps * 2, `${backend}: two seconds of steps`);
            assert(Math.abs(native.seconds - browser.seconds) < 1e-5, `${backend}: controlled time ${JSON.stringify({ native, browser })}`);
        }
        results.push(native);
        context.log(`${backend}: ${native.steps} steps, ${native.seconds.toFixed(4)} simulated seconds, ${movedBodies} bodies moved`);
    }
    return { details: results };
}
