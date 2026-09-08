// Scene 114: the four pick markers the source places after its GPU and
// detailed picks. The browser observation records the hits by target
// name and every mesh's placement; each native capture must hold the
// same four markers at the same points (positions exact; the source's
// scaling fields enter float record lanes, observed maximum error
// 3.24e-9), and the browser's idle observation must equal its first.
import assert from "node:assert/strict";
import { compareImages } from "../../dist/src/parity.js";
import { assertObservationProvenance, maxError, observedImage, observedStep, requireObservations } from "./support.mjs";

const MARKERS = ["morph-gpu-marker", "morph-detailed-marker", "skeleton-gpu-marker", "skeleton-detailed-marker"];

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const first = observedStep(observations, "first");
    const idle = observedStep(observations, "idle");
    assert.deepEqual(first.state.hits, {
        morphGpuHit: "scene114-morph-target", morphDetailedHit: "scene114-morph-target",
        skeletonGpuHit: "scene114-skeleton-target", skeletonDetailedHit: "scene114-skeleton-target",
    }, "the browser picks did not hit their targets");
    assert.deepEqual(idle.state, first.state, "the browser scene moved while idle");
    assert.equal(compareImages(observedImage(context, first.image), observedImage(context, idle.image)).maxDiff, 0, "the browser image changed while idle");
    const referenceMarkers = MARKERS.map((suffix) => {
        const marker = first.state.meshes.find((mesh) => mesh.name === `scene114-${suffix}`);
        assert(marker && marker.position[1] !== -100, `Missing reference marker ${suffix}`);
        return marker;
    });
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            assert.equal(phase.capture.meshes.length, first.state.meshes.length, `${backend}/${phase.id}: mesh count differs from the browser`);
            details[`${backend}/${phase.id}`] = referenceMarkers.map((expected) => {
                const actual = phase.capture.meshes[expected.index];
                const positionError = maxError(actual.position, expected.position);
                const scalingError = maxError(actual.scaling, expected.scaling);
                assert(positionError < 1e-7, `${backend}/${phase.id}: ${expected.name} point changed (error ${positionError})`);
                assert(scalingError < 1e-7, `${backend}/${phase.id}: ${expected.name} barycentric scale changed (error ${scalingError})`);
                return { name: expected.name, positionError, scalingError };
            });
        }
    }
    return { details };
}
