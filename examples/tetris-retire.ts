// Project-owned differential gate: the demo renderer's per-frame camera
// contracts and its particle retirement path. A scripted tape clamps the
// camera every frame the way tetris/renderer.ts sync() does (radius,
// beta, and alpha bounds), shakes the camera target through its x/y
// components with the demo's decaying two-sinusoid model, and retires
// spark meshes with removeFromScene as their lifetimes expire — the
// TetrisParticles.update() contract without its class layer. Both the
// shake and the retirements settle before the capture frame, so the
// measured image is the terminal state of a scene that removed meshes
// at runtime.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createDirectionalLight,
    createSceneContext,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    removeFromScene,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera, Mesh } from "babylon-lite";
import {
    PIECE_COLORS,
} from "../corpus/babylon-lite/lab/lite/src/demos/tetris/pieces.js";

// The demo's camera bounds (tetris/renderer.ts sync()).
const RADIUS_MIN = 12;
const RADIUS_MAX = 20;
const BETA_MIN = Math.PI * 0.32;
const BETA_MAX = Math.PI * 0.62;
const ALPHA_BASE = Math.PI / 2 + 0.04;
const ALPHA_RANGE = 0.45;

const SHAKE_FRAMES = 12;
const RETIRE_START = 4;
const READY_FRAME = 40;

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    // Deliberately outside every clamp bound: the per-frame clamping is
    // what pulls the camera into the framed pose the golden measures.
    const camera = createArcRotateCamera(
        ALPHA_BASE + 1.4,
        Math.PI * 0.15,
        40,
        { x: 0, y: 0.5, z: 0 },
    );
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.75),
    );
    addToScene(
        scene,
        createDirectionalLight([0.22, -0.5, -0.84], 1.4),
    );

    // The surviving row: one block per piece color, added once and
    // never removed.
    for (let column = 0; column < 7; column++) {
        const block = createBox(engine, 0.8);
        block.position.set(column - 3, 1.6, 0);
        const material = createStandardMaterial();
        const color = PIECE_COLORS[column]!;
        material.diffuseColor = [
            color[0],
            color[1],
            color[2],
        ];
        block.material = material;
        addToScene(scene, block);
    }

    // The retiring row: each spark leaves the scene on its own frame,
    // so the terminal image is the survivors alone.
    function createSpark(column: number): Mesh {
        const spark = createBox(engine, 0.8);
        spark.position.set(column - 3, 0, 0);
        const material = createStandardMaterial();
        const color = PIECE_COLORS[column]!;
        material.diffuseColor = [
            color[0] * 0.6,
            color[1] * 0.6,
            color[2] * 0.6,
        ];
        spark.material = material;
        addToScene(scene, spark);
        return spark;
    }

    const spark0 = createSpark(0);
    const spark1 = createSpark(1);
    const spark2 = createSpark(2);
    const spark3 = createSpark(3);
    const spark4 = createSpark(4);
    const spark5 = createSpark(5);
    const spark6 = createSpark(6);

    let frame = 0;
    onBeforeRender(scene, () => {
        // Clamp every frame like the demo: attachControl writes inertial
        // offsets before render, so the bounds are re-applied per frame
        // rather than once at setup.
        if (camera.radius < RADIUS_MIN) camera.radius = RADIUS_MIN;
        if (camera.radius > RADIUS_MAX) camera.radius = RADIUS_MAX;
        if (camera.beta < BETA_MIN) camera.beta = BETA_MIN;
        if (camera.beta > BETA_MAX) camera.beta = BETA_MAX;
        if (camera.alpha < ALPHA_BASE - ALPHA_RANGE) {
            camera.alpha = ALPHA_BASE - ALPHA_RANGE;
        }
        if (camera.alpha > ALPHA_BASE + ALPHA_RANGE) {
            camera.alpha = ALPHA_BASE + ALPHA_RANGE;
        }

        // Camera shake through the target's components, decaying to
        // exactly the resting target once the tape ends.
        if (frame < SHAKE_FRAMES) {
            const remaining =
                (SHAKE_FRAMES - frame) / SHAKE_FRAMES;
            const amplitude = 0.35 * remaining * remaining;
            camera.target.x =
                Math.sin(frame * 1.7) * amplitude;
            camera.target.y =
                0.5 + Math.cos(frame * 1.3) * amplitude;
        } else {
            camera.target.x = 0;
            camera.target.y = 0.5;
        }

        // Retire one spark per frame; every removal bumps the scene's
        // mesh membership and rebuilds the native render plan. The
        // middle sparks go first so the surviving entries straddle a
        // dropped range on both sides.
        if (frame === RETIRE_START) removeFromScene(scene, spark3);
        if (frame === RETIRE_START + 1) removeFromScene(scene, spark0);
        if (frame === RETIRE_START + 2) removeFromScene(scene, spark6);
        if (frame === RETIRE_START + 3) removeFromScene(scene, spark4);
        if (frame === RETIRE_START + 4) removeFromScene(scene, spark1);
        if (frame === RETIRE_START + 5) removeFromScene(scene, spark5);
        if (frame === RETIRE_START + 6) removeFromScene(scene, spark2);

        frame++;
        if (frame === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
