/**
 * The refusal shapes: each is one reason the structural gate declines, so a
 * test can prove the decline lands at the ordinary inliner's message rather
 * than being silently executed.
 */
import type { EngineContext, Texture2D } from "@babylonjs/lite";
import {
    createBox,
    createTexture2DFromPixels,
    loadTexture2D,
} from "@babylonjs/lite";

/** Reaches a pinned export outside the two recorded factories. */
export function createBoxBesideTexture(engine: EngineContext): Texture2D {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 2, 2).data;
    createBox(engine, { size: 1 });
    return createTexture2DFromPixels(engine, new Uint8Array(data), 2, 2);
}

/** Owns a canvas but never reaches a pinned texture factory. */
export function measureCanvas(_engine: EngineContext): number {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    return canvas.width * canvas.height;
}

/** Reaches a pinned texture factory but owns no canvas. */
export async function loadTile(engine: EngineContext): Promise<Texture2D> {
    return loadTexture2D(engine, "tile.png", { invertY: false });
}

/**
 * Owns a canvas and reaches the factory, but with a fetched URL rather than
 * an object URL — so the structural gate accepts it and the driver refuses.
 */
export async function loadFetchedTileBesideCanvas(
    engine: EngineContext,
): Promise<Texture2D> {
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext("2d")!;
    ctx.fillRect(0, 0, 1, 1);
    return loadTexture2D(engine, "tile.png", { invertY: false });
}

let cached: Texture2D | undefined;

/** Memoizes through a module-level binding, so one execution is not the run. */
export function createCachedTile(engine: EngineContext): Texture2D {
    if (!cached) {
        const canvas = new OffscreenCanvas(2, 2);
        const ctx = canvas.getContext("2d")!;
        const data = ctx.getImageData(0, 0, 2, 2).data;
        cached = createTexture2DFromPixels(engine, new Uint8Array(data), 2, 2);
    }
    return cached;
}

/** Returns from two arms, so the texture set depends on which one ran. */
export function createBranchingTile(engine: EngineContext): Texture2D {
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return createTexture2DFromPixels(engine, new Uint8Array(16), 2, 2);
    }
    const data = ctx.getImageData(0, 0, 2, 2).data;
    return createTexture2DFromPixels(engine, new Uint8Array(data), 2, 2);
}
