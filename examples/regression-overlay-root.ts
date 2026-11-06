// The overlay regressions' shared root: a scene drawing a box, without its
// default render task unless asked, and an overlay sphere over it.
import {
    addMeshToTask,
    addTask,
    addToScene,
    createArcRotateCamera,
    createBlackAndWhitePostProcessTask,
    createBox,
    createHemisphericLight,
    createOverlayScene,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSphere,
    createStandardMaterial,
    type EngineContext,
    type Mesh,
    type NormalizedViewport,
    registerScene,
    type SceneContext,
    startEngine,
} from "@babylonjs/lite";

/** The root scene and its box, which its own tasks draw without its default render task. */
export function createOverlayRoot(engine: EngineContext, defaultRenderTask = false): { root: SceneContext; box: Mesh } {
    const root = createSceneContext(engine, { defaultRenderTask });
    root.clearColor = { r: 0.1, g: 0.12, b: 0.2, a: 1 };
    root.camera = createArcRotateCamera(-Math.PI / 2, 1.1, 5, { x: 0, y: 0, z: 0 });
    addToScene(root, createHemisphericLight([0, 1, 0], 1));
    const box = createBox(engine, 1.6);
    box.rotation.y = 0.6;
    const material = createStandardMaterial();
    material.diffuseColor = [0.9, 0.35, 0.2];
    box.material = material;
    addToScene(root, box);
    return { root, box };
}

/** A black-and-white pass writing `viewport` of the swapchain from an offscreen draw of `box`. */
export function addBlackAndWhitePass(engine: EngineContext, root: SceneContext, box: Mesh, viewport: NormalizedViewport): void {
    const source = createRenderTarget({
        lbl: "overlay-root-source",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 1,
        size: engine,
    });
    const sourceTask = createRenderTask({ name: "overlay-root-source", rt: source, clrColor: root.clearColor, clr: true }, engine, root);
    addMeshToTask(sourceTask, box);
    addTask(root, sourceTask);
    addTask(
        root,
        createBlackAndWhitePostProcessTask(
            {
                name: "overlay-root-black-and-white",
                sourceTexture: source,
                targetTexture: engine.scRT,
                degree: 1,
                viewport,
                clear: false,
            },
            engine,
            root,
        ),
    );
}

/** An overlay of `root` holding one sphere, seen through the root's camera. */
export function createOverlaySphere(engine: EngineContext, root: SceneContext): SceneContext {
    const overlay = createOverlayScene(root);
    overlay.camera = root.camera;
    addToScene(overlay, createHemisphericLight([0, 1, 0], 1));
    const sphere = createSphere(engine, { diameter: 1 });
    sphere.position.set(-1.1, 0.4, -0.6);
    const material = createStandardMaterial();
    material.diffuseColor = [0.2, 0.8, 0.35];
    sphere.material = material;
    addToScene(overlay, sphere);
    return overlay;
}

/** The post-process regressions' frame: the root presents through a whole-surface black-and-white pass under an overlay sphere. */
export async function startOverlayOverPostProcess(engine: EngineContext): Promise<void> {
    const { root, box } = createOverlayRoot(engine);
    addBlackAndWhitePass(engine, root, box, { x: 0, y: 0, width: 1, height: 1 });
    const overlay = createOverlaySphere(engine, root);
    await registerScene(root);
    await registerScene(overlay);
    await startEngine(engine);
}
