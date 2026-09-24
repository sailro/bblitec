// Scene 261: the TAA task's retained state, read from the native capture's
// temporalTasks (the source task carries `clean`, the TAA task carries
// `executions`). The frozen mode compares every phase against the browser
// observation, word for word (JSON numbers normalize JavaScript -0, so the
// float32 bit patterns are compared as uint32 words); the live mode checks
// the accumulation reset and recovery the twin exhibits under input.
//
// options: { mode: "frozen" | "live" }
import assert from "node:assert/strict";
import {
    assertObservationProvenance,
    observedStep,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {{ alpha: number, beta: number, radius: number }} OrbitCamera
 * @typedef {{
 *     taskIndex: number,
 *     clean: number[],
 *     drawn: number[],
 *     cleanWords: number[],
 *     drawnWords: number[],
 *     cache: { cameraKey: number, aspect: number },
 * }} SourceTask a scene task's retained uniforms
 * @typedef {{
 *     executions: number,
 *     factor: number,
 *     lastCameraVersion: number,
 *     haltonIndex: number,
 *     haltonWords: number[],
 *     jitterScratch: number[],
 *     jitterScratchWords: number[],
 *     blendFactor?: number,
 *     sourceTasks: number[],
 * }} TaaTask the TAA task's retained state; `blendFactor` is its first pass's first parameter, when it has one
 * @typedef {{
 *     temporalTasks: Array<{ clean?: unknown, executions?: unknown }>,
 *     camera: OrbitCamera,
 * }} NativeCapture the fields read from a phase's render capture
 * @typedef {{
 *     executions: number,
 *     haltonIndex: number,
 *     factor: number,
 *     lastCameraVersion: number,
 *     cleanLength: number,
 *     cleanWords: number[],
 *     drawnWords: number[],
 *     haltonWords: number[],
 *     jitterScratchWords: number[],
 *     camera: OrbitCamera,
 * }} ObservedState the hook's `window.__observe()` record
 */

const CAMERA_KEYS = /** @type {const} */ (["alpha", "beta", "radius"]);

/**
 * @param {NativeCapture} capture
 * @param {string} where
 */
function taaState(capture, where) {
    const tasks = capture.temporalTasks;
    const source = /** @type {SourceTask | undefined} */ (
        tasks.find((task) => task.clean)
    );
    const taa = /** @type {TaaTask | undefined} */ (
        tasks.find((task) => task.executions !== undefined)
    );
    assert(source && taa, `${where}: missing retained source/TAA capture`);
    assert.deepEqual(
        taa.sourceTasks,
        [source.taskIndex],
        `${where}: the TAA task does not name the source task`,
    );
    assert.equal(source.clean.length, 92, `${where}: source uniform length`);
    assert.deepEqual(
        source.drawn.slice(0, 16),
        taa.jitterScratch,
        `${where}: the drawn prefix is the jitter scratch`,
    );
    assert.deepEqual(
        source.drawn.slice(16),
        source.clean.slice(16),
        `${where}: the drawn tail is the clean tail`,
    );
    assert.equal(
        taa.lastCameraVersion,
        source.cache.cameraKey,
        `${where}: camera version`,
    );
    assert.equal(taa.factor, 0.05, `${where}: configured factor`);
    return { source, taa };
}

/** @param {PluginContext} context */
export function check(context) {
    /** @type {Record<string, Record<string, number | undefined>>} */
    const details = {};
    if (context.options.mode === "frozen") {
        const observations = requireObservations(context);
        assertObservationProvenance(context, observations);
        const first = observedStep(observations, "first");
        assert.deepEqual(
            observedStep(observations, "idle").state,
            first.state,
            "the browser's frozen state changed while idle",
        );
        assert(first.state, "the observed step 'first' recorded no state");
        const expected = /** @type {ObservedState} */ (first.state);
        assert.equal(expected.cleanLength, 92);
        for (const backend of context.backends) {
            const results = context.results[backend];
            assert(results, `${backend}: no phase results`);
            for (const phase of Object.values(results)) {
                const where = `${backend}/${phase.id}`;
                const capture = /** @type {NativeCapture} */ (phase.capture);
                const { source, taa } = taaState(capture, where);
                assert.equal(
                    taa.executions,
                    expected.executions,
                    `${where}: stopped engine continued executing TAA`,
                );
                assert.equal(
                    taa.haltonIndex,
                    expected.haltonIndex,
                    `${where}: Halton index`,
                );
                assert.equal(
                    taa.blendFactor,
                    expected.factor,
                    `${where}: blend factor`,
                );
                assert.equal(
                    taa.lastCameraVersion,
                    expected.lastCameraVersion,
                    `${where}: camera version`,
                );
                assert.deepEqual(
                    source.cleanWords,
                    expected.cleanWords,
                    `${where}: cleanWords differ from the exact pin`,
                );
                assert.deepEqual(
                    source.drawnWords,
                    expected.drawnWords,
                    `${where}: drawnWords differ from the exact pin`,
                );
                assert.deepEqual(
                    taa.haltonWords,
                    expected.haltonWords,
                    `${where}: haltonWords differ from the exact pin`,
                );
                assert.deepEqual(
                    taa.jitterScratchWords,
                    expected.jitterScratchWords,
                    `${where}: jitterScratchWords differ from the exact pin`,
                );
                for (const key of CAMERA_KEYS) {
                    assert.equal(
                        capture.camera[key],
                        expected.camera[key],
                        `${where}: camera ${key}`,
                    );
                }
                details[where] = {
                    executions: taa.executions,
                    haltonIndex: taa.haltonIndex,
                    blendFactor: taa.blendFactor,
                };
            }
        }
        return { details };
    }
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        /** @param {string} id */
        const phaseState = (id) => {
            const phase = results[id];
            assert(phase, `${backend}: no phase '${id}'`);
            return taaState(
                /** @type {NativeCapture} */ (phase.capture),
                `${backend}/${id}`,
            );
        };
        const settled = phaseState("settled");
        const moving = phaseState("moving");
        const recovered = phaseState("recovered");
        const resized = phaseState("resize");
        assert.equal(
            settled.taa.blendFactor,
            0.05,
            `${backend}: settled blend factor`,
        );
        assert.equal(
            moving.taa.blendFactor,
            1,
            `${backend}: camera movement did not reset accumulation`,
        );
        assert.equal(
            recovered.taa.blendFactor,
            0.05,
            `${backend}: accumulation did not resume after the camera settled`,
        );
        assert(
            moving.source.cache.cameraKey > settled.source.cache.cameraKey,
            `${backend}: the camera key did not advance`,
        );
        assert.equal(
            resized.source.cache.aspect,
            960 / 600,
            `${backend}: the resized aspect`,
        );
        assert.notDeepEqual(
            resized.source.clean,
            settled.source.clean,
            `${backend}: resize did not rebuild the clean data`,
        );
        assert.equal(
            resized.taa.blendFactor,
            0.05,
            `${backend}: resize disturbed the blend`,
        );
        details[backend] = {
            settled: settled.taa.blendFactor,
            moving: moving.taa.blendFactor,
            recovered: recovered.taa.blendFactor,
        };
    }
    return { details };
}
