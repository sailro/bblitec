// An overlay over a root that presents through a black-and-white pass, at
// MSAA: no render task of the root draws or resolves into the swapchain, so
// the overlay has no colour attachment to composite into and is skipped.
import { createEngine } from "@babylonjs/lite";
import { startOverlayOverPostProcess } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await startOverlayOverPostProcess(await createEngine(canvas));
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
