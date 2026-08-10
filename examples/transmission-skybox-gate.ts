import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    loadEnvironment,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        6,
        { x: 0, y: 0, z: 0 },
    );
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/studio.env",
        { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" },
    );

    const skybox = createBox(engine, 80);
    skybox.position.set(0, 0, -6);
    skybox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.35, 1),
        directIntensity: 0,
        doubleSided: true,
        skyboxMode: true,
    });
    addToScene(scene, skybox);

    const sphere = createSphere(engine, { segments: 48, diameter: 2 });
    sphere.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.7, 0.15, 0.05),
        ormTexture: createSolidTexture2D(engine, 1, 0.35, 0),
        directIntensity: 0,
    });
    addToScene(scene, sphere);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
