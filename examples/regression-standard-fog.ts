// Regression gate: exponential scene fog on Standard-material meshes
// through the pinned std-fog contract (gamma-space blend on the final
// clamped color). Mirrors Scene 3's fog/light/box arrangement without
// its six-face image skybox so the Standard fog port gates
// independently of the loadSkybox port.

import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createPointLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    setFog,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(0.4, 1.2, 20, {
        x: -10,
        y: 0,
        z: 0,
    });
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;

    addToScene(scene, createPointLight([10, 50, 50]));

    setFog(scene, {
        mode: 1,
        density: 0.02,
        start: 0,
        end: 1000,
        color: [0.9, 0.9, 0.85],
    });

    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [1, 1, 0];

    for (let i = 0; i < 10; i++) {
        const box = createBox(engine);
        box.position.set(-i * 5, 0, 0);
        box.material = boxMat;
        addToScene(scene, box);
    }

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
