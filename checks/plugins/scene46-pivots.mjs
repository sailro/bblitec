// Scene 46: the seven constraint groups' pivot geometry, and the browser
// frames the native bodies must reproduce. The browser observation
// records every body's Havok transform at each captured frame (the step
// counter must be frame + 1) and the live steps under input and resize;
// natively, every phase's bodies must keep their pivots attached (ball,
// hinge, fixed within 0.03; the fixed pair at distance 2; the radial
// pair within its limits; the paired anchors aligned in x/z), and frame
// 10 must match the browser within 0.01.
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
 * @typedef {readonly [number, number, number, ...number[]]} Lanes a vector, or a quaternion read as its vector part
 * @typedef {{ transform: [Vector3, Quaternion] }} ObservedBody the body's Havok QTransform
 * @typedef {{
 *     steps: number,
 *     viewport: { width: number, height: number },
 *     camera: Vector3,
 *     bodies: ObservedBody[],
 * }} ObservedState the hook's `window.__observeConstraints()` record
 * @typedef {{ position: Vector3, rotationQuaternion: Quaternion }} NativeMesh
 * @typedef {{ meshes: NativeMesh[] }} NativeCapture the fields read from a phase's render capture
 */

/**
 * A vector's three lanes mapped, keeping the vector type.
 * @param {Vector3} vector
 * @param {(value: number, index: 0 | 1 | 2) => number} lane
 * @returns {Vector3}
 */
const mapVector = (vector, lane) => [
    lane(vector[0], 0),
    lane(vector[1], 1),
    lane(vector[2], 2),
];
/**
 * @param {Lanes} a
 * @param {Lanes} b
 * @returns {Vector3}
 */
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
/**
 * @param {NativeMesh} mesh
 * @param {Vector3} point
 */
const pivot = (mesh, point) => {
    const q = mesh.rotationQuaternion;
    const t = mapVector(cross(q, point), (value) => 2 * value);
    const v = cross(q, t);
    return mapVector(
        point,
        (p, i) => mesh.position[i] + p + q[3] * t[i] + v[i],
    );
};
/**
 * @param {Vector3} a
 * @param {Vector3} b
 */
const distance = (a, b) =>
    Math.hypot(...mapVector(a, (value, index) => value - b[index]));

/**
 * @param {ObservedStep | ObservedFrame} record
 * @param {string} label
 * @returns {ObservedState}
 */
function observedState(record, label) {
    assert(record.state, `the observed ${label} recorded no state`);
    return /** @type {ObservedState} */ (record.state);
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
            state.steps,
            frame.frame + 1,
            `browser frame ${frame.frame}: Havok stepped ${state.steps} times`,
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
        "the browser source attaches no camera controls",
    );
    assert(
        pointer.steps > baseline.steps,
        "browser physics stopped during input",
    );
    const resized = observedState(
        observedStep(observations, "resize"),
        "step 'resize'",
    );
    assert.deepEqual(resized.viewport, { width: 1000, height: 600 });
    assert(
        resized.steps > pointer.steps,
        "browser physics stopped during resize",
    );
    /**
     * @type {Record<string, {
     *     positionError: number | undefined,
     *     rotationError: number | undefined,
     *     pivotErrors: number[],
     *     fixedDistance: number,
     *     radialDistance: number,
     * }>}
     */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const bodies = /** @type {NativeCapture} */ (phase.capture).meshes;
            /** @param {number} index */
            const bodyAt = (index) => {
                const body = bodies[index];
                assert(body, `${where}: the capture carries no mesh ${index}`);
                return body;
            };
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
                        maxError(
                            body.position,
                            expectedBody(index).transform[0],
                        ),
                    ),
                );
                rotationError = Math.max(
                    ...bodies.map((body, index) =>
                        Math.min(
                            ...[1, -1].map((sign) =>
                                maxError(
                                    body.rotationQuaternion,
                                    expectedBody(index).transform[1].map(
                                        (value) => value * sign,
                                    ),
                                ),
                            ),
                        ),
                    ),
                );
                if (phase.frame === 10) {
                    assert(
                        positionError < 0.01,
                        `${where}: frame-10 positions diverge from the browser by ${positionError}`,
                    );
                    assert(
                        rotationError < 0.01,
                        `${where}: frame-10 rotations diverge from the browser by ${rotationError}`,
                    );
                }
            }
            const pivotErrors = [
                distance(
                    pivot(bodyAt(0), [-0.5, 0, -0.5]),
                    pivot(bodyAt(1), [-0.5, 0, 0.5]),
                ),
                distance(
                    pivot(bodyAt(4), [0, 0, -0.5]),
                    pivot(bodyAt(5), [0, 0, 0.5]),
                ),
                distance(
                    pivot(bodyAt(9), [0.5, 0.5, -0.5]),
                    pivot(bodyAt(10), [-0.5, -0.5, 0.5]),
                ),
            ];
            assert(
                Math.max(...pivotErrors) < 0.03,
                `${where}: a ball, hinge or fixed pivot detached (${pivotErrors.join(", ")})`,
            );
            const fixedDistance = distance(
                bodyAt(2).position,
                bodyAt(3).position,
            );
            assert(
                Math.abs(fixedDistance - 2) < 0.03,
                `${where}: the fixed pair is ${fixedDistance} apart`,
            );
            const radialDistance = distance(
                pivot(bodyAt(14), [0, -0.5, 0]),
                pivot(bodyAt(15), [0, 0.5, 0]),
            );
            assert(
                radialDistance > 0.97 && radialDistance < 2.03,
                `${where}: the radial pair is ${radialDistance} apart`,
            );
            for (const [a, b] of /** @type {const} */ ([
                [6, 7],
                [11, 12],
            ])) {
                const anchor = pivot(bodyAt(a), [0, 0, -0.2]);
                const follower = pivot(bodyAt(b), [0, 0, 0.25]);
                assert(
                    Math.abs(anchor[0] - follower[0]) < 0.03 &&
                        Math.abs(anchor[2] - follower[2]) < 0.03,
                    `${where}: anchor ${a}/${b} misaligned`,
                );
            }
            details[where] = {
                positionError,
                rotationError,
                pivotErrors,
                fixedDistance,
                radialDistance,
            };
            context.log(
                `${where}: positionError=${positionError ?? "n/a"} rotationError=${rotationError ?? "n/a"} radialDistance=${radialDistance.toFixed(4)}`,
            );
        }
    }
    return { details };
}
