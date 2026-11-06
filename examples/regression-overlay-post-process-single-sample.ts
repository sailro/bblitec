// An overlay over a root that presents through a black-and-white pass, at
// one sample: the overlay loads the swapchain after the root's whole frame
// graph, so its sphere stays in colour over the processed scene.
import { createEngine, registerScene, startEngine } from "@babylonjs/lite";
import { addBlackAndWhitePass, createOverlayRoot, createOverlaySphere } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 1 });
    const { root, box } = createOverlayRoot(engine);
    addBlackAndWhitePass(engine, root, box, { x: 0, y: 0, width: 1, height: 1 });
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
