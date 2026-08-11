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

const SAMPLE_BONUSES = [1, 2, 3];

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
    let samples = 0;
    for (let index = 0; index < 3; index++) {
        samples += index;
    }
    let remaining = 2;
    while (remaining > 0) {
        samples += remaining;
        remaining--;
    }
    for (const bonus of SAMPLE_BONUSES) {
        samples += bonus;
    }
    scene.fixedDeltaMs = samples;
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
