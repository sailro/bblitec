// Adapted from Babylon Lite scene273.ts at
// 7184feda683072980735f9a180e6f567ee5717ba.
// The one-shot frame checks are equivalent to the upstream added flag because
// frame increases exactly once per onBeforeRender callback.
import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    onBeforeRender,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

const ADD_FRAME = 20;
const SETTLE_FRAMES = 150;

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    scene.fixedDeltaMs = 16;

    const camera = createArcRotateCamera(
        -Math.PI / 2,
        1.1,
        6,
        { x: 0, y: 0.9, z: 0 },
    );
    camera.nearPlane = 0.1;
    camera.farPlane = 50;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const box = createBox(engine, 1);
    box.position.set(-1.2, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    boxMat.specularColor = [0, 0, 0];
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    groundMat.specularColor = [0, 0, 0];
    ground.material = groundMat;
    addToScene(scene, ground);

    const pbrBox = createBox(engine, 1);
    pbrBox.position.set(1.2, 0.5, 0);
    pbrBox.material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.2, 0.6, 1.0, 1),
        ormTexture: createSolidTexture2D(engine, 1.0, 1.0, 1.0, 1),
        metallicFactor: 0.1,
        roughnessFactor: 0.4,
        directIntensity: 1.0,
        environmentIntensity: 0.0,
    });

    let frame = 0;
    onBeforeRender(scene, () => {
        frame++;
        if (frame === ADD_FRAME) {
            addToScene(scene, pbrBox);
            canvas.dataset.added = "true";
        }
        if (frame === ADD_FRAME + SETTLE_FRAMES) {
            canvas.dataset.drawCalls = String(engine.drawCallCount);
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.loaded = "true";
}

main().catch(console.error);
