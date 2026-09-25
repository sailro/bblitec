import assert from "node:assert/strict";
import {
    assertObservationProvenance,
    maxError,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {[number, number, number]} Vector3
 * @typedef {{ count: number, matrices: number[], position: Vector3 }} ObservedMesh
 * @typedef {{
 *     step: number,
 *     nativeBodies: number,
 *     camera: { alpha: number, beta: number, radius: number },
 *     viewport: [number, number],
 *     meshes: ObservedMesh[],
 * }} ObservedState the hook's `window.__scene290Observe()` record
 * @typedef {{
 *     thinInstanced: boolean,
 *     instanceCount: number,
 *     position: Vector3,
 *     instanceMatrices?: number[],
 * }} NativeMesh `instanceMatrices` is written for a thin-instanced mesh whose source holds every instance
 * @typedef {{ meshes: NativeMesh[] }} NativeCapture the fields read from a phase's render capture
 * @typedef {{ matrixError: number, instances: number, cpuMs?: { falling: number, contact: number } }} PhaseDetail
 */

/**
 * @param {readonly number[]} matrices
 * @param {string} where
 */
function checkGround(matrices, where) {
    for (let offset = 0; offset < matrices.length; offset += 16) {
        const [x = NaN, y = NaN, z = NaN] = matrices.slice(
            offset + 12,
            offset + 15,
        );
        if (Math.abs(x) < 98 && Math.abs(z) < 98)
            assert(y > -0.1, `${where}: an instance passed through the ground`);
    }
}

/**
 * @param {unknown} state
 * @param {string} label
 * @returns {ObservedState}
 */
function observedState(state, label) {
    assert(state, `the observed ${label} recorded no state`);
    return /** @type {ObservedState} */ (state);
}

/**
 * @param {NativeMesh} mesh
 * @param {string} where
 */
function instanceMatrices(mesh, where) {
    assert(
        mesh.instanceMatrices,
        `${where}: a thin-instanced mesh carries no instance matrices`,
    );
    return mesh.instanceMatrices;
}

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const captureFrames = observations.captureFrames;
    assert(captureFrames, "the observations carry no capture frames");
    for (const frame of captureFrames) {
        const state = observedState(frame.state, `frame ${frame.frame}`);
        assert.equal(state.step, frame.frame);
        assert.equal(state.nativeBodies, 2009);
        assert.deepEqual(
            state.meshes.map((mesh) => mesh.count),
            [1000, 1000, 8],
        );
        if (frame.frame >= 360)
            state.meshes.forEach((mesh) =>
                checkGround(mesh.matrices, `browser/${frame.frame}`),
            );
    }
    /**
     * The browser meshes of a captured frame.
     * @param {number} number
     */
    const browserMeshes = (number) => {
        const frame = captureFrames.find((entry) => entry.frame === number);
        assert(frame, `the browser captured no frame ${number}`);
        return observedState(frame.state, `frame ${number}`).meshes;
    };
    assert(observations.steps, "the observations carry no steps");
    const steps = new Map(
        observations.steps.map((step) => [step.id, step.state]),
    );
    /** @param {string} id */
    const stepState = (id) => observedState(steps.get(id), `step '${id}'`);
    assert.notEqual(
        stepState("orbit").camera.alpha,
        stepState("baseline").camera.alpha,
    );
    assert.notEqual(
        stepState("wheel").camera.radius,
        stepState("orbit").camera.radius,
    );
    assert.deepEqual(stepState("resize").viewport, [1000, 600]);
    /** @type {Record<string, PhaseDetail>} */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const native = /** @type {NativeCapture} */ (
                phase.capture
            ).meshes.filter((mesh) => mesh.thinInstanced);
            assert.deepEqual(
                native.map((mesh) => mesh.instanceCount),
                [1000, 1000, 8],
                where,
            );
            // The fixed scene steps on native frame zero; browser counters start at one.
            const expected = browserMeshes(phase.frame + 1);
            let error = 0;
            native.forEach((mesh, index) => {
                const browser = expected[index];
                assert(
                    browser,
                    `${where}: the browser carries no mesh ${index}`,
                );
                assert.deepEqual(
                    mesh.position,
                    browser.position,
                    `${where}: carrier moved`,
                );
                const matrices = instanceMatrices(mesh, where);
                assert.equal(matrices.length, browser.matrices.length);
                assert(
                    matrices.every(Number.isFinite),
                    `${where}: non-finite matrix`,
                );
                error = Math.max(error, maxError(matrices, browser.matrices));
                if (index === 0 && phase.frame < 180)
                    assert(
                        maxError(matrices, browser.matrices) < 0.01,
                        `${where}: free-fall boxes diverged`,
                    );
                if (phase.frame >= 359) checkGround(matrices, where);
                for (let offset = 0; offset < matrices.length; offset += 16) {
                    const matrix = matrices.slice(offset, offset + 16);
                    for (const column of [0, 4, 8])
                        assert(
                            Math.abs(
                                Math.hypot(
                                    ...matrix.slice(column, column + 3),
                                ) - 1,
                            ) < 0.00001,
                            `${where}: non-unit rotation basis`,
                        );
                    if (phase.frame === 179) {
                        const initialMesh = browserMeshes(1)[index];
                        assert(
                            initialMesh,
                            `${where}: the browser frame 1 carries no mesh ${index}`,
                        );
                        const initial = initialMesh.matrices;
                        const descent =
                            (initial[offset + 13] ?? NaN) - (matrix[13] ?? NaN);
                        assert(
                            descent > 35 && descent < 55,
                            `${where}: an instance stopped falling`,
                        );
                    }
                }
            });
            if (["orbit", "wheel", "resize"].includes(phase.id)) {
                const settled = results["frame-180"];
                assert(settled, `${backend}: no phase 'frame-180'`);
                const stationary = /** @type {NativeCapture} */ (
                    settled.capture
                ).meshes.filter((mesh) => mesh.thinInstanced);
                native.forEach((mesh, index) =>
                    assert.deepEqual(
                        mesh.instanceMatrices,
                        stationary[index]?.instanceMatrices,
                        `${where}: input changed physics`,
                    ),
                );
            }
            /** @type {PhaseDetail} */
            const detail = { matrixError: error, instances: 2008 };
            details[where] = detail;
            if (phase.id === "frame-900") {
                const frames = [
                    ...phase.log.matchAll(
                        /\[cpu\]\[frame\] frame=(\d+) total_ms=([\d.]+).*render_items=(\d+) draw_commands=(\d+)/g,
                    ),
                ];
                assert(frames.length >= 29, `${where}: missing CPU samples`);
                for (const frame of frames)
                    assert.deepEqual(
                        frame.slice(3, 5),
                        ["4", "4"],
                        `${where}: thin draws expanded`,
                    );
                /** @param {RegExpExecArray[]} samples */
                const mean = (samples) =>
                    samples.reduce(
                        (sum, sample) => sum + Number(sample[2]),
                        0,
                    ) / samples.length;
                detail.cpuMs = {
                    falling: mean(
                        frames.filter(
                            (frame) =>
                                Number(frame[1]) >= 30 &&
                                Number(frame[1]) < 270,
                        ),
                    ),
                    contact: mean(
                        frames.filter((frame) => Number(frame[1]) >= 270),
                    ),
                };
            }
            context.log(
                `${where}: 2008 instance matrices, maximum error ${error}`,
            );
        }
    }
    return { details };
}
