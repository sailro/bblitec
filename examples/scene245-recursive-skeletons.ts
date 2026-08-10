import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    goToFrame,
    loadEnvironment,
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
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/RecursiveSkeletons/glTF/RecursiveSkeletons.gltf",
        ),
    );

    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1 };
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/environmentSpecular.env",
        {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        },
    );

    const camera = createArcRotateCamera(
        1.5707963,
        1.5707963,
        226.74,
        { x: 0, y: 62.55, z: 0 },
    );
    camera.fov = 0.8;
    camera.nearPlane = 226.74 * 0.01;
    camera.farPlane = 226.74 * 1000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    scene.fixedDeltaMs = 16;

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
