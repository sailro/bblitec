// Regression gate: EXT_mesh_gpu_instancing composed with the requested
// environment ground. The shared material vertex stage consumes the
// per-instance attribute stream and instance uniforms whenever
// instancing is compiled in, so the background ground draw must bind
// an identity instance stream on both GPU backends.

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
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/SimpleInstancing/glTF-Binary/SimpleInstancing.glb",
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

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2.6, 18, {
        x: -3,
        y: 2,
        z: 0,
    });
    scene.camera = camera;

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
