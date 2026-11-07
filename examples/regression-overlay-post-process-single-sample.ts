// An overlay over a root that presents through a black-and-white pass, at
// one sample: the overlay loads the swapchain after the root's whole frame
// graph, so its sphere stays in colour over the processed scene.
import { createEngine } from "@babylonjs/lite";
import { startOverlayOverPostProcess } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await startOverlayOverPostProcess(await createEngine(canvas, { msaaSamples: 1 }));
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
