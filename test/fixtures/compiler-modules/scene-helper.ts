import {
    addToScene,
    createDirectionalLight,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    type EngineContext,
    type SceneContext,
} from "@babylonjs/lite";
import { LIGHT_INTENSITY } from "./constants.js";

export function buildScene(
    engine: EngineContext,
): SceneContext {
    const scene = createSceneContext(engine);
    const sphere = createSphere(engine, {
        diameter: 2,
    });
    const material = createStandardMaterial();
    material.diffuseColor = [0.2, 0.4, 0.8];
    sphere.material = material;
    const light = createDirectionalLight(
        [0, -1, 0],
        LIGHT_INTENSITY,
    );
    addToScene(scene, sphere);
    addToScene(scene, light);
    return scene;
}

export function configureScene(
    scene: SceneContext,
    exposure = 1.25,
): void {
    scene.imageProcessing.exposure = exposure;
}
