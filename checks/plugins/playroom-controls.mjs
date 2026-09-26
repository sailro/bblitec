import assert from "node:assert/strict";
import { suiteBrowserModule } from "../../dist/src/capture-suite-reference.js";
import { applyObserveHooks } from "../../dist/src/tooling/observe-run.js";
import {
    assertObservationProvenance,
    observedStep,
    requireObservations,
    sha256,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 * @typedef {{
 *   dataset: Record<string, string | undefined>,
 *   viewport: {width: number, height: number},
 *   startupHidden: boolean,
 *   freePressed: string,
 *   kickHidden: boolean,
 *   camera: {alpha: number, beta: number},
 * }} PlayroomState
 */

/** @type {Array<[string, string[]]>} */
const transitions = [
    ["ready", ["ready"]],
    ["aiming", ["ready", "aiming"]],
    ["orbit", ["ready", "aiming"]],
    ["free", ["ready", "aiming", "free"]],
    ["orbit-restored", ["ready", "aiming", "free", "aiming"]],
    ["watching", ["ready", "aiming", "watching"]],
];

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    assert.equal(
        observations.moduleSha256,
        sha256(
            suiteBrowserModule(context.scene.source, (source) =>
                applyObserveHooks(source, context.spec.observe?.hooks),
            ),
        ),
    );
    for (const [id, expected] of transitions) {
        const step = observedStep(observations, id);
        assert.deepEqual(step.errors ?? [], [], `${id}: browser errors`);
        assert(step.state, `${id}: browser state`);
        const state = /** @type {PlayroomState} */ (step.state);
        const phase = expected.at(-1);
        assert.equal(state.dataset.ready, "true");
        assert.equal(state.dataset.gamePhase, phase, `${id}: browser phase`);
        assert.equal(state.dataset.throwCount, "1");
        assert.equal(state.dataset.error, undefined);
        assert(Number(state.dataset.bodyCount) > 0);
        assert(Number(state.dataset.constraintCount) > 0);
        assert(state.dataset.sourceUiRevision);
        assert.deepEqual(state.viewport, { width: 1280, height: 720 });
        assert.equal(state.startupHidden, phase !== "ready");
        assert.equal(state.kickHidden, phase !== "aiming");
        assert.equal(state.freePressed, String(phase === "free"));
        for (const result of context.phase(id)) {
            const where = `${result.backend}:${id}`;
            const states = [...result.log.matchAll(/dataset gamePhase=(\w+)/g)]
                .map((match) => match[1])
                .filter((value) => value !== "loading");
            assert.deepEqual(
                states,
                expected,
                `${where}: source phase transitions`,
            );
            const values = Object.fromEntries(
                [...result.log.matchAll(/dataset (\w+)=([^\r\n]*)/g)].map(
                    (match) => [match[1], match[2]],
                ),
            );
            assert.equal(values.ready, "true", `${where}: ready`);
            assert.equal(values.throwCount, "1", `${where}: first throw`);
            assert.equal(
                values.sourceUiRevision,
                state.dataset.sourceUiRevision,
                `${where}: source UI revision`,
            );
            assert.equal(
                values.bodyCount,
                state.dataset.bodyCount,
                `${where}: physics bodies`,
            );
            assert.equal(
                values.constraintCount,
                state.dataset.constraintCount,
                `${where}: physics constraints`,
            );
        }
    }
    const aiming = /** @type {PlayroomState} */ (
        observedStep(observations, "aiming").state
    );
    const orbit = /** @type {PlayroomState} */ (
        observedStep(observations, "orbit").state
    );
    assert(
        Math.abs(orbit.camera.alpha - aiming.camera.alpha) > 0.1,
        "browser: left drag rotates alpha",
    );
    assert(
        Math.abs(orbit.camera.beta - aiming.camera.beta) > 0.03,
        "browser: left drag rotates beta",
    );
    /** @param {string} log */
    const camera = (log) => {
        const match = [
            ...log.matchAll(
                /camera frame=\d+ kind=arc-rotate alpha=([-\d.e+]+) beta=([-\d.e+]+)/g,
            ),
        ].at(-1);
        assert(match, "native camera trace is missing");
        return { alpha: Number(match[1]), beta: Number(match[2]) };
    };
    for (const result of context.phase("orbit")) {
        const baseline = context
            .phase("aiming")
            .find((phase) => phase.backend === result.backend);
        assert(baseline, `${result.backend}: aiming baseline is missing`);
        const before = camera(baseline.log);
        const after = camera(result.log);
        assert(
            Math.abs(after.alpha - before.alpha) > 0.1,
            `${result.backend}: left drag rotates alpha`,
        );
        assert(
            Math.abs(after.beta - before.beta) > 0.03,
            `${result.backend}: left drag rotates beta`,
        );
    }
}
