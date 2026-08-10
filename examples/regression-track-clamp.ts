import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    goToFrame,
    loadGltf,
    onBeforeRender,
    pauseAnimation,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

    const camera = createArcRotateCamera(
        Math.PI / 2,
        Math.PI / 2,
        3,
        { x: 1, y: 0, z: 0 },
    );
    scene.camera = camera;

    addToScene(
        scene,
        await loadGltf(
            engine,
            "../examples/assets/regression/track-clamp.gltf",
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
