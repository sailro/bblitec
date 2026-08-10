import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createPbrMaterial,
    createPointLight,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    loadHdrEnvironment,
    registerScene,
    startEngine,
} from "@babylonjs/lite";
import type { ArcRotateCamera } from "@babylonjs/lite";

// Pinned Babylon Lite scene 8, matching Babylon Playground #19JGPR#13.
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 4,
        Math.PI / 2.5,
        200,
        { x: 0, y: 0, z: 0 },
    );
    scene.camera.nearPlane = 0.1;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    addToScene(scene, createPointLight([0, 40, 0]));

    await loadHdrEnvironment(
        scene,
        "https://playground.babylonjs.com/textures/room.hdr",
        {
            faceSize: 512,
            useCubemapSkybox: true,
            skipGround: true,
            skyboxSize: 415.6922,
            skyboxPosition: [0, -40.00001, 0],
        },
    );
    scene.imageProcessing.exposure = 0.66;
    scene.imageProcessing.contrast = 1.66;

    const baseColorTexture = createSolidTexture2D(
        engine,
        0.95,
        0.95,
        0.95,
        1,
    );
    const ormTexture = createSolidTexture2D(engine, 1, 0, 0);
    const sphere = createSphere(engine, { segments: 48, diameter: 80 });
    sphere.material = createPbrMaterial({
        baseColorTexture,
        ormTexture,
        alpha: 0.5,
        environmentIntensity: 0.7,
        directIntensity: 0,
        reflectance: 0.2,
    });
    addToScene(scene, sphere);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
