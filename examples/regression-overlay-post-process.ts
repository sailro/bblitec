// An overlay over a root that presents through a black-and-white pass, at
// MSAA: no render task of the root draws or resolves into the swapchain, so
// the overlay has no colour attachment to composite into and is skipped.
import { createEngine, registerScene, startEngine } from "@babylonjs/lite";
import { addBlackAndWhitePass, createOverlayRoot, createOverlaySphere } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
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
