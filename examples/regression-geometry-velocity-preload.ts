// Regression gate: Standard velocity loaded by the geometry task's preload.
//
// No enableGeometryVelocity: a Standard box slides and turns, a Standard
// skinned beam bends and a Standard morphed sphere swells in a
// LINEAR_VELOCITY task, whose preload at registration finds the deformed
// meshes and loads the deformation velocity feature. A second morphed sphere
// created after registration composes from the loaded feature too.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    enableStandardSkeleton,
    registerScene,
    startEngine,
} from "babylon-lite";
import { addBendingBeam, addSlidingBox, addSwellingSphere, standard } from "./regression-geometry-velocity-standard-meshes.js";
import { addVelocityView, createVelocityTask } from "./regression-geometry-velocity-view.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.1, g: 0.1, b: 0.12, a: 1 };
    enableStandardSkeleton();
    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 8, { x: -0.4, y: 0.8, z: -0.3 });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, -0.4], 1));

    addSlidingBox(engine, scene, standard(0.8, 0.35, 0.1), 0.9, 1.2, 0.6, 0, 0.07, 1.4, true);
    addBendingBeam(engine, scene, -2.6);
    addSwellingSphere(engine, scene, standard(0.55, 0.16, 0.55), -0.6, 0.6, -1.4);
    addVelocityView(engine, scene, createVelocityTask(engine, scene));

    await registerScene(scene);
    addSwellingSphere(engine, scene, standard(0.3, 0.6, 0.7), 1.4, 1.9, 0.8);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
