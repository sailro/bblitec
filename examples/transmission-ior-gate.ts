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
        7,
        { x: 0, y: 0, z: 0 },
    );
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/studio.env",
        { skipSkybox: true, skipGround: true, brdfUrl: "/brdf-lut.png" },
    );

    const backdrop = createBox(engine, 4.5);
    backdrop.position.z = 1.8;
    backdrop.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.8, 0.2, 0.04),
        ormTexture: createSolidTexture2D(engine, 1, 0.7, 0),
        directIntensity: 0,
    });
    addToScene(scene, backdrop);

    const lowIor = createSphere(engine, { segments: 64, diameter: 2 });
    lowIor.position.set(-1.25, 0, -0.5);
    lowIor.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.08, 0),
        directIntensity: 0,
        transmissive: true,
        subsurface: {
            refraction: { intensity: 1, indexOfRefraction: 1.1 },
            thickness: { max: 1.2 },
        },
    });
    addToScene(scene, lowIor);

    const highIor = createSphere(engine, { segments: 64, diameter: 2 });
    highIor.position.set(1.25, 0, -0.5);
    highIor.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 1, 1, 1),
        ormTexture: createSolidTexture2D(engine, 1, 0.08, 0),
        directIntensity: 0,
        transmissive: true,
        subsurface: {
            refraction: { intensity: 1, indexOfRefraction: 1.8 },
            thickness: { max: 1.2 },
        },
    });
    addToScene(scene, highIor);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
