import { createTexture2DFromPixels, type EngineContext } from "@babylonjs/lite";

export function paintPatch(engine: EngineContext, color: string) {
    const surface = document.createElement ("canvas");
    surface.width = 2;
    surface.height = 1;
    const brush = surface.getContext("2d")!;
    brush.fillStyle = color;
    brush.fillRect(0, 0, 2, 1);
    const captured = brush.getImageData(0, 0, 2, 1);
    const pixels = new Uint8Array(captured.data.buffer.slice(0));
    return createTexture2DFromPixels(engine, pixels, 2, 1);
}

let sharedColor = "red";
export function mutablePatch(engine: EngineContext, color: string) {
    const surface = document.createElement("canvas");
    surface.width = 2;
    surface.height = 1;
    const brush = surface.getContext("2d")!;
    brush.fillStyle = color || sharedColor;
    brush.fillRect(0, 0, 2, 1);
    const captured = brush.getImageData(0, 0, 2, 1);
    return createTexture2DFromPixels(engine, new Uint8Array(captured.data.buffer), 2, 1);
}
