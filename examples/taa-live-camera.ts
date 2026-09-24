import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createStandardMaterial,
    createTaaPostProcessTask,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

// The corpus TAA scene (scene261) freezes after its accumulation and attaches
// no camera controls. This live fixture keeps the same source-task + TAA
// chain rendering with an attached camera, for the `taa-live-camera` check:
// camera invalidation, accumulation recovery and resize.
async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    const camera = createArcRotateCamera(-1, 1, 7, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0]));
    const box = createBox(engine, 2);
    const material = createStandardMaterial();
    material.diffuseColor = [0.85, 0.32, 0.22];
    material.specularColor = [0, 0, 0];
    box.material = material;
    box.rotationQuaternion.set(0.25, 0.25, 0.25, Math.sqrt(1 - 3 * 0.25 * 0.25));
    addToScene(scene, box);
    const target = createRenderTarget({
        lbl: "taa-camera-source",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const source = createRenderTask(
        { name: "taa-camera-source", rt: target, clrColor: scene.clearColor, clr: true },
        engine,
        scene,
    );
    addTaskAtStart(scene, source);
    const taa = createTaaPostProcessTask(
        {
            name: "taa-camera",
            sourceTexture: target,
            sourceRenderTask: source,
            targetTexture: engine.scRT,
            factor: 0.05,
            samples: 8,
        },
        engine,
        scene,
    );
    addTask(scene, taa);
    await registerScene(scene);
    taa.updateUniforms();
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main();
