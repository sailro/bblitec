// Project-owned differential gate: the scene-authored skeleton, both arms.
//
// `createSkeleton` is the pin's own GPU-resource factory
// (src/skeleton/create-skeleton.ts). Until this gate it was reachable only
// from inside the glTF loader lowering, where the pose pass folds
// `invMeshWorld` into every palette entry and leaves the mesh record's
// transform at rest. A scene that writes its own bone matrices folds
// nothing: the pin composes `finalWorld = mesh.world * influence` and the
// mesh keeps its transform, so a port that reused the loader's convention
// would draw the quad in the wrong place while compiling perfectly.
//
// Two rows, each a 4-vertex quad weighted 1.0 to bone 0 on its left edge
// and 1.0 to bone 1 on its right, with bone 1 translating +1.45 in x:
//
//   * top    - the pose is passed once to `createSkeleton` and never
//              touched again. This is the creation-time upload.
//   * bottom - the pose starts at zero shift and is ramped to the same
//              +1.45 over thirty frames through
//              `updateSkeletonBoneMatrices`, then the scene freezes
//              itself. A port that folded the palette at creation paints
//              this row unstretched; one that updated the skeleton record
//              without republishing to the mesh paints frame one forever.
//
// Behind each row sits its dark bind ghost (an identical quad with no
// skeleton, 0.16 further from the camera) and two vertical rails: blue at
// the bind pose's right edge, yellow where a correct skin puts it. A
// bind-pose render leaves both rows ending at the blue rail.
//
// Everything is unlit PBR so the measurement is geometry alone.

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    onBeforeRender,
    registerScene,
    setPbrUnlit,
    startEngine,
} from "babylon-lite";
import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
import { updateSkeletonBoneMatrices } from "babylon-lite/skeleton/update-skeleton-bone-matrices.js";

type ColorTuple = [number, number, number];
type Vec3Tuple = [number, number, number];

const BONE_SHIFT_X = 1.45;
const QUAD_HALF_WIDTH = 0.55;
const ORIGIN_X = -1.5;
const RAMP_FRAMES = 30;

function createUnlitPbr(engine: EngineContext, color: ColorTuple) {
    const material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, color[0], color[1], color[2]),
        ormTexture: createSolidTexture2D(engine, 1, 1, 0),
        metallicFactor: 0,
        roughnessFactor: 1,
        directIntensity: 0,
        environmentIntensity: 0,
        doubleSided: true,
    });
    setPbrUnlit(material, color);
    return material;
}

function createQuadMesh(engine: EngineContext, name: string, color: ColorTuple): Mesh {
    const positions = new Float32Array([
        -QUAD_HALF_WIDTH, -0.46, 0,
        QUAD_HALF_WIDTH, -0.46, 0,
        -QUAD_HALF_WIDTH, 0.46, 0,
        QUAD_HALF_WIDTH, 0.46, 0,
    ]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const mesh = createMeshFromData(engine, name, positions, normals, indices, uvs);
    mesh.name = name;
    mesh.material = createUnlitPbr(engine, color);
    return mesh;
}

/** The pin's own per-vertex skin: left edge on bone 0, right edge on bone 1. */
function edgeSkinJoints(): Uint16Array {
    return new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
}

function fullWeights(): Float32Array {
    return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
}

/** Two bone matrices: the root at rest and the shift bone translated in x. */
function bonePalette(shiftX: number): Float32Array {
    const boneData = new Float32Array(32);
    boneData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    boneData.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shiftX, 0, 0, 1], 16);
    return boneData;
}

function createHelperBox(
    engine: EngineContext,
    name: string,
    color: ColorTuple,
    position: Vec3Tuple,
    scaling: Vec3Tuple,
): Mesh {
    const box = createBox(engine, 1);
    box.name = name;
    box.material = createUnlitPbr(engine, color);
    box.position.set(position[0], position[1], position[2]);
    box.scaling.set(scaling[0], scaling[1], scaling[2]);
    return box;
}

function addRow(scene: SceneContext, engine: EngineContext, name: string, y: number): void {
    const ghost = createQuadMesh(engine, `${name}-bind-ghost`, [0.46, 0.28, 0.16]);
    ghost.position.set(ORIGIN_X, y, 0.16);
    addToScene(scene, ghost);

    addToScene(scene, createHelperBox(
        engine,
        `${name}-bind-edge-rail`,
        [0.28, 0.55, 1],
        [ORIGIN_X + QUAD_HALF_WIDTH, y, -0.08],
        [0.035, 1.2, 0.035],
    ));
    addToScene(scene, createHelperBox(
        engine,
        `${name}-skinned-edge-rail`,
        [1, 0.95, 0.18],
        [ORIGIN_X + QUAD_HALF_WIDTH + BONE_SHIFT_X, y, -0.08],
        [0.035, 1.2, 0.035],
    ));
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.145, g: 0.165, b: 0.21, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 5.5, { x: 0.15, y: 0, z: 0 });
    camera.fov = 0.72;
    camera.nearPlane = 1;
    camera.farPlane = 10000;
    scene.camera = camera;

    addToScene(scene, createHemisphericLight([0, 1, 0], 0.7));

    // Top row: the pose is handed to createSkeleton once and never touched.
    const staticQuad = createQuadMesh(engine, "scene-skeleton-static", [1, 0.48, 0.16]);
    staticQuad.position.set(ORIGIN_X, 0.75, 0);
    staticQuad.skeleton = createSkeleton(
        engine,
        edgeSkinJoints(),
        fullWeights(),
        2,
        bonePalette(BONE_SHIFT_X),
    );
    addRow(scene, engine, "scene-skeleton-static", 0.75);
    addToScene(scene, staticQuad);

    // Bottom row: the same final pose, reached one frame at a time.
    const liveQuad = createQuadMesh(engine, "scene-skeleton-live", [0.32, 0.78, 1]);
    liveQuad.position.set(ORIGIN_X, -0.75, 0);
    const livePose = bonePalette(0);
    const liveSkeleton = createSkeleton(
        engine,
        edgeSkinJoints(),
        fullWeights(),
        2,
        livePose,
    );
    liveQuad.skeleton = liveSkeleton;
    addRow(scene, engine, "scene-skeleton-live", -0.75);
    addToScene(scene, liveQuad);

    // A pure function of the frame index, so the freeze below is the same
    // pose in the browser and in a fixed-rate native run.
    let frame = 0;
    let frozen = false;
    onBeforeRender(scene, () => {
        if (frozen) {
            return;
        }
        frame++;
        const step = frame > RAMP_FRAMES ? RAMP_FRAMES : frame;
        livePose[28] = (BONE_SHIFT_X * step) / RAMP_FRAMES;
        updateSkeletonBoneMatrices(engine, liveSkeleton, livePose);
        if (frame >= RAMP_FRAMES) {
            frozen = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
