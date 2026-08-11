import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    registerScene,
    startEngine,
    type SceneContext,
} from "@babylonjs/lite";

function configureImageProcessing(
    scene: SceneContext,
    requestedExposure: number,
): void {
    const exposure = requestedExposure;
    if (requestedExposure > 1) {
        const exposure = 1;
        scene.imageProcessing.exposure = exposure;
    } else {
        const exposure = requestedExposure;
        scene.imageProcessing.exposure = exposure;
    }
    scene.imageProcessing.contrast = exposure;
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(
        0,
        1.2,
        4,
        [0, 0, 0],
    );
    const sphere = createSphere(engine, {
        diameter: 2,
    });
    const material = createStandardMaterial();
    material.diffuseColor = [0.2, 0.45, 0.9];
    sphere.material = material;
    addToScene(scene, sphere);
    configureImageProcessing(scene, 1.25);
    registerScene(scene);
    await startEngine(engine);
}
