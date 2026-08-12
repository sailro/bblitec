// Regression gate: storage-buffer morphing composed with the requested
// environment ground. The shared material vertex stage statically binds
// the morph storage buffers whenever the uncapped morph path is
// compiled in, so the background draws must bind the empty morph
// buffers (Dawn group 0) and an identity deformation block.

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

    addToScene(
        scene,
        await loadGltf(
            engine,
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/MorphStressTest/glTF/MorphStressTest.gltf",
        ),
    );
    await loadEnvironment(
        scene,
        "https://assets.babylonjs.com/environments/environmentSpecular.env",
        {
            groundTextureUrl:
                "https://assets.babylonjs.com/core/environments/backgroundGround.png",
            skipSkybox: true,
            brdfUrl: "/brdf-lut.png",
        },
    );

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.8, 6, {
        x: 0,
        y: 1,
        z: 0,
    });
    scene.camera = camera;

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
