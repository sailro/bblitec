// Regression gate: enableGeometryVelocity in a geometry renderer task.
//
// A PBR box slides and turns, a skinned beam bends and a morphed beam swells
// (the ambient-occlusion demo's own procedural glTF), beside a still sphere,
// shown through the velocity regressions' shared view.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSphere,
    enableGeometryVelocity,
    onBeforeRender,
    playAnimation,
    registerScene,
    startEngine,
} from "babylon-lite";
import { createAoDeformationExamples } from "../corpus/babylon-lite/lab/lite/src/demos/ambient-occlusion-deformation.js";
import { addVelocityView, createVelocityTask } from "./regression-geometry-velocity-view.js";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.1, g: 0.1, b: 0.12, a: 1 };
    const camera = createArcRotateCamera(-Math.PI / 2, 1.2, 8, { x: -0.4, y: 0.8, z: -0.3 });
    camera.nearPlane = 0.1;
    camera.farPlane = 40;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight([0, 1, -0.4], 1));

    const box = createBox(engine, { size: 0.9 });
    box.position.y = 0.6;
    box.material = createPbrMaterial({ baseColorFactor: [0.8, 0.35, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.7 });
    addToScene(scene, box);
    const sphere = createSphere(engine, { diameter: 1, segments: 24 });
    sphere.position.x = -2.2;
    sphere.position.y = 0.5;
    sphere.position.z = 1.2;
    sphere.material = createPbrMaterial({ baseColorFactor: [0.2, 0.4, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.6 });
    addToScene(scene, sphere);

    const examples = await createAoDeformationExamples(engine);
    addToScene(scene, examples);
    for (const group of examples.animationGroups ?? []) {
        group.loopAnimation = true;
        playAnimation(group);
    }

    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        box.position.x = 1.2 + Math.sin(frame * 0.07) * 1.4;
        box.rotation.y = frame * 0.05;
    });

    const geometry = createVelocityTask(engine, scene);
    enableGeometryVelocity(geometry, { previousDepth: true });
    addVelocityView(engine, scene, geometry);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
