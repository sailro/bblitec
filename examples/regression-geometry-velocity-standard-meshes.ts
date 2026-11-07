// The Standard geometry velocity regressions' meshes, each moved every frame
// before rendering: a box that slides and turns, a skinned beam that bends
// and a morphed sphere that swells.
import {
    addToScene,
    createBox,
    createMorphTargets,
    createSphere,
    createSphereData,
    createStandardMaterial,
    onBeforeRender,
    setMorphTargetWeights,
    type EngineContext,
    type Mesh,
    type SceneContext,
    type StandardMaterialProps,
} from "babylon-lite";
import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
import { updateSkeletonBoneMatrices } from "babylon-lite/skeleton/update-skeleton-bone-matrices.js";
import { boneMatrixData, buildBeamData, SKELETON_BONE_COUNT } from "../corpus/babylon-lite/lab/lite/src/shared/scene231-skin.js";

export function standard(r: number, g: number, b: number): StandardMaterialProps {
    const material = createStandardMaterial();
    material.diffuseColor = [r, g, b];
    return material;
}

/** A box of `size` at height `y` and depth `z`, sliding about `x` with `speed` and turning when `turns`. */
export function addSlidingBox(
    engine: EngineContext,
    scene: SceneContext,
    material: Mesh["material"],
    size: number,
    x: number,
    y: number,
    z: number,
    speed: number,
    reach: number,
    turns: boolean
): Mesh {
    const box = createBox(engine, { size });
    box.position.y = y;
    box.position.z = z;
    box.material = material;
    addToScene(scene, box);
    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        box.position.x = x + Math.sin(frame * speed) * reach;
        if (turns) {
            box.rotation.y = frame * 0.05;
        }
    });
    return box;
}

/** The scene-231 beam at `x`, skinned to its two bones and bent every frame (enableStandardSkeleton first). */
export function addBendingBeam(engine: EngineContext, scene: SceneContext, x: number): Mesh {
    const data = buildBeamData();
    const beam = createMeshFromData(engine, "velocity-beam", data.positions, data.normals, data.indices, data.uvs);
    beam.position.x = x;
    beam.position.y = 1;
    beam.material = standard(0.12, 0.55, 0.25);
    const bones = boneMatrixData(0);
    const skeleton = createSkeleton(engine, data.joints, data.weights, SKELETON_BONE_COUNT, bones);
    beam.skeleton = skeleton;
    addToScene(scene, beam);
    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        boneMatrixData(frame * 3, bones);
        updateSkeletonBoneMatrices(engine, skeleton, bones);
    });
    return beam;
}

/** A unit sphere at (x, y, z) whose one morph target stretches it, swelling every frame. */
export function addSwellingSphere(engine: EngineContext, scene: SceneContext, material: Mesh["material"], x: number, y: number, z: number): Mesh {
    const options = { diameter: 1, segments: 24 };
    const sphere = createSphere(engine, options);
    sphere.position.x = x;
    sphere.position.y = y;
    sphere.position.z = z;
    sphere.material = material;
    const data = createSphereData(options);
    const deltas = new Float32Array(data.vertexCount * 3);
    for (let i = 0; i < data.vertexCount; i++) {
        deltas[i * 3] = data.positions[i * 3]! * 0.4;
        deltas[i * 3 + 1] = data.positions[i * 3 + 1]! * 0.9;
    }
    const morph = createMorphTargets(engine, [{ positions: deltas, normals: null }], data.vertexCount, [0]);
    sphere.morphTargets = morph;
    addToScene(scene, sphere);
    const weights = new Float32Array([0]);
    let frame = 0;
    onBeforeRender(scene, () => {
        frame += 1;
        weights[0] = 0.5 - 0.5 * Math.cos(frame * 0.09);
        setMorphTargetWeights(engine, morph, weights);
    });
    return sphere;
}
