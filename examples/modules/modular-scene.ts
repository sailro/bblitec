import {
    addToScene,
    createArcRotateCamera,
    createDirectionalLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    type EngineContext,
    type SceneContext,
} from "@babylonjs/lite";

const LIGHT_INTENSITY = 0.8;

export function buildModularScene(
    engine: EngineContext,
): SceneContext {
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
    const light = createDirectionalLight(
        [0, -1, 0],
        LIGHT_INTENSITY,
    );
    addToScene(scene, sphere);
    addToScene(scene, light);
    return scene;
}

export function setExposure(
    scene: SceneContext,
    exposure = 1.1,
): void {
    scene.imageProcessing.exposure = exposure;
}
