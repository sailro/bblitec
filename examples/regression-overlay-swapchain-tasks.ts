// An overlay over a root whose own frame graph writes the swapchain: the
// root's scene pass resolves into it, then a black-and-white pass rewrites
// its left half. At MSAA the overlay composites into that scene pass's
// multisample colour after the whole graph and resolves it into the
// swapchain again, so the frame shows the scene in colour under the overlay.
import { addMeshToTask, addTask, createEngine, createRenderTarget, createRenderTask, registerScene, startEngine } from "@babylonjs/lite";
import { addBlackAndWhitePass, createOverlayRoot, createOverlaySphere } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const { root, box } = createOverlayRoot(engine);
    const sceneTarget = createRenderTarget({
        lbl: "overlay-root-scene",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: 4,
        size: engine,
    });
    const sceneTask = createRenderTask({ name: "overlay-root-scene", rt: sceneTarget, rst: engine.scRT, clrColor: root.clearColor, clr: true }, engine, root);
    addMeshToTask(sceneTask, box);
    addTask(root, sceneTask);
    addBlackAndWhitePass(engine, root, box, { x: 0, y: 0, width: 0.5, height: 1 });
    const overlay = createOverlaySphere(engine, root);
    await registerScene(root);
    await registerScene(overlay);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
