import assert from "node:assert/strict";
import {
    assertObservationProvenance,
    maxError,
    requireObservations,
} from "./support.mjs";

function checkGround(matrices, where) {
    for (let offset = 0; offset < matrices.length; offset += 16) {
        const [x, y, z] = matrices.slice(offset + 12, offset + 15);
        if (Math.abs(x) < 98 && Math.abs(z) < 98)
            assert(y > -0.1, `${where}: an instance passed through the ground`);
    }
}

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    for (const frame of observations.captureFrames) {
        assert.equal(frame.state.step, frame.frame);
        assert.equal(frame.state.nativeBodies, 2009);
        assert.deepEqual(
            frame.state.meshes.map((mesh) => mesh.count),
            [1000, 1000, 8],
        );
        if (frame.frame >= 360)
            frame.state.meshes.forEach((mesh) =>
                checkGround(mesh.matrices, `browser/${frame.frame}`),
            );
    }
    const steps = new Map(
        observations.steps.map((step) => [step.id, step.state]),
    );
    assert.notEqual(
        steps.get("orbit").camera.alpha,
        steps.get("baseline").camera.alpha,
    );
    assert.notEqual(
        steps.get("wheel").camera.radius,
        steps.get("orbit").camera.radius,
    );
    assert.deepEqual(steps.get("resize").viewport, [1000, 600]);
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const native = phase.capture.meshes.filter(
                (mesh) => mesh.thinInstanced,
            );
            assert.deepEqual(
                native.map((mesh) => mesh.instanceCount),
                [1000, 1000, 8],
                where,
            );
            // The fixed scene steps on native frame zero; browser counters start at one.
            const expected = observations.captureFrames.find(
                (frame) => frame.frame === phase.frame + 1,
            ).state.meshes;
            let error = 0;
            native.forEach((mesh, index) => {
                assert.deepEqual(
                    mesh.position,
                    expected[index].position,
                    `${where}: carrier moved`,
                );
                assert.equal(
                    mesh.instanceMatrices.length,
                    expected[index].matrices.length,
                );
                assert(
                    mesh.instanceMatrices.every(Number.isFinite),
                    `${where}: non-finite matrix`,
                );
                error = Math.max(
                    error,
                    maxError(mesh.instanceMatrices, expected[index].matrices),
                );
                if (index === 0 && phase.frame < 180)
                    assert(
                        maxError(
                            mesh.instanceMatrices,
                            expected[index].matrices,
                        ) < 0.01,
                        `${where}: free-fall boxes diverged`,
                    );
                if (phase.frame >= 359)
                    checkGround(mesh.instanceMatrices, where);
                for (
                    let offset = 0;
                    offset < mesh.instanceMatrices.length;
                    offset += 16
                ) {
                    const matrix = mesh.instanceMatrices.slice(
                        offset,
                        offset + 16,
                    );
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
                        const initial = observations.captureFrames.find(
                            (frame) => frame.frame === 1,
                        ).state.meshes[index].matrices;
                        const descent = initial[offset + 13] - matrix[13];
                        assert(
                            descent > 35 && descent < 55,
                            `${where}: an instance stopped falling`,
                        );
                    }
                }
            });
            if (["orbit", "wheel", "resize"].includes(phase.id)) {
                const stationary = context.results[backend][
                    "frame-180"
                ].capture.meshes.filter((mesh) => mesh.thinInstanced);
                native.forEach((mesh, index) =>
                    assert.deepEqual(
                        mesh.instanceMatrices,
                        stationary[index].instanceMatrices,
                        `${where}: input changed physics`,
                    ),
                );
            }
            details[where] = { matrixError: error, instances: 2008 };
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
                const mean = (samples) =>
                    samples.reduce(
                        (sum, sample) => sum + Number(sample[2]),
                        0,
                    ) / samples.length;
                details[where].cpuMs = {
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
