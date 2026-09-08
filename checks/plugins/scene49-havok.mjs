// Scene 49: the proximity and cast markers, recomputed by the pinned Havok
// WASM from each capture's cylinder transforms. The scene queries a
// cylinder against two static capsules (proximity) and casts it between
// two points; the markers are the hit points nudged toward the camera
// (0.08 for the proximity pair, 0.2 for the cast hit) along
// (0, 0.5, -0.866). Every native phase's markers must sit within 0.005
// of the recomputed points, and the idle phase must hold the baseline's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import HavokPhysics from "@babylonjs/havok";
import { maxError } from "./support.mjs";

export async function check(context) {
    const require = createRequire(import.meta.url);
    const hp = await HavokPhysics({ wasmBinary: new Uint8Array(readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"))).buffer });
    const world = hp.HP_World_Create()[1];
    const collector = hp.HP_QueryCollector_Create(1)[1];
    const cylinder = hp.HP_Shape_CreateCylinder([0, -1, 0], [0, 1, 0], 0.5)[1];
    const capsule = hp.HP_Shape_CreateCapsule([0, -0.5, 0], [0, 0.5, 0], 0.5)[1];
    const bodies = [2.5, -2.5].map((y) => {
        const body = hp.HP_Body_Create()[1];
        hp.HP_Body_SetShape(body, capsule);
        hp.HP_Body_SetMotionType(body, hp.MotionType.STATIC);
        hp.HP_Body_SetQTransform(body, [[1, y, 0], [0, 0, 0, 1]]);
        hp.HP_World_AddBody(world, body, false);
        return body;
    });
    hp.HP_World_Step(world, 1 / 60);
    const nudge = (p, n) => [p[0], p[1] + n * 0.5, p[2] - n * 0.866];
    const details = {};
    try {
        for (const backend of context.backends) {
            const markersByPhase = new Map();
            for (const phase of Object.values(context.results[backend])) {
                const where = `${backend}/${phase.id}`;
                const state = phase.capture;
                hp.HP_World_ShapeProximityWithCollector(world, collector, [cylinder, state.meshes[0].position, state.meshes[0].rotationQuaternion, 10, false, [0n]]);
                assert.equal(hp.HP_QueryCollector_GetNumHits(collector)[1], 1, `${where}: proximity hits`);
                const proximity = hp.HP_QueryCollector_GetShapeProximityResult(collector, 0)[1];
                hp.HP_World_ShapeCastWithCollector(world, collector, [cylinder, state.meshes[4].rotationQuaternion, [-1, -2.5, 0], [4, -2.5, 0], false, [0n]]);
                assert.equal(hp.HP_QueryCollector_GetNumHits(collector)[1], 1, `${where}: cast hits`);
                const cast = hp.HP_QueryCollector_GetShapeCastResult(collector, 0)[1];
                const expected = [nudge(proximity[1][3], 0.08), nudge(proximity[2][3], 0.08), nudge(cast[2][3], 0.2)];
                const markers = [2, 3, 7].map((index) => state.meshes[index].position);
                const errors = markers.map((marker, index) => maxError(marker, expected[index]));
                assert(Math.max(...errors) < 0.005, `${where}: marker error ${Math.max(...errors)}`);
                markersByPhase.set(phase.id, markers);
                details[where] = { markerErrors: errors };
            }
            if (markersByPhase.has("idle") && markersByPhase.has("baseline")) {
                assert.deepEqual(markersByPhase.get("idle"), markersByPhase.get("baseline"), `${backend}: idle moved the markers`);
            }
        }
    } finally {
        for (const body of bodies) {
            hp.HP_World_RemoveBody(world, body);
            hp.HP_Body_Release(body);
        }
        hp.HP_Shape_Release(cylinder);
        hp.HP_Shape_Release(capsule);
        hp.HP_QueryCollector_Release(collector);
        hp.HP_World_Release(world);
    }
    return { details };
}
