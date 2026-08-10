import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    enableSceneTransmission,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    enableSceneTransmission(scene, engine);

    const camera = createArcRotateCamera(
        1.9445,
        1.5454,
        0.1458,
        { x: 0.00098, y: 0.0013, z: -0.00713 },
    );
    camera.fov = 0.8;
    camera.nearPlane = 0.001458;
    camera.farPlane = 145.8;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://assets.babylonjs.com/meshes/MosquitoInAmber/glTF/MosquitoInAmber.gltf",
        ),
    );
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/studio.env",
        { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" },
    );
    scene.imageProcessing.exposure = 1;
    scene.imageProcessing.contrast = 1;

    const skybox = createBox(engine, 72.899271);
    skybox.position.set(-0.05222946, 0.00500239, 0.12856335);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.3, 1),
        environmentIntensity: 1,
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    addToScene(scene, skybox);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
