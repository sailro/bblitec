import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SkeletonLowerer } from "../src/lowering/skeleton-lowerer.js";
import { pinnedMeshFeaturesFromPrimitive } from "../src/pinned-mesh-features.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

/**
 * The scene-authored skeleton: `createSkeleton` plus `mesh.skeleton = ...`,
 * the path corpus scenes 114 and 231 reach and the glTF loader does not.
 *
 * What these pin is the SHAPE of the port rather than a picture: the
 * palette reaches the mesh record (which is what both backends upload
 * from), the joint and weight streams reach that mesh's own vertices, the
 * mesh's composed feature word carries the pin's MSH_HAS_SKELETON, and a
 * live update stays a per-frame call rather than being folded at creation.
 */

const SKINNED_QUAD = `
    import {
        addToScene,
        createEngine,
        createSceneContext,
        registerScene,
    } from "@babylonjs/lite";
    import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
    import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
    const engine = await createEngine({});
    const scene = createSceneContext(engine);
    const positions = new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
    ]);
    const normals = new Float32Array([
        0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
    const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    const mesh = createMeshFromData(engine, "beam", positions, normals, indices, uvs);
    const joints = new Uint16Array([
        0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
    const weights = new Float32Array([
        1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]);
    const boneData = new Float32Array(32);
    mesh.skeleton = createSkeleton(engine, joints, weights, 2, boneData);
    addToScene(scene, mesh);
    await registerScene(scene);
`;

test("a scene-authored skeleton reaches the native resource and its mesh", () => {
    const result = compileSource(SKINNED_QUAD);
    assert.ok(result.manifest.features.includes("mesh:skeleton"));
    assert.match(
        result.cpp,
        /bbl::create_scene_skeleton\([^;]*, 2\.0, [^;]*\);/,
    );
    assert.match(result.cpp, /bbl::attach_scene_skeleton\(/);
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/skeleton.cpp",
        ),
    );
    // The generation half: the pin reads `mesh.skeleton` for
    // MSH_HAS_SKELETON, so the assignment has to move the mesh's own
    // composition row rather than only emitting a native call.
    assert.equal(result.manifest.sceneMeshes[0]?.skinned, true);
});

test("the skinned scene mesh composes under the pin's own skeleton bit", async () => {
    const result = compileSource(SKINNED_QUAD);
    const bits = await importPinnedModule<{ MSH_HAS_SKELETON: number }>(
        "material/mesh-features.js",
    );
    const features = await pinnedMeshFeaturesFromPrimitive(
        {
            attributes: { POSITION: 0, NORMAL: 0, TEXCOORD_0: 0 },
        },
        { skinned: result.manifest.sceneMeshes[0]?.skinned === true },
    );
    assert.equal(features & bits.MSH_HAS_SKELETON, bits.MSH_HAS_SKELETON);
});

test("updateSkeletonBoneMatrices stays a live per-frame call", () => {
    const result = compileSource(`
        import {
            addToScene,
            createEngine,
            createSceneContext,
            onBeforeRender,
            registerScene,
        } from "@babylonjs/lite";
        import { createMeshFromData } from "babylon-lite/mesh/mesh-factories.js";
        import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
        import { updateSkeletonBoneMatrices } from "babylon-lite/skeleton/update-skeleton-bone-matrices.js";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        const positions = new Float32Array([
            -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
        ]);
        const normals = new Float32Array([
            0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
        ]);
        const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
        const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
        const mesh = createMeshFromData(engine, "beam", positions, normals, indices, uvs);
        const joints = new Uint16Array([
            0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
        ]);
        const weights = new Float32Array([
            1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
        ]);
        const boneData = new Float32Array(32);
        const skeleton = createSkeleton(engine, joints, weights, 2, boneData);
        mesh.skeleton = skeleton;
        addToScene(scene, mesh);
        let frame = 0;
        onBeforeRender(scene, () => {
            frame++;
            boneData[28] = frame * 0.01;
            updateSkeletonBoneMatrices(engine, skeleton, boneData);
        });
        await registerScene(scene);
    `);
    assert.match(
        result.cpp,
        /bbl::update_scene_skeleton_bone_matrices\(/,
    );
    // The pose is read where the scene writes it. A fold at creation would
    // put the call outside the callback, which is what this pins.
    const callback = result.cpp.slice(
        result.cpp.indexOf("bbl::on_before_render"),
    );
    assert.ok(
        callback.includes("update_scene_skeleton_bone_matrices"),
        "the palette update must stay inside the per-frame callback",
    );
});

test("the pin's own 8-bone skinning arm refuses rather than dropping streams", () => {
    assert.throws(
        () =>
            compileSource(`
                import { createEngine } from "@babylonjs/lite";
                import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
                const engine = await createEngine({});
                const joints = new Uint16Array(16);
                const weights = new Float32Array(16);
                const boneData = new Float32Array(32);
                createSkeleton(engine, joints, weights, 2, boneData, joints, weights);
            `),
        /Expected 5 arguments, received 7/,
    );
});

test("mesh.skeleton takes a skeleton and nothing else", () => {
    assert.throws(
        () =>
            compileSource(`
                import { createEngine, createBox, createMorphTargets } from "@babylonjs/lite";
                const engine = await createEngine({});
                const box = createBox(engine, 1);
                const positions = new Float32Array(72);
                box.skeleton = createMorphTargets(
                    engine,
                    [{ positions, normals: null }],
                    24,
                    [1],
                );
            `),
        /scene-skeleton/,
    );
});

test("the palette a scene keeps rewriting is not marked escaped", () => {
    // The pin publishes the caller's array as `skeleton.boneMatrices` and
    // uploads that same array, so writing into it after createSkeleton is
    // the documented way to pose a skeleton -- corpus scene 231 does it
    // every frame. Reading it through the ordinary typed-array sink would
    // refuse the second write.
    const result = compileSource(`
        import { createEngine } from "@babylonjs/lite";
        import { createSkeleton } from "babylon-lite/skeleton/create-skeleton.js";
        import { updateSkeletonBoneMatrices } from "babylon-lite/skeleton/update-skeleton-bone-matrices.js";
        const engine = await createEngine({});
        const joints = new Uint16Array(16);
        const weights = new Float32Array(16);
        const boneData = new Float32Array(32);
        const skeleton = createSkeleton(engine, joints, weights, 2, boneData);
        boneData[28] = 1.5;
        updateSkeletonBoneMatrices(engine, skeleton, boneData);
    `);
    assert.match(
        result.cpp,
        /bbl::update_scene_skeleton_bone_matrices\([^;]*v_boneData\)/,
    );
});

test("the emitted skeleton unit keeps the palette on the mesh record", () => {
    const lowered = new SkeletonLowerer(new LoweringContext()).lower();
    assert.equal(lowered.modulePath, "src/skeleton/create-skeleton.ts");
    // The palette both backends upload from is `MeshRecord::bone_matrices`,
    // and a live update has to reach every mesh the skeleton was assigned
    // to -- the pin writes one shared texture, so a port that wrote only
    // the first mesh would silently freeze the others.
    assert.match(
        lowered.source,
        /engine\.meshes\[mesh\.value\]\.bone_matrices = skeleton\.bone_matrices;/,
    );
    assert.match(lowered.source, /mesh_record\.scene_skeleton = true;/);
    assert.match(lowered.source, /mesh_record\.pinned_bone_palette = true;/);
    assert.match(lowered.source, /mesh_record\.gpu_deformation = true;/);
    assert.match(
        lowered.source,
        /void update_scene_skeleton_bone_matrices\(/,
    );
});
