import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    goToFrame,
    loadGltf,
    onBeforeRender,
    pauseAnimation,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas =
        document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://playground.babylonjs.com/scenes/Alien/Alien.gltf",
        ),
    );

    const camera = createArcRotateCamera(
        Math.PI / 2,
        Math.PI / 2,
        2,
        { x: 0, y: 0, z: 0 },
    );
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(
        scene,
        createHemisphericLight([0, 1, 0], 0.7),
    );
    scene.fixedDeltaMs = 16;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
