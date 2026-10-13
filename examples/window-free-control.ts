import {
    addToScene,
    attachFreeControl,
    createBox,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

// A Window-realm program with the free camera's owned controls, as the
// Trogir demo has them: its "Retry" link navigates the document, which puts
// the program in an application realm. The `window-free-control` check drags
// on the canvas and holds W, and requires the camera to turn and to move.
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    const camera = createFreeCamera({ x: 0, y: 1, z: -8 }, { x: 0, y: 1, z: 0 });
    camera.speed = 0.8;
    camera.inertia = 0.6;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0]));
    const box = createBox(engine, 2);
    const material = createStandardMaterial();
    material.diffuseColor = [0.85, 0.32, 0.22];
    box.material = material;
    addToScene(scene, box);
    const retry = document.createElement("a");
    retry.href = "?retry=1";
    retry.textContent = "Retry";
    document.body.append(retry);
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main();
