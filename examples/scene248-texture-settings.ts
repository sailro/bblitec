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

    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/TextureSettingsTest/glTF/TextureSettingsTest.gltf",
        ),
    );
    scene.clearColor = { r: 0.2, g: 0.2, b: 0.3, a: 1.0 };
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
        21.64,
        { x: 0, y: -0.583, z: -0.025 },
    );
    camera.fov = 0.8;
    camera.nearPlane = 21.64 * 0.01;
    camera.farPlane = 21.64 * 1000;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
