/**
 * A producer that memoizes through ANOTHER module's state: the write goes
 * through an imported binding, which is module-scope state all the same.
 */
import type { EngineContext, Texture2D } from "@babylonjs/lite";
import { createTexture2DFromPixels } from "@babylonjs/lite";
import { sharedTiles } from "./shared-state.js";

export function createImportCachedTile(engine: EngineContext): Texture2D {
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 2, 2).data;
    const tile = createTexture2DFromPixels(engine, new Uint8Array(data), 2, 2);
    sharedTiles.last = tile;
    return tile;
}

/** The same producer without the write, which the gate accepts. */
export function createUncachedTile(engine: EngineContext): Texture2D {
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 2, 2).data;
    return createTexture2DFromPixels(engine, new Uint8Array(data), 2, 2);
}
