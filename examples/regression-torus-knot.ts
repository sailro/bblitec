// Project-owned differential gate for `createTorusKnot`: corpus scene 214's
// knot field with the shadow generator removed.
//
// Scene 214 renders 200 seeded torus knots over a 2000-unit ground under a
// 4-cascade CSM directional light, and this port retains only the pin's FIRST
// camera-fitted cascade (`csm-single-map-near-cascade`). At that camera the
// first cascade ends at a view depth of 1255 while the ground starts past
// 1400, so scene 214's ground carries no native shadow at all and its parity
// number is entirely the missing cascades. That makes 214 unusable as a gate
// for the geometry it is otherwise a perfect exercise of.
//
// So this file is scene 214 with exactly one thing taken away — the
// generator, its caster list, `receiveShadows`, and the shadow-aware
// registration — and nothing else touched: the same camera, the same clear
// colour, the same mulberry32 draw order, the same YawPitchRoll quaternions,
// the same shared green Standard material, the same 2000-unit ground. What is
// left is 201 torus knots and a lit ground, so a non-zero measurement here is
// the builder, the curve's Frenet frame, or `computeNormals` — never the
// shadow adaptation.
//
// Keep it byte-comparable with `corpus/.../scene214.ts`: the two differ only
// by the removals above, which is what makes the pair a bisect.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createTorusKnot,
    createGround,
    createDirectionalLight,
    createStandardMaterial,
    attachControl,
    registerScene,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

const SCENE_SIZE = 2000;
const NUM_CASTERS = 200;
const PRNG_SEED = 1337;

/** Deterministic mulberry32 PRNG — same algorithm/seed/draw-order as scene 214. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Euler (Babylon YawPitchRoll: yaw=y, pitch=x, roll=z) → quaternion [x,y,z,w]. */
function quatFromEuler(ex: number, ey: number, ez: number): [number, number, number, number] {
    const hr = ez * 0.5,
        hp = ex * 0.5,
        hy = ey * 0.5;
    const sr = Math.sin(hr),
        cr = Math.cos(hr),
        sp = Math.sin(hp),
        cp = Math.cos(hp),
        sy = Math.sin(hy),
        cy = Math.cos(hy);
    return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.5, g: 0.6, b: 0.75, a: 1 };

    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, SCENE_SIZE * 1.1, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 1;
    scene.camera.farPlane = 10000;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    const light = createDirectionalLight([0, -1, -1], 0.8);
    addToScene(scene, light);

    const ground = createGround(engine, { width: SCENE_SIZE, height: SCENE_SIZE });
    const groundMat = createStandardMaterial();
    ground.material = groundMat;

    const knotMat = createStandardMaterial();
    knotMat.diffuseColor = [0, 1, 0];

    const base = createTorusKnot(engine, { radius: 20, tube: 5 });
    base.material = knotMat;
    addToScene(scene, base);

    const rand = mulberry32(PRNG_SEED);
    for (let i = 0; i < NUM_CASTERS; i++) {
        const px = (rand() - 0.5) * SCENE_SIZE;
        const py = rand() * SCENE_SIZE * 0.25 + 1;
        const pz = (rand() - 0.5) * SCENE_SIZE;
        const ex = rand() * 3.14;
        const ey = rand() * 3.14;
        const ez = rand() * 3.14;

        const knot = createTorusKnot(engine, { radius: 20, tube: 5 });
        knot.material = knotMat;
        knot.position.set(px, py, pz);
        const [qx, qy, qz, qw] = quatFromEuler(ex, ey, ez);
        knot.rotationQuaternion.set(qx, qy, qz, qw);
        addToScene(scene, knot);
    }

    addToScene(scene, ground);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
