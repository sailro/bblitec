// Project-owned differential gate: compiles the pinned tetris chamfered-box
// and rounded-box generators (corpus demos/tetris/) through the plain-data
// subset, feeds the resulting typed arrays into createMeshFromData, and
// thin-instances a ring of segments — the demo renderer's mesh-data and
// static-instancing contracts without its class/closure layer. The rounded
// generator exercises function-valued parameters (its addGrid vertex
// callback), mutable tuple locals, early bare returns, and numeric ||.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createEngine,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    loadTexture2D,
    registerScene,
    setThinInstances,
    startEngine,
} from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";
import { createChamferedBoxData } from "../corpus/babylon-lite/lab/lite/src/demos/tetris/chamfered-box.js";
import { createRoundedBoxData } from "../corpus/babylon-lite/lab/lite/src/demos/tetris/rounded-box.js";

const BLOCK_COLORS: readonly (readonly [number, number, number])[] = [
    [0.95, 0.24, 0.52],
    [0.9, 0.9, 0.95],
    [0.98, 0.5, 0.24],
    [0.93, 0.16, 0.14],
    [1.0, 0.8, 0.12],
    [0.22, 0.34, 0.95],
    [0.13, 0.8, 0.38],
];

// The demo renderer's rotation-about-Z instance matrix (column-major with
// translation in elements 12-14), written directly into the shared
// Float32Array like tetris/renderer.ts writeMatrixRotZ.
function writeMatrixRotZ(
    out: Float32Array,
    idx: number,
    x: number,
    y: number,
    z: number,
    s: number,
    a: number,
): void {
    const o = idx * 16;
    const c = Math.cos(a) * s;
    const sn = Math.sin(a) * s;
    out[o + 0] = c;
    out[o + 1] = sn;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = -sn;
    out[o + 5] = c;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = s;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.4,
        14,
        { x: 0, y: 0.5, z: 0 },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };
    // Hemispheric lighting only: the PBR ring stays inside the reached
    // analytic-light slice (scene 10 shape). PBR under a scene-level
    // directional light is an unreached upstream port tracked in TODO.
    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.95),
    );

    const chamfer = createChamferedBoxData(1, 0.08);

    // One chamfered block per piece color across the top row.
    for (let index = 0; index < 7; index++) {
        const block = createMeshFromData(
            engine,
            "tetris_block",
            chamfer.positions,
            chamfer.normals,
            chamfer.indices,
            chamfer.uvs,
        );
        block.position.set(index - 3, 2.5, 0);
        const material = createStandardMaterial();
        material.diffuseColor = [
            BLOCK_COLORS[index]![0],
            BLOCK_COLORS[index]![1],
            BLOCK_COLORS[index]![2],
        ];
        block.material = material;
        addToScene(scene, block);
    }

    // The demo's "smooth" restyle below: rounded blocks from the pinned
    // quarter-cylinder/spherical-octant generator.
    const rounded = createRoundedBoxData(1, 0.2, 3);
    for (let index = 0; index < 7; index++) {
        const block = createMeshFromData(
            engine,
            "tetris_round",
            rounded.positions,
            rounded.normals,
            rounded.indices,
            rounded.uvs,
        );
        block.position.set(index - 3, 1.25, 0);
        const material = createStandardMaterial();
        material.diffuseColor = [
            BLOCK_COLORS[index]![0] * 0.85,
            BLOCK_COLORS[index]![1] * 0.85,
            BLOCK_COLORS[index]![2] * 0.85,
        ];
        block.material = material;
        addToScene(scene, block);
    }

    // A thin-instanced ring of 24 rotated segments below, one draw call,
    // wearing the demo frame's stone colormap through the pinned
    // loadTexture2D contract (sRGB base color, no mips, nearest filters).
    const ring = createMeshFromData(
        engine,
        "tetris_ring",
        chamfer.positions,
        chamfer.normals,
        chamfer.indices,
        chamfer.uvs,
    );
    const frameColormap = await loadTexture2D(
        engine,
        "/tetris/tetris-frame-colormap.png",
        {
            srgb: true,
            invertY: false,
            mipMaps: false,
            minFilter: "nearest",
            magFilter: "nearest",
        },
    );
    const ringMaterial = createPbrMaterial({
        baseColorTexture: frameColormap,
        ormTexture: createSolidTexture2D(
            engine,
            1.0,
            0.85,
            0.0,
        ),
        environmentIntensity: 0.9,
        directIntensity: 1.0,
    });
    ring.material = ringMaterial;
    const matrices = new Float32Array(24 * 16);
    for (let index = 0; index < 24; index++) {
        const angle = (index / 24) * Math.PI * 2;
        writeMatrixRotZ(
            matrices,
            index,
            Math.cos(angle) * 4,
            Math.sin(angle) * 4 - 1,
            0,
            0.55,
            angle,
        );
    }
    setThinInstances(ring, matrices, 24);
    addToScene(scene, ring);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

main().catch((error) => console.error(error));
