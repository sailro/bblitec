// Project-owned differential gate: textures loaded from bytes the program
// holds, through object URLs.
//
//   * A KTX2 member of a fetched zip archive, inflated by the scene and
//     loaded by loadKtx2Texture2D.
//   * A PNG member of the same archive, loaded by loadTexture2D with options
//     spread from a constant.
//   * A whole fetched KTX2 file, loaded sRGB.

import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createStandardMaterial,
    loadKtx2Texture2D,
    loadTexture2D,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { EngineContext, SceneContext, Texture2D } from "babylon-lite";

const PANEL_SIZE = 2.2;
const COLUMN_STEP = 2.6;
const REPEAT = { addressModeU: "repeat" as const, addressModeV: "repeat" as const, invertY: false, mipMaps: true };

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The members of a zip archive by name, read through its central directory. */
async function readZip(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let end = -1;
    for (let at = archive.length - 22; at >= 0; at--) {
        if (view.getUint32(at, true) === 0x06054b50) {
            end = at;
            break;
        }
    }
    if (end < 0) throw new Error("not a zip archive");
    const decoder = new TextDecoder();
    const members = new Map<string, Uint8Array>();
    let at = view.getUint32(end + 16, true);
    for (let index = 0; index < view.getUint16(end + 10, true); index++) {
        const method = view.getUint16(at + 10, true);
        const size = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const local = view.getUint32(at + 42, true);
        const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const stored = archive.subarray(start, start + size);
        members.set(name, method === 0 ? stored : await inflateRaw(stored));
        at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return members;
}

/** One map from its bytes, through a transient object URL: the KTX2 loader for a `.ktx2` name, else the image loader. */
function loadMap(engine: EngineContext, name: string, bytes: Uint8Array, srgb: boolean): Promise<Texture2D> {
    const compressed = name.toLowerCase().endsWith(".ktx2");
    const url = URL.createObjectURL(new Blob([bytes], { type: compressed ? "application/octet-stream" : "image/png" }));
    const loading = compressed ? loadKtx2Texture2D(engine, url, srgb) : loadTexture2D(engine, url, { srgb, ...REPEAT });
    return loading.finally(() => URL.revokeObjectURL(url));
}

function panel(engine: EngineContext, scene: SceneContext, texture: Texture2D, column: number): void {
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [1, 1, 1];
    material.diffuseTexture = texture;
    const plane = createPlane(engine, { width: PANEL_SIZE, height: PANEL_SIZE });
    plane.material = material;
    plane.position.set(column * COLUMN_STEP, 0, 0);
    addToScene(scene, plane);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to fetch "${url}" (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };
    scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 8, { x: 0, y: 0, z: 0 });

    const members = await readZip(await fetchBytes("../examples/assets/regression/texture-pack.zip"));
    const member = (name: string): Uint8Array => {
        const bytes = members.get(name);
        if (!bytes) throw new Error(`missing "${name}"`);
        return bytes;
    };
    const baseColor = await fetchBytes("/models/FlightHelmetKTX/FlightHelmet_Materials_LensesMat_BaseColor.ktx2");
    const [normal, checker, lens] = await Promise.all([
        loadMap(engine, "maps/lens-normal.ktx2", member("maps/lens-normal.ktx2"), false),
        loadMap(engine, "checker.png", member("checker.png"), true),
        loadMap(engine, "base-color.ktx2", baseColor, true),
    ]);
    panel(engine, scene, normal, -1);
    panel(engine, scene, checker, 0);
    panel(engine, scene, lens, 1);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch(console.error);
