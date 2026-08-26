import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        2.6,
        { x: 0, y: 0, z: 0 },
    );

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    addToScene(
        scene,
        await loadGltf(
            engine,
            "../examples/assets/regression/gltf-sparse.gltf",
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
