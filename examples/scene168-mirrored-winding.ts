import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1.0 };

    const camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2,
        6,
        { x: 0, y: 0, z: 0 },
    );
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;

    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
        {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        },
    );
    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/7184feda683072980735f9a180e6f567ee5717ba/lab/public/gltf-assets/MirroredDoubleSided/MirroredDoubleSided.gltf",
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
