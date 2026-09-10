import assert from "node:assert/strict";
import test from "node:test";
import { GLTF_MESH_PLAN, type JsonObject } from "../src/gltf-document.js";
import { gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan } from "../src/gltf-mesh-plan.js";
import { packageGltfLoadPlan } from "../src/gltf-load-plan.js";
import { materialSubjects, gltfRenderables, gltfLinearImageProcessing } from "../src/pinned-material-arms.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";
import { meshPlanFixture } from "./gltf-mesh-fixture.js";
import { doctoredContext } from "./doctored-store.js";

const module = "src/loader-gltf/load-gltf.ts";
function fixture() {
    return meshPlanFixture({
        asset: {version: "2.0"},
        materials: [{name: "zero"}, {name: "one"}, {name: "unused"}],
        nodes: [{mesh: 1}, {}, {mesh: 0}, {mesh: 1}],
        meshes: [{name: "first", primitives: [{material: 0}]}, {primitives: [{material: 1}, {}]}],
        scenes: [{nodes: [0, 2, 3]}],
    });
}

test("base scheduling preserves reached order, both caches, default identity and GPU sharing", async () => {
    const {document, bin} = fixture();
    const plan = await gltfMeshPlan(document, bin);
    assert.deepEqual(plan.cores, [1, -1, 0]);
    assert.deepEqual(plan.materials, [0, 1, 2]);
    assert.deepEqual(plan.meshes, [
        {node: 0, primitive: 0, material: 0, geometry: 0, name: "gltf_mesh_0"},
        {node: 0, primitive: 1, material: 1, geometry: 1, name: "gltf_mesh_1"},
        {node: 2, primitive: 0, material: 2, geometry: 2, name: "first"},
        {node: 3, primitive: 0, material: 0, geometry: 0, name: "gltf_mesh_3"},
        {node: 3, primitive: 1, material: 1, geometry: 1, name: "gltf_mesh_4"},
    ]);
    await packageGltfMeshPlan(document, bin);
    assert.deepEqual(packagedGltfMeshPlan(document), plan);
    const subjects = await materialSubjects(document);
    assert.deepEqual(subjects.map(subject => subject.name), ["one", "default material", "zero"]);
    assert.deepEqual(subjects.map(subject => subject.sourceIndex), [1, -1, 0]);
    assert.deepEqual((await gltfRenderables(document)).map(mesh => mesh.material), [0, 1, 2, 0, 1]);
    const transmission = {extensions: {KHR_materials_transmission: {transmissionFactor: 1}}};
    assert.equal(await gltfLinearImageProcessing({...document, materials: [{}, {}, transmission]}), false);
    assert.equal(await gltfLinearImageProcessing({...document, materials: [{}, transmission, {}]}), true);
    const unselected = {...document, scenes: [{nodes: [2]}]};
    assert.deepEqual((await gltfMeshPlan(unselected, bin)).meshes.map(mesh => mesh.geometry), [0, 1, 2, 3, 4]);
});

test("base core and built scheduling respond independently to source cache changes", async () => {
    const {document, bin} = fixture();
    const core = await gltfMeshPlan(document, bin, doctoredContext(module, "const key = (matIdx ?? -1) + 1;", "const key = 1;"));
    assert.deepEqual(core.cores, [0]);
    assert.deepEqual(core.materials, [0]);
    assert.deepEqual(core.meshes.map(mesh => mesh.material), [0, 0, 0, 0, 0]);
    const built = await gltfMeshPlan(document, bin, doctoredContext(module, "let cached = builtMaterialCache.get(mat);", "let cached = undefined;"));
    assert.deepEqual(built.cores, [1, -1, 0]);
    assert.deepEqual(built.materials, [0, 1, 2, 0, 1]);
    assert.deepEqual(built.meshes.map(mesh => mesh.material), [0, 1, 2, 3, 4]);
});

test("source extraction guards and upload names control the emitted schedule", async () => {
    const {document, bin} = fixture();
    const filtered = await gltfMeshPlan(document, bin, doctoredContext(module,
        "if (node.mesh === undefined)", "if (node.mesh === undefined || nodeIdx === 0)"));
    assert.deepEqual(filtered.cores, [0, 1, -1]);
    assert.deepEqual(filtered.meshes.map(mesh => mesh.node), [2, 3, 3]);
    const unique = fixture();
    unique.document.nodes = [{mesh: 0}];
    const renamed = await gltfMeshPlan(unique.document, unique.bin, doctoredContext(module,
        'const meshName = json.meshes[json.nodes[m._nodeIndex].mesh].name || `gltf_mesh_${i}`;',
        'const meshName = "from-source";'));
    assert.equal(renamed.meshes[0]!.name, "from-source");
    unique.document.nodes = [{mesh: 0}, {mesh: 1}];
    const reversed = await gltfMeshPlan(unique.document, unique.bin, doctoredContext(module,
        "return Promise.all(\n        meshDatas.map", "return Promise.all(\n        [...meshDatas].reverse().map"));
    assert.deepEqual(reversed.meshes.map(mesh => [mesh.node, mesh.primitive]), [[1, 1], [1, 0], [0, 0]]);
});

test("recording boundaries refuse changed resource ownership and invalid metadata", async () => {
    const {document, bin} = fixture();
    await assert.rejects(gltfMeshPlan(document, bin, doctoredContext(module,
        "assembleMaterial(json, binChunk, key - 1, baseUrl, imageCache)",
        "assembleMaterial(json, binChunk, key - 1, 'elsewhere', imageCache)")), /resource ownership/);
    await assert.rejects(gltfMeshPlan(document, new DataView(new ArrayBuffer(0))), /length|bounds|offset/i);
    await assert.rejects(gltfMeshPlan(document, bin, doctoredContext(module,
        "builtMaterialCache.get(mat)", "builtMaterialCache.get(mat.unrepresented)")), /opaque material property/);
    await packageGltfMeshPlan(document, bin);
    await assert.rejects(packageGltfMeshPlan(document, bin), /already carries/);
    const plan = packagedGltfMeshPlan(document);
    for (const value of [null, {}, {...plan, cores: [99]}, {...plan, materials: [99]},
        {...plan, meshes: [{...plan.meshes[0], node: 99}]}, {...plan, meshes: [{...plan.meshes[0], material: 99}]}])
        assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: value}), /Invalid/);
});

test("the final asset pass packages source scheduling against embedded BIN data", async () => {
    const {document, bin} = fixture();
    const binary = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
    const packed = readGlbFixture(await packageGltfLoadPlan(buildGlb(document, binary), "mesh fixture"));
    assert.deepEqual(packagedGltfMeshPlan(packed.document), await gltfMeshPlan(document, bin));
    assert.deepEqual(packed.binary, binary);
    assert.throws(() => packagedGltfMeshPlan({} as JsonObject), /missing packaged/);
});
