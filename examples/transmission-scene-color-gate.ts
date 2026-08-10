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
    enableSceneTransmission,
    loadEnvironment,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    enableSceneTransmission(scene, engine);
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

    const backdrop = createBox(engine, 2.4);
    backdrop.position.z = 1.2;
    backdrop.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.05, 0.35, 0.9),
        ormTexture: createSolidTexture2D(engine, 1, 0.65, 0),
        directIntensity: 0,
    });
    addToScene(scene, backdrop);

    const glass = createSphere(engine, { segments: 64, diameter: 2.2 });
    glass.position.z = -0.6;
    glass.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.08, 0),
        directIntensity: 0,
        transmissive: true,
        subsurface: { refraction: { intensity: 1 } },
    });
    addToScene(scene, glass);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
