// Project-owned differential gate: the CSM static-caster cache's coverage refit.
//
// Scene 214's torus-knot field under a stabilized four-cascade generator with
// a world-space bias, and enableCsmStaticCache with a cascadeCoveragePadding:
// a camera pose change does not refit, each cascade keeps its published map
// until the camera's slice leaves it. The camera orbits and the light drifts
// a little every frame, so a drift refit spreads over frames while cascades
// leaving coverage re-render outside that budget. The capture lands well
// after the first demotion.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCsmDirectionalShadowGenerator,
    createDirectionalLight,
    createEngine,
    createGround,
    createSceneContext,
    createStandardMaterial,
    createTorusKnot,
    enableCsmStaticCache,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import type { Mesh } from "babylon-lite";

const SCENE_SIZE = 2000;
const NUM_CASTERS = 200;
const PRNG_SEED = 1337;

/** Deterministic mulberry32 PRNG, scene 214's draw order. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Euler (Babylon YawPitchRoll: yaw=y, pitch=x, roll=z) to quaternion [x,y,z,w]. */
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
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.5, g: 0.6, b: 0.75, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, SCENE_SIZE * 1.1, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    attachControl(camera, canvas, scene);

    const light = createDirectionalLight([0, -1, -1], 0.8);
    addToScene(scene, light);

    const ground = createGround(engine, { width: SCENE_SIZE, height: SCENE_SIZE });
    ground.receiveShadows = true;
    const groundMat = createStandardMaterial();
    ground.material = groundMat;

    const knotMat = createStandardMaterial();
    knotMat.diffuseColor = [0, 1, 0];

    // Non-caster base knot at the origin.
    const base = createTorusKnot(engine, { radius: 20, tube: 5 });
    base.material = knotMat;
    addToScene(scene, base);

    const rand = mulberry32(PRNG_SEED);
    const casters: Mesh[] = [];
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
        casters.push(knot);
    }

    // The map and its cascade count are a run-time choice, as a quality tier is.
    const tier = casters.length > 100 ? { mapSize: 1024, cascades: 4 } : { mapSize: 512, cascades: 2 };
    // Both arrive through conditional spreads, as a scene reading them off its configuration writes them.
    const worldSpaceBias = casters.length > 0 ? 2 : 0;
    const coveragePadding = casters.length > 0 ? 0.125 : 0;
    light.shadowGenerator = createCsmDirectionalShadowGenerator(engine, light, {
        mapSize: tier.mapSize,
        numCascades: tier.cascades,
        lambda: 0.5,
        cascadeBlendPercentage: 0.1,
        stabilizeCascades: true,
        bias: 0.00005,
        ...(worldSpaceBias > 0 ? { worldSpaceBias } : {}),
    });
    setShadowTaskCasterMeshes(light.shadowGenerator, casters);
    await enableCsmStaticCache(engine, light.shadowGenerator, {
        refitAngle: 0.01,
        staticCascadesPerFrame: 1,
        ...(coveragePadding > 0 ? { cascadeCoveragePadding: coveragePadding } : {}),
    });

    addToScene(scene, ground);

    const mover = casters[0]!;
    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        mover.position.set(-500 + (frame % 200) * 5, 120, 0);
        // The orbit and the dolly move every slice; the light drifts past the refit angle every few frames.
        camera.alpha = -Math.PI / 2 + frame * 0.004;
        camera.radius = SCENE_SIZE * (1.1 - (frame % 120) * 0.004);
        light.direction.set(Math.sin(frame * 0.003), -1, -Math.cos(frame * 0.003));
    });

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
