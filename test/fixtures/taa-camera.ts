import {
    addTask, addTaskAtStart, addToScene, attachControl, createArcRotateCamera,
    createBox, createEngine, createHemisphericLight, createRenderTarget,
    createRenderTask, createSceneContext, createStandardMaterial,
    createTaaPostProcessTask, registerScene, startEngine,
} from "@babylonjs/lite";

// The corpus TAA scene freezes without camera controls. This separate live
// fixture exercises camera invalidation, accumulation recovery and resize.
async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    scene.clearColor = { r: .05, g: .06, b: .09, a: 1 };
    const camera = createArcRotateCamera(-1, 1, 7, { x: 0, y: 0, z: 0 });
    camera.nearPlane = .1;
    camera.farPlane = 100;
    scene.camera = camera;
    attachControl(camera, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0]));
    const box = createBox(engine, 2);
    const material = createStandardMaterial();
    material.diffuseColor = [.85, .32, .22];
    material.specularColor = [0, 0, 0];
    box.material = material;
    box.rotationQuaternion.set(.25, .25, .25, Math.sqrt(1 - 3 * .25 * .25));
    addToScene(scene, box);
    const target = createRenderTarget({
        lbl: "taa-camera-source", format: engine.format,
        dFormat: "depth24plus-stencil8", samples: 1, size: engine,
    });
    const source = createRenderTask({ name: "taa-camera-source", rt: target, clrColor: scene.clearColor, clr: true }, engine, scene);
    addTaskAtStart(scene, source);
    const taa = createTaaPostProcessTask({
        name: "taa-camera", sourceTexture: target, sourceRenderTask: source,
        targetTexture: engine.scRT, factor: .05, samples: 8,
    }, engine, scene);
    addTask(scene, taa);
    await registerScene(scene);
    taa.updateUniforms();
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main();
