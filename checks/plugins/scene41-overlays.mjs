// Scene 41: the seven physics debug overlays. Each overlay draw carries a
// physics-debug-lines uniform packet whose floats 28..30 are the body's
// position; overlay meshes keep unit scaling and share their body's
// transform (bodies 4/6/10/12 with overlays 5/7/11/13); the clone
// geometry is shared (meshes 4, 6, 8 on geometry 0; 10, 12, 14 on
// geometry 1) and never changes across phases.
import assert from "node:assert/strict";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {[number, number, number]} Vector3
 * @typedef {{
 *     position: Vector3,
 *     rotationQuaternion: [number, number, number, number],
 *     scaling: Vector3,
 *     geometry: number | null,
 * }} NativeMesh
 * @typedef {{
 *     pipeline: string,
 *     mesh: number | null,
 *     uniforms: Array<{ type: string, floats: number[] }>,
 * }} NativeDraw
 * @typedef {{ draws: NativeDraw[], meshes: NativeMesh[] }} NativeCapture the fields read from a phase's render capture
 */

/** @param {PluginContext} context */
export function check(context) {
    /** @type {Record<string, { overlays: number }>} */
    const details = {};
    for (const backend of context.backends) {
        const results = context.results[backend];
        assert(results, `${backend}: no phase results`);
        /** @type {Array<number | null> | undefined} */
        let firstGeometry;
        for (const phase of Object.values(results)) {
            const where = `${backend}/${phase.id}`;
            const state = /** @type {NativeCapture} */ (phase.capture);
            /** @param {number | null} index */
            const meshAt = (index) => {
                const mesh = index === null ? undefined : state.meshes[index];
                assert(mesh, `${where}: the capture carries no mesh ${index}`);
                return mesh;
            };
            for (const draw of state.draws.filter(
                (entry) => entry.pipeline === "shader",
            )) {
                const packet = draw.uniforms.find((uniform) =>
                    uniform.type.startsWith("physics-debug-lines"),
                );
                assert(
                    packet,
                    `${where}: overlay ${draw.mesh} carries no physics-debug-lines packet`,
                );
                const mesh = meshAt(draw.mesh);
                for (let axis = 0; axis < 3; ++axis) {
                    assert(
                        Math.abs(
                            (packet.floats[28 + axis] ?? NaN) -
                                (mesh.position[axis] ?? NaN),
                        ) < 1e-6,
                        `${where}: overlay ${draw.mesh} packet position axis ${axis}`,
                    );
                }
                assert.deepEqual(
                    mesh.scaling,
                    [1, 1, 1],
                    `${where}: overlay ${draw.mesh} scaling`,
                );
            }
            for (const [body, overlay] of /** @type {const} */ ([
                [4, 5],
                [6, 7],
                [10, 11],
                [12, 13],
            ])) {
                assert.deepEqual(
                    meshAt(body).position,
                    meshAt(overlay).position,
                    `${where}: overlay ${overlay} detached from body ${body}`,
                );
                assert.deepEqual(
                    meshAt(body).rotationQuaternion,
                    meshAt(overlay).rotationQuaternion,
                    `${where}: overlay ${overlay} rotation detached from body ${body}`,
                );
            }
            assert.deepEqual(
                [4, 6, 8].map((index) => meshAt(index).geometry),
                [0, 0, 0],
                `${where}: clone geometry 0`,
            );
            assert.deepEqual(
                [10, 12, 14].map((index) => meshAt(index).geometry),
                [1, 1, 1],
                `${where}: clone geometry 1`,
            );
            const geometry = state.meshes.map((mesh) => mesh.geometry);
            firstGeometry ??= geometry;
            assert.deepEqual(
                geometry,
                firstGeometry,
                `${where}: geometry assignment changed between phases`,
            );
            details[where] = {
                overlays: state.draws.filter(
                    (entry) => entry.pipeline === "shader",
                ).length,
            };
        }
    }
    return { details };
}
