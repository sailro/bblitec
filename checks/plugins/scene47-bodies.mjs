// Scene 47: the falling bodies matched to native meshes. The browser
// observation records each body's mesh index, position and rotation per
// captured frame; each native body is the one standard-material mesh
// drawn at the browser body's frame-1 position (the ground is the
// 10201-vertex heightfield), and its debug viewer the shader-material
// mesh at the same position. Free fall (frames <= 60) must match within
// 0.005 / 0.001; every shape must be between the terrain and the sky at
// frame 240; input and resize must not move the bodies.
import assert from "node:assert/strict";
import { assertObservationProvenance, maxError, requireObservations } from "./support.mjs";

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    for (const frame of observations.captureFrames) {
        assert.equal(frame.state.step, frame.frame, `browser frame ${frame.frame}: physics stepped ${frame.state.step} times`);
    }
    const baseline = observations.steps.find((step) => step.id === "baseline");
    const pointer = observations.steps.find((step) => step.id === "pointer-wheel");
    const resized = observations.steps.find((step) => step.id === "resize");
    assert.deepEqual(pointer.state.camera, baseline.state.camera, "the browser scene has no attached camera controls");
    assert(pointer.state.step > baseline.state.step, "browser physics stopped during input");
    assert.deepEqual(resized.state.viewport, { width: 1000, height: 600 });
    assert(resized.state.step > pointer.state.step, "browser physics stopped during resize");
    const firstFrame = observations.captureFrames.find((frame) => frame.frame === 1);
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        const captures = new Map();
        let bodyMeshes;
        let debugMeshes;
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const state = phase.capture;
            if (!bodyMeshes) {
                const expected = firstFrame.state.bodies;
                bodyMeshes = expected.map((body, index) => {
                    const matches = state.meshes.filter((mesh) => state.draws.some((draw) => draw.mesh === mesh.index && draw.materialKind === "standard") &&
                        maxError(mesh.position, body.position) < 0.001 && (index !== 0 || mesh.geometryInfo.vertexCount === 10201));
                    assert.equal(matches.length, 1, `${where}: body ${index}: expected one native solid mesh`);
                    return matches[0].index;
                });
                debugMeshes = expected.map((body) => {
                    const matches = state.meshes.filter((mesh) => state.draws.some((draw) => draw.mesh === mesh.index && draw.materialKind === "shader") && maxError(mesh.position, body.position) < 0.001);
                    assert.equal(matches.length, 1, `${where}: expected one debug mesh per body`);
                    return matches[0].index;
                });
            }
            const bodies = bodyMeshes.map((index) => state.meshes[index]);
            const browserFrame = observations.captureFrames.find((frame) => frame.frame === phase.frame);
            let positionError;
            let rotationError;
            if (browserFrame !== undefined) {
                const expected = browserFrame.state.bodies;
                positionError = Math.max(...bodies.map((body, index) => maxError(body.position, expected[index].position)));
                rotationError = Math.max(...bodies.map((body, index) => Math.min(maxError(body.rotationQuaternion, expected[index].rotation),
                    maxError(body.rotationQuaternion, expected[index].rotation.map((value) => -value)))));
                if (phase.frame <= 60) {
                    assert(positionError < 0.005, `${where}: free-fall positions diverged (${positionError})`);
                    assert(rotationError < 0.001, `${where}: free-fall rotations diverged (${rotationError})`);
                }
            }
            bodies.forEach((body, index) => {
                assert(body.position.every(Number.isFinite) && body.rotationQuaternion.every(Number.isFinite), `${where}: body ${index} is not finite`);
                const debug = state.meshes[debugMeshes[index]];
                assert.deepEqual(debug.position, body.position, `${where}: viewer detached from its live body`);
                assert.deepEqual(debug.rotationQuaternion, body.rotationQuaternion, `${where}: viewer rotation detached from its live body`);
            });
            if (phase.frame === 240) {
                assert(bodies.slice(1).every((body) => body.position[1] > -3 && body.position[1] < 13), `${where}: a falling shape missed the terrain`);
            }
            captures.set(phase.id, { positions: bodies.map((body) => body.position) });
            details[where] = { positionError, rotationError };
            context.log(`${where}: max position error ${positionError ?? "n/a"}`);
        }
        const stationary = captures.get("frame-120");
        assert.deepEqual(captures.get("pointer-wheel").positions, stationary.positions, `${backend}: unhandled input changed the simulation`);
        assert.deepEqual(captures.get("resize").positions, stationary.positions, `${backend}: resize changed the simulation`);
    }
    return { details };
}
