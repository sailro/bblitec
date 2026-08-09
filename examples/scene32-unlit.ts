import {
    addToScene,
    attachControl,
    createDefaultCamera,
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
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/UnlitTest/glTF-Binary/UnlitTest.glb",
        ),
    );
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/environmentSpecular.env",
        {
            skipSkybox: true,
            skipGround: true,
            brdfUrl: "/brdf-lut.png",
        },
    );

    const camera = createDefaultCamera(scene);
    camera.alpha += Math.PI;
    attachControl(camera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
