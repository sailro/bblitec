import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createSphere,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const baseColorTex = createSolidTexture2D(engine, 1.0, 0.766, 0.336);
    const ormTex = createSolidTexture2D(engine, 1.0, 1.0, 0.0);
    const sphere = createSphere(engine, { segments: 16, diameter: 2 });
    sphere.material = createPbrMaterial({
        baseColorTexture: baseColorTex,
        ormTexture: ormTex,
    });
    addToScene(scene, sphere);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
