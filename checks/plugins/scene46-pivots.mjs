// Scene 46: the seven constraint groups' pivot geometry, and the browser
// frames the native bodies must reproduce. The browser observation
// records every body's Havok transform at each captured frame (the step
// counter must be frame + 1) and the live steps under input and resize;
// natively, every phase's bodies must keep their pivots attached (ball,
// hinge, fixed within 0.03; the fixed pair at distance 2; the radial
// pair within its limits; the paired anchors aligned in x/z), and frame
// 10 must match the browser within 0.01.
import assert from "node:assert/strict";
import { assertObservationProvenance, maxError, requireObservations } from "./support.mjs";

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const pivot = (mesh, point) => {
    const q = mesh.rotationQuaternion;
    const t = cross(q, point).map((value) => 2 * value);
    const v = cross(q, t);
    return point.map((p, i) => mesh.position[i] + p + q[3] * t[i] + v[i]);
};
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    for (const frame of observations.captureFrames) {
        assert.equal(frame.state.steps, frame.frame + 1, `browser frame ${frame.frame}: Havok stepped ${frame.state.steps} times`);
    }
    const baseline = observations.steps.find((step) => step.id === "baseline");
    const pointer = observations.steps.find((step) => step.id === "pointer-wheel");
    const resized = observations.steps.find((step) => step.id === "resize");
    assert.deepEqual(pointer.state.camera, baseline.state.camera, "the browser source attaches no camera controls");
    assert(pointer.state.steps > baseline.state.steps, "browser physics stopped during input");
    assert.deepEqual(resized.state.viewport, { width: 1000, height: 600 });
    assert(resized.state.steps > pointer.state.steps, "browser physics stopped during resize");
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const bodies = phase.capture.meshes;
            const browserFrame = observations.captureFrames.find((frame) => frame.frame === phase.frame);
            let positionError;
            let rotationError;
            if (browserFrame !== undefined) {
                const expected = browserFrame.state.bodies;
                positionError = Math.max(...bodies.map((body, index) => maxError(body.position, expected[index].transform[0])));
                rotationError = Math.max(...bodies.map((body, index) => Math.min(...[1, -1].map((sign) =>
                    maxError(body.rotationQuaternion, expected[index].transform[1].map((value) => value * sign))))));
                if (phase.frame === 10) {
                    assert(positionError < 0.01, `${where}: frame-10 positions diverge from the browser by ${positionError}`);
                    assert(rotationError < 0.01, `${where}: frame-10 rotations diverge from the browser by ${rotationError}`);
                }
            }
            const pivotErrors = [
                distance(pivot(bodies[0], [-0.5, 0, -0.5]), pivot(bodies[1], [-0.5, 0, 0.5])),
                distance(pivot(bodies[4], [0, 0, -0.5]), pivot(bodies[5], [0, 0, 0.5])),
                distance(pivot(bodies[9], [0.5, 0.5, -0.5]), pivot(bodies[10], [-0.5, -0.5, 0.5])),
            ];
            assert(Math.max(...pivotErrors) < 0.03, `${where}: a ball, hinge or fixed pivot detached (${pivotErrors.join(", ")})`);
            const fixedDistance = distance(bodies[2].position, bodies[3].position);
            assert(Math.abs(fixedDistance - 2) < 0.03, `${where}: the fixed pair is ${fixedDistance} apart`);
            const radialDistance = distance(pivot(bodies[14], [0, -0.5, 0]), pivot(bodies[15], [0, 0.5, 0]));
            assert(radialDistance > 0.97 && radialDistance < 2.03, `${where}: the radial pair is ${radialDistance} apart`);
            for (const [a, b] of [[6, 7], [11, 12]]) {
                const anchor = pivot(bodies[a], [0, 0, -0.2]);
                const follower = pivot(bodies[b], [0, 0, 0.25]);
                assert(Math.abs(anchor[0] - follower[0]) < 0.03 && Math.abs(anchor[2] - follower[2]) < 0.03, `${where}: anchor ${a}/${b} misaligned`);
            }
            details[where] = { positionError, rotationError, pivotErrors, fixedDistance, radialDistance };
            context.log(`${where}: positionError=${positionError ?? "n/a"} rotationError=${rotationError ?? "n/a"} radialDistance=${radialDistance.toFixed(4)}`);
        }
    }
    return { details };
}
