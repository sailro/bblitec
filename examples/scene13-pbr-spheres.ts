import {
    addToScene,
    attachControl,
    createDefaultCamera,
    createEngine,
    createHemisphericLight,
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
        await loadGltf(engine, "https://assets.babylonjs.com/meshes/PBR_Spheres.glb"),
    );
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/core/environments/environmentSpecular.env",
        {
            groundTextureUrl:
                "https://assets.babylonjs.com/core/environments/backgroundGround.png",
            skipSkybox: true,
            brdfUrl: "/brdf-lut.png",
        },
    );

    const camera = createDefaultCamera(scene);
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
