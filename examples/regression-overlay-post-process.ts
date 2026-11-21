// An overlay over a root that presents through a black-and-white pass, at
// MSAA: the overlay writes back to the source after presentation, so it
// does not overwrite the processed swapchain image.
import { createEngine } from "@babylonjs/lite";
import { startOverlayOverPostProcess } from "./regression-overlay-root.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    await startOverlayOverPostProcess(await createEngine(canvas), false);
    canvas.dataset.ready = "true";
}

main().catch((error) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.dataset.error = error instanceof Error ? error.message : String(error);
    console.error(error);
});
