// Project-owned differential gate: the absolute VAT clock.
//
// Scene 218's baked shark, posed by setVatTime instead of the handle's
// clock: one write of 1.25 s after attachVat starts the swimming clip, and no
// update ever runs, so the settings buffer's clock lane alone selects the
// baked row every frame.

import {
    addToScene,
    attachControl,
    attachVat,
    bakeVat,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    loadGltf,
    registerScene,
    setVatTime,
    startEngine,
} from "babylon-lite";
import type { Mesh, TransformNode } from "babylon-lite";

const VAT_SECONDS = 1.25;

/** Depth-first search for the first mesh in a node tree that carries a skeleton. */
function findSkinned(node: TransformNode): Mesh | null {
    const m = node as unknown as Mesh;
    if (m.skeleton) {
        return m;
    }
    for (const c of (node.children ?? []) as TransformNode[]) {
        const hit = findSkinned(c);
        if (hit) {
            return hit;
        }
    }
    return null;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.14, g: 0.14, b: 0.16, a: 1.0 };

    const container = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
    addToScene(scene, container);

    const root = container.entities[0] as TransformNode;
    const mesh = findSkinned(root);
    const groups = container.animationGroups ?? [];
    if (!mesh || groups.length === 0) throw new Error("The shark has no skinned mesh or clip.");

    const baked = bakeVat(engine, mesh, groups);
    attachVat(engine, mesh, baked, "swimming");
    setVatTime(engine, mesh, VAT_SECONDS);

    const cam = createArcRotateCamera(0, Math.PI / 2.2, 28.816, { x: 0, y: 2.36936, z: -0.65368 });
    scene.camera = cam;
    attachControl(cam, canvas, scene);
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
