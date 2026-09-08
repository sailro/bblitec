// Scene 261: the TAA task's retained state, read from the native capture's
// temporalTasks (the source task carries `clean`, the TAA task carries
// `executions`). The frozen mode compares every phase against the browser
// observation, word for word (JSON numbers normalize JavaScript -0, so the
// float32 bit patterns are compared as uint32 words); the live mode checks
// the accumulation reset and recovery the twin exhibits under input.
//
// options: { mode: "frozen" | "live" }
import assert from "node:assert/strict";
import { assertObservationProvenance, observedStep, requireObservations } from "./support.mjs";

function taaState(capture, where) {
    const source = capture.temporalTasks.find((task) => task.clean);
    const taa = capture.temporalTasks.find((task) => task.executions !== undefined);
    assert(source && taa, `${where}: missing retained source/TAA capture`);
    assert.deepEqual(taa.sourceTasks, [source.taskIndex], `${where}: the TAA task does not name the source task`);
    assert.equal(source.clean.length, 92, `${where}: source uniform length`);
    assert.deepEqual(source.drawn.slice(0, 16), taa.jitterScratch, `${where}: the drawn prefix is the jitter scratch`);
    assert.deepEqual(source.drawn.slice(16), source.clean.slice(16), `${where}: the drawn tail is the clean tail`);
    assert.equal(taa.lastCameraVersion, source.cache.cameraKey, `${where}: camera version`);
    assert.equal(taa.factor, 0.05, `${where}: configured factor`);
    return { source, taa };
}

export function check(context) {
    const details = {};
    if (context.options.mode === "frozen") {
        const observations = requireObservations(context);
        assertObservationProvenance(context, observations);
        const expected = observedStep(observations, "first").state;
        assert.deepEqual(observedStep(observations, "idle").state, expected, "the browser's frozen state changed while idle");
        assert.equal(expected.cleanLength, 92);
        for (const backend of context.backends) {
            for (const phase of Object.values(context.results[backend])) {
                const where = `${backend}/${phase.id}`;
                const { source, taa } = taaState(phase.capture, where);
                assert.equal(taa.executions, expected.executions, `${where}: stopped engine continued executing TAA`);
                assert.equal(taa.haltonIndex, expected.haltonIndex, `${where}: Halton index`);
                assert.equal(taa.blendFactor, expected.factor, `${where}: blend factor`);
                assert.equal(taa.lastCameraVersion, expected.lastCameraVersion, `${where}: camera version`);
                assert.deepEqual(source.cleanWords, expected.cleanWords, `${where}: cleanWords differ from the exact pin`);
                assert.deepEqual(source.drawnWords, expected.drawnWords, `${where}: drawnWords differ from the exact pin`);
                assert.deepEqual(taa.haltonWords, expected.haltonWords, `${where}: haltonWords differ from the exact pin`);
                assert.deepEqual(taa.jitterScratchWords, expected.jitterScratchWords, `${where}: jitterScratchWords differ from the exact pin`);
                for (const key of ["alpha", "beta", "radius"]) {
                    assert.equal(phase.capture.camera[key], expected.camera[key], `${where}: camera ${key}`);
                }
                details[where] = { executions: taa.executions, haltonIndex: taa.haltonIndex, blendFactor: taa.blendFactor };
            }
        }
        return { details };
    }
    for (const backend of context.backends) {
        const results = context.results[backend];
        const settled = taaState(results.settled.capture, `${backend}/settled`);
        const moving = taaState(results.moving.capture, `${backend}/moving`);
        const recovered = taaState(results.recovered.capture, `${backend}/recovered`);
        const resized = taaState(results.resize.capture, `${backend}/resize`);
        assert.equal(settled.taa.blendFactor, 0.05, `${backend}: settled blend factor`);
        assert.equal(moving.taa.blendFactor, 1, `${backend}: camera movement did not reset accumulation`);
        assert.equal(recovered.taa.blendFactor, 0.05, `${backend}: accumulation did not resume after the camera settled`);
        assert(moving.source.cache.cameraKey > settled.source.cache.cameraKey, `${backend}: the camera key did not advance`);
        assert.equal(resized.source.cache.aspect, 960 / 600, `${backend}: the resized aspect`);
        assert.notDeepEqual(resized.source.clean, settled.source.clean, `${backend}: resize did not rebuild the clean data`);
        assert.equal(resized.taa.blendFactor, 0.05, `${backend}: resize disturbed the blend`);
        details[backend] = { settled: settled.taa.blendFactor, moving: moving.taa.blendFactor, recovered: recovered.taa.blendFactor };
    }
    return { details };
}
