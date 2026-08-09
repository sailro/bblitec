import {
    addToScene,
    attachControl,
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
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };

    const camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.15,
        10.5,
        { x: 0.35, y: -1.9, z: 0 },
    );
    camera.nearPlane = 0.1;
    camera.farPlane = 1000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

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
            "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/7184feda683072980735f9a180e6f567ee5717ba/lab/public/gltf-assets/NegativeScaleTest/NegativeScaleTest.glb",
        ),
    );

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
