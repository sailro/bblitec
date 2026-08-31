import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";

test("compiles setParent for imported roots and transform-node parents", () => {
    const result = compileSource(`
        import {
            createEngine,
            createTransformNode,
            getContainerMeshes,
            loadGltf,
            setParent,
        } from "@babylonjs/lite";

        async function main() {
            const engine = await createEngine({});
            const container = await loadGltf(engine, "model.glb");
            const parent = createTransformNode("parent");
            setParent(container.entities[0]!, parent);
            const meshes = getContainerMeshes(container);
            for (const mesh of meshes) {
                setParent(mesh, parent);
            }
        }
        void main();
    `);

    assert.match(result.cpp, /bbl::set_asset_root_parent\([^;]+v_parent\);/);
    assert.match(result.cpp, /bbl::set_mesh_parent\([^;]+v_parent\);/);
    assert.ok(result.manifest.features.includes("mesh:parenting"));
    assert.ok(result.manifest.features.includes("mesh:transform-node"));
});

test("preserves the pinned setParent world and hierarchy contract", () => {
    const source = new SceneLowerer(
        new LoweringContext(),
    ).lowerCore({ parenting: true }).source;

    assert.match(
        source,
        /const std::array<float, 16> child_world =\s*parenting_world_matrix\(engine, child_record\);/,
    );
    assert.match(
        source,
        /unlink_parent\(engine, child, child_record\);[\s\S]{0,180}child_record\.transform_parent = parent;[\s\S]{0,100}link_parent\(engine, child, parent\);/,
    );
    assert.match(
        source,
        /void unlink_child_links\([\s\S]{0,500}children\.erase\([\s\S]{0,220}registered\.erase\(/,
    );
    assert.match(
        source,
        /upstream::transform_node_world\(engine, parent\)[\s\S]{0,180}apply_preserved_parent_local/,
    );
    assert.match(
        source,
        /mat4_multiply_into\(local, 0, \*inverse_parent, 0, child_world, 0\);[\s\S]{0,180}pinned_parent_mat4_decompose\(local\)/,
    );
    assert.match(
        source,
        /record\.outer_position = Vec3\{\};\s*record\.outer_rotation = Vec3\{\};[\s\S]{0,1100}record\.gpu_world_transform = true;/,
    );
    assert.match(
        source,
        /for \(const MeshHandle mesh : engine\.assets\[child\.value\]\.meshes\) \{\s*set_mesh_parent\(engine, mesh, parent\);/,
    );
    assert.match(
        source,
        /pinned_parent_mat4_determinant3\(m\) < 0\.0\) \? \(-syAbs\) : syAbs/,
    );
});

test("keeps imported authored winding separate from live parent reflection", () => {
    const loader = new GltfLowerer(
        new LoweringContext(),
    ).lowerLoaderAdapter().source;
    const renderer = new RendererLowerer(
        new LoweringContext(),
    ).lowerRenderPlan({ mirroredMeshes: true }).source;

    assert.match(
        loader,
        /record\.authored_clockwise_front_face =\s*clockwise_front_face;\s*record\.clockwise_front_face =\s*clockwise_front_face;/,
    );
    assert.match(
        loader,
        /record\.scene_node_name = string_or\(node, "name"\);[\s\S]{0,180}"gltf_node_"/,
    );
    assert.match(
        renderer,
        /const bool transform_mirrored =\s*pinned_mat4_determinant3\(mesh_world_matrix\(engine, mesh\)\) < 0\.0;\s*const bool clockwise_front_face =\s*mesh\.authored_clockwise_front_face != transform_mirrored;/,
    );
    assert.doesNotMatch(
        renderer,
        /mesh\.authored_clockwise_front_face\s*=/,
    );
});
