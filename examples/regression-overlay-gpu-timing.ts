// An overlay under GPU task timing: each registered scene renders through
// its own scene task, so the overlay's task composites into its root's multisample
// colour after the root's whole frame graph and resolves it into the
// swapchain again.
import { createEngine, registerScene, setRenderTaskGpuTimingEnabled, startEngine } from "@babylonjs/lite";
import { createOverlayRoot, createOverlaySphere } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const { root } = createOverlayRoot(engine, true);
    const overlay = createOverlaySphere(engine, root);
    await registerScene(root);
    await registerScene(overlay);
    await setRenderTaskGpuTimingEnabled(engine, true);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
