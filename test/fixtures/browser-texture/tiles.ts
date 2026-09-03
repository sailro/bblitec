/**
 * Fixtures for the generation-time browser texture path.
 *
 * Each export is one shape the structural gate has to answer: a
 * record-returning `OffscreenCanvas` -> PNG blob -> `loadTexture2D`
 * producer, a non-exported `document.createElement("canvas")` ->
 * `createTexture2DFromPixels` producer reached through a local helper, and
 * the refusal shapes beside them. They stay small (4x4 and 2x2) so a test
 * run's Chromium bake is cheap.
 */
import type { EngineContext, Texture2D } from "@babylonjs/lite";
import {
    createStandardMaterial,
    createTexture2DFromPixels,
    loadTexture2D,
} from "@babylonjs/lite";

const TILE = 4;

export interface TilePair {
    readonly baseColor: Texture2D;
    readonly normalMap: Texture2D;
}

/** Two textures through one OffscreenCanvas PNG encode each. */
export async function createTilePair(engine: EngineContext): Promise<TilePair> {
    const base = rampBytes(TILE, 1);
    const normal = rampBytes(TILE, 2);
    const options = {
        addressModeU: "repeat" as const,
        addressModeV: "repeat" as const,
        invertY: false,
    };
    const [baseColor, normalMap] = await Promise.all([
        encodeTile(engine, base, TILE, options),
        encodeTile(engine, normal, TILE, options),
    ]);
    return { baseColor, normalMap };
}

async function encodeTile(
    engine: EngineContext,
    rgba: Uint8Array,
    size: number,
    options: Parameters<typeof loadTexture2D>[2],
): Promise<Texture2D> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const url = URL.createObjectURL(blob);
    const texture = await loadTexture2D(engine, url, options);
    URL.revokeObjectURL(url);
    return texture;
}

function rampBytes(size: number, stride: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
        const value = Math.round((index * stride * 255) / (size * size));
        data[index * 4] = value;
        data[index * 4 + 1] = value;
        data[index * 4 + 2] = value;
        data[index * 4 + 3] = 255;
    }
    return data;
}

/** A material whose diffuse slot takes a non-exported canvas producer. */
export function createFaceMaterial(engine: EngineContext) {
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.diffuseTexture = makeFaceTexture(engine);
    return material;
}

/**
 * The sandblox character's own route: the texture is returned through a
 * local helper, bound to a local, handed to a second local function as a
 * parameter, and only assigned there. Every hop has to carry the pixels
 * metadata or the slot falls through to render-texture-only handling.
 */
export function createFaceMaterialThroughParameter(engine: EngineContext) {
    const faceTexture = makeFaceTexture(engine);
    return applyFace(faceTexture);
}

function applyFace(faceTexture: Texture2D) {
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.diffuseTexture = faceTexture;
    return material;
}

function makeFaceTexture(engine: EngineContext): Texture2D {
    return createFaceTexture(engine);
}

function createFaceTexture(engine: EngineContext): Texture2D {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Failed to create the fixture 2D context.");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#112233";
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const flipped = new Uint8Array(data.length);
    const rowBytes = canvas.width * 4;
    for (let y = 0; y < canvas.height; y += 1) {
        flipped.set(
            data.subarray(y * rowBytes, y * rowBytes + rowBytes),
            (canvas.height - 1 - y) * rowBytes,
        );
    }
    return createTexture2DFromPixels(engine, flipped, canvas.width, canvas.height, {
        minFilter: "linear",
        magFilter: "linear",
    });
}
