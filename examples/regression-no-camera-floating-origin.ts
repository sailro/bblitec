// Regression gate: a floating-origin scene whose camera is never made active.
//
// The camera exists but `scene.camera` is never assigned. The pin draws
// nothing through the scene pass without an active camera
// (`_writePassSceneUBO` returns before writing the scene block) and derives
// a zero floating-origin offset (`getFloatingOriginOffset`). The golden is
// therefore the clear colour alone: a lit box here means a camera pose was
// supplied that the source never asked for.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createArcRotateCamera,
    createHemisphericLight,
    createBox,
    createStandardMaterial,
    registerScene,
} from "babylon-lite";

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { useHighPrecisionMatrix: true, useFloatingOrigin: true });
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 3, 8, { x: 0, y: 0, z: 0 });
    canvas.dataset.cameraFov = String(camera.fov);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
    const box = createBox(engine, { size: 2 });
    box.material = createStandardMaterial();
    addToScene(scene, box);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
