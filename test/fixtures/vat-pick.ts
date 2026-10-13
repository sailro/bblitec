import {
    addToScene,
    attachVat,
    bakeVat,
    createArcRotateCamera,
    createEngine,
    createGpuPicker,
    createHemisphericLight,
    createSceneContext,
    createStorageBuffer,
    goToFrame,
    loadGltf,
    pauseAnimation,
    pickAsync,
    registerScene,
    setThinInstances,
    setVatInstanceStorage,
    startEngine,
    stopAnimation,
} from "@babylonjs/lite";
import type { Mesh, TransformNode } from "@babylonjs/lite";

// Four scene 218 sharks on one transform, frozen at the same swimming frame:
// a baked one (VAT), a baked one thin-instanced at identity reading its clip
// from the instance texture, another reading it from instance storage, and
// one on its live skeleton. At every grid point each VAT pick must agree with
// the deformation pick of the live pose, and the VAT hits must move from one
// frame to the other.
function findSkinned(node: TransformNode): Mesh | null {
    const m = node as unknown as Mesh;
    if (m.skeleton) return m;
    for (const c of (node.children ?? []) as TransformNode[]) {
        const hit = findSkinned(c);
        if (hit) return hit;
    }
    return null;
}

async function waitFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

const url = "https://models.babylonjs.com/shark.glb";
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = await createEngine(canvas);
const scene = createSceneContext(engine);
scene.clearColor = { r: 0.14, g: 0.14, b: 0.16, a: 1.0 };
const baked = await loadGltf(engine, url);
addToScene(scene, baked);
const texture = await loadGltf(engine, url);
addToScene(scene, texture);
const storage = await loadGltf(engine, url);
addToScene(scene, storage);
const live = await loadGltf(engine, url);
addToScene(scene, live);
const vatMesh = findSkinned(baked.entities[0] as TransformNode);
const textureMesh = findSkinned(texture.entities[0] as TransformNode);
const storageMesh = findSkinned(storage.entities[0] as TransformNode);
const liveMesh = findSkinned(live.entities[0] as TransformNode);
if (!vatMesh || !textureMesh || !storageMesh || !liveMesh) throw new Error("the shark carries a skinned mesh");
const bake = bakeVat(engine, vatMesh, baked.animationGroups ?? []);
const clip = bake.clips["swimming"];
if (!clip) throw new Error("the shark has a swimming clip");
const handle = attachVat(engine, vatMesh, bake, "swimming");
const textureHandle = attachVat(engine, textureMesh, bakeVat(engine, textureMesh, texture.animationGroups ?? []), "swimming");
const storageHandle = attachVat(engine, storageMesh, bakeVat(engine, storageMesh, storage.animationGroups ?? []), "swimming");
setThinInstances(textureMesh, identity, 1);
setThinInstances(storageMesh, identity, 1);
const last = clip.fromRow + clip.frameCount - 1;
textureHandle.setInstances(new Float32Array([clip.fromRow, last, 0, 0]));
storageHandle.setInstances(new Float32Array([clip.fromRow, last, 0, 0]));
const swimming = (live.animationGroups ?? []).find((group) => group.name === "swimming");
if (!swimming) throw new Error("the live shark has a swimming clip");
for (const group of live.animationGroups ?? []) if (group !== swimming) stopAnimation(group);
scene.camera = createArcRotateCamera(0, Math.PI / 2.2, 28.816, { x: 0, y: 2.36936, z: -0.65368 });
addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));
await registerScene(scene);
await startEngine(engine);
const picker = createGpuPicker(scene);

async function hits(target: Mesh): Promise<boolean[]> {
    for (const mesh of scene.meshes) mesh.pickable = false;
    target.pickable = true;
    const found: boolean[] = [];
    for (let y = 0; y <= 16; y++) {
        for (let x = 0; x <= 32; x++) {
            const info = await pickAsync(picker, canvas.clientWidth * (0.05 + x * 0.028125), canvas.clientHeight * (0.2 + y * 0.0375));
            found.push(info.hit);
        }
    }
    return found;
}

function disagreements(frame: number, name: string, picked: boolean[], skeletal: boolean[]): void {
    let differ = 0;
    let count = 0;
    for (let i = 0; i < picked.length; i++) {
        if (picked[i] !== skeletal[i]) differ++;
        if (picked[i]) count++;
    }
    if (differ !== 0 || count < 20) throw new Error(`frame ${frame}: ${differ} of ${count} ${name} hits disagree`);
}

async function pose(frame: number): Promise<boolean[]> {
    handle.play("swimming", { offset: frame, fps: 0 });
    handle.update(0);
    textureHandle.setInstances(new Float32Array([clip!.fromRow, last, frame, 0]));
    // The dual-clip row pair setInstances expands a single clip into.
    setVatInstanceStorage(engine, storageMesh!, createStorageBuffer(engine, new Float32Array([clip!.fromRow, last, frame, 0, clip!.fromRow, last, 0, 0]), "vat-pick"));
    goToFrame(swimming!, frame);
    pauseAnimation(swimming!);
    await waitFrames(3);
    const skeletal = await hits(liveMesh!);
    const vat = await hits(vatMesh!);
    disagreements(frame, "VAT", vat, skeletal);
    disagreements(frame, "thin texture VAT", await hits(textureMesh!), skeletal);
    disagreements(frame, "thin storage VAT", await hits(storageMesh!), skeletal);
    return vat;
}

const first = await pose(0);
const second = await pose(20);
let moved = 0;
for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) moved++;
if (moved === 0) throw new Error("VAT picks must follow the baked pose");
// A green clear marks a run that passed every check.
scene.clearColor = { r: 0, g: 1, b: 0, a: 1 };
