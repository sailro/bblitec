import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 6, { x: 0, y: 0.5, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const box = createBox(engine, 1);
    box.position.set(0, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    ground.material = groundMat;
    addToScene(scene, ground);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
