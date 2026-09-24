// Scene 47: the falling bodies matched to native meshes. The browser
// observation records each body's mesh index, position and rotation per
// captured frame; each native body is the one standard-material mesh
// drawn at the browser body's frame-1 position (the ground is the
// 10201-vertex heightfield), and its debug viewer the shader-material
// mesh at the same position. Free fall (frames <= 60) must match within
// 0.005 / 0.001; every shape must be between the terrain and the sky at
// frame 240; input and resize must not move the bodies.
import assert from "node:assert/strict";
import {
    assertObservationProvenance,
    maxError,
    observedStep,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 * @import { ObservedFrame, ObservedStep } from "./support.mjs"
 */

/**
 * @typedef {[number, number, number]} Vector3
 * @typedef {[number, number, number, number]} Quaternion
 * @typedef {{ position: Vector3, rotation: Quaternion }} ObservedBody
 * @typedef {{
 *     step: number,
 *     camera: { alpha: number, beta: number, radius: number },
 *     viewport: { width: number, height: number },
 *     bodies: ObservedBody[],
 * }} ObservedState the hook's `window.__scene47Observe()` record
 * @typedef {{
 *     index: number,
 *     position: Vector3,
 *     rotationQuaternion: Quaternion,
 *     geometryInfo: { vertexCount: number },
 * }} NativeMesh
 * @typedef {{
 *     meshes: NativeMesh[],
 *     draws: Array<{ mesh: number | null, materialKind: string }>,
 * }} NativeCapture the fields read from a phase's render capture
 */

/**
 * @param {ObservedStep | ObservedFrame} record
 * @param {string} label
 * @returns {ObservedState}
 */
function observedState(record, label) {
    assert(record.state, `the observed ${label} recorded no state`);
    return /** @type {ObservedState} */ (record.state);
}

/**
 * @param {NativeCapture} state
 * @param {number | undefined} index
 * @param {string} where
 */
function nativeMesh(state, index, where) {
    const mesh = index === undefined ? undefined : state.meshes[index];
    assert(mesh, `${where}: the capture carries no mesh ${index}`);
    return mesh;
}

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const captureFrames = observations.captureFrames;
    assert(captureFrames, "the observations carry no capture frames");
    for (const frame of captureFrames) {
        const state = observedState(frame, `frame ${frame.frame}`);
        assert.equal(
            state.step,
            frame.frame,
            `browser frame ${frame.frame}: physics stepped ${state.step} times`,
        );
    }
    const baseline = observedState(
        observedStep(observations, "baseline"),
        "step 'baseline'",
    );
    const pointer = observedState(
        observedStep(observations, "pointer-wheel"),
        "step 'pointer-wheel'",
    );
    assert.deepEqual(
        pointer.camera,
        baseline.camera,
        "the browser scene has no attached camera controls",
    );
    assert(
        pointer.step > baseline.step,
        "browser physics stopped during input",
    );
    const resized = observedState(
        observedStep(observations, "resize"),
        "step 'resize'",
    );
    assert.deepEqual(resized.viewport, { width: 1000, height: 600 });
    assert(
        resized.step > pointer.step,
        "browser physics stopped during resize",
    );
    const firstFrame = captureFrames.find((frame) => frame.frame === 1);
    /** @type {Record<string, { positionError: number | undefined, rotationError: number | undefined }>} */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        /** @type {Map<string, { positions: Vector3[] }>} */
        const captures = new Map();
        /** @type {number[] | undefined} */
        let bodyMeshes;
        /** @type {number[] | undefined} */
        let debugMeshes;
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const state = /** @type {NativeCapture} */ (phase.capture);
            if (!bodyMeshes || !debugMeshes) {
                assert(firstFrame, "the browser observed no frame 1");
                const expected = observedState(firstFrame, "frame 1").bodies;
                bodyMeshes = expected.map((body, index) => {
                    const matches = state.meshes.filter(
                        (mesh) =>
                            state.draws.some(
                                (draw) =>
                                    draw.mesh === mesh.index &&
                                    draw.materialKind === "standard",
                            ) &&
                            maxError(mesh.position, body.position) < 0.001 &&
                            (index !== 0 ||
                                mesh.geometryInfo.vertexCount === 10201),
                    );
                    assert.equal(
                        matches.length,
                        1,
                        `${where}: body ${index}: expected one native solid mesh`,
                    );
                    const [match] = matches;
                    assert(match);
                    return match.index;
                });
                debugMeshes = expected.map((body) => {
                    const matches = state.meshes.filter(
                        (mesh) =>
                            state.draws.some(
                                (draw) =>
                                    draw.mesh === mesh.index &&
                                    draw.materialKind === "shader",
                            ) && maxError(mesh.position, body.position) < 0.001,
                    );
                    assert.equal(
                        matches.length,
                        1,
                        `${where}: expected one debug mesh per body`,
                    );
                    const [match] = matches;
                    assert(match);
                    return match.index;
                });
            }
            const bodies = bodyMeshes.map((index) =>
                nativeMesh(state, index, where),
            );
            const browserFrame = captureFrames.find(
                (frame) => frame.frame === phase.frame,
            );
            let positionError;
            let rotationError;
            if (browserFrame !== undefined) {
                const expected = observedState(
                    browserFrame,
                    `frame ${browserFrame.frame}`,
                ).bodies;
                /** @param {number} index */
                const expectedBody = (index) => {
                    const body = expected[index];
                    assert(
                        body,
                        `${where}: browser frame ${browserFrame.frame} carries no body ${index}`,
                    );
                    return body;
                };
                positionError = Math.max(
                    ...bodies.map((body, index) =>
                        maxError(body.position, expectedBody(index).position),
                    ),
                );
                rotationError = Math.max(
                    ...bodies.map((body, index) =>
                        Math.min(
                            maxError(
                                body.rotationQuaternion,
                                expectedBody(index).rotation,
                            ),
                            maxError(
                                body.rotationQuaternion,
                                expectedBody(index).rotation.map(
                                    (value) => -value,
                                ),
                            ),
                        ),
                    ),
                );
                if (phase.frame <= 60) {
                    assert(
                        positionError < 0.005,
                        `${where}: free-fall positions diverged (${positionError})`,
                    );
                    assert(
                        rotationError < 0.001,
                        `${where}: free-fall rotations diverged (${rotationError})`,
                    );
                }
            }
            for (const [index, body] of bodies.entries()) {
                assert(
                    body.position.every(Number.isFinite) &&
                        body.rotationQuaternion.every(Number.isFinite),
                    `${where}: body ${index} is not finite`,
                );
                const debug = nativeMesh(state, debugMeshes[index], where);
                assert.deepEqual(
                    debug.position,
                    body.position,
                    `${where}: viewer detached from its live body`,
                );
                assert.deepEqual(
                    debug.rotationQuaternion,
                    body.rotationQuaternion,
                    `${where}: viewer rotation detached from its live body`,
                );
            }
            if (phase.frame === 240) {
                assert(
                    bodies
                        .slice(1)
                        .every(
                            (body) =>
                                body.position[1] > -3 && body.position[1] < 13,
                        ),
                    `${where}: a falling shape missed the terrain`,
                );
            }
            captures.set(phase.id, {
                positions: bodies.map((body) => body.position),
            });
            details[where] = { positionError, rotationError };
            context.log(
                `${where}: max position error ${positionError ?? "n/a"}`,
            );
        }
        /** @param {string} id */
        const positions = (id) => {
            const capture = captures.get(id);
            assert(capture, `${backend}: no phase '${id}'`);
            return capture.positions;
        };
        const stationary = positions("frame-120");
        assert.deepEqual(
            positions("pointer-wheel"),
            stationary,
            `${backend}: unhandled input changed the simulation`,
        );
        assert.deepEqual(
            positions("resize"),
            stationary,
            `${backend}: resize changed the simulation`,
        );
    }
    return { details };
}
