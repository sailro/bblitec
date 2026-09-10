import assert from "node:assert/strict";
import test from "node:test";
import {asObject, asRecords, GLTF_MESH_PLAN, type JsonObject} from "../src/gltf-document.js";
import {gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan} from "../src/gltf-mesh-plan.js";
import type {LoweringContext} from "../src/lowering/context.js";
import {doctoredContext} from "./doctored-store.js";
import {meshPlanFixture, readPackedGltfAttribute} from "./gltf-mesh-fixture.js";

function fixture(instanced = false) {
    const document: JsonObject = {nodes: [{mesh: 0}], meshes: [{primitives: [{}]}], scenes: [{nodes: [0]}]};
    const triangle = meshPlanFixture(document);
    if (!instanced) return triangle;
    document.extensionsUsed = ["EXT_mesh_gpu_instancing"];
    const node = asRecords(document.nodes)[0]!;
    node.translation = [10, 0, 0];
    node.extensions = {EXT_mesh_gpu_instancing: {attributes: {TRANSLATION: 1}}};
    const positions = new Float32Array([1, 0, 0, 3, 2, 0]);
    const bytes = Buffer.concat([Buffer.from(triangle.bin.buffer), Buffer.from(positions.buffer)]);
    asRecords(document.buffers)[0]!.byteLength = bytes.byteLength;
    document.bufferViews = [...asRecords(document.bufferViews), {buffer: 0, byteOffset: triangle.bin.byteLength, byteLength: positions.byteLength}];
    document.accessors = [...asRecords(document.accessors), {bufferView: 1, componentType: 5126, count: 2, type: "VEC3"}];
    return {document, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

async function packageFixture(input = fixture(), context?: LoweringContext) {
    const binary = await packageGltfMeshPlan(input.document, input.bin, context);
    const mesh = packagedGltfMeshPlan(input.document).meshes[0]!;
    return {document: input.document, mesh, attribute: (index: number) => readPackedGltfAttribute(input.document, binary, index)};
}

test("mesh placement follows source hierarchy, local bounds and primitive winding", async () => {
    const input = fixture();
    asRecords(input.document.nodes)[0]!.scale = [-2, 3, 1];
    asRecords(input.document.nodes)[0]!.translation = [10, 20, 30];
    const result = await packageFixture(input);
    assert.deepEqual(result.attribute(result.mesh.setup.bounds), [0, 0, 0, 1, 1, 0]);
    assert.deepEqual(result.attribute(result.mesh.setup.worldBounds), [-10, 20, 30, -8, 23, 30]);
    assert.deepEqual(result.attribute(result.mesh.setup.world).slice(12, 15), [-10, 20, 30]);
    assert.equal(result.mesh.setup.clockwise, true);
    const changed = await packageFixture(fixture(), doctoredContext("src/loader-gltf/load-gltf.ts",
        'createTransformNode("__root__", 0, 0, 0,', 'createTransformNode("__root__", 6, 0, 0,'));
    assert.equal(changed.attribute(changed.mesh.setup.world)[12], 6);
    const detached = await packageFixture(fixture(), doctoredContext("src/scene/scene-core.ts",
        "(child as unknown as SceneNode).parent = entity as unknown as SceneNode;", "(child as unknown as SceneNode).parent = null;"));
    assert.deepEqual(detached.attribute(detached.mesh.setup.worldBounds), [0, 0, 0, 1, 1, 0]);
});

test("source bounds calculations and constructors determine packaged boxes", async () => {
    const changed = await packageFixture(fixture(), doctoredContext("src/loader-gltf/load-gltf.ts",
        "const [boundMin, boundMax] = computeAabb(meshData._positions!);",
        "const [boundMin, boundMax] = computeAabb(meshData._positions!); boundMax[0] += 2;"));
    assert.deepEqual(changed.attribute(changed.mesh.setup.bounds), [0, 0, 0, 3, 1, 0]);
    const expanded = await packageFixture(fixture(), doctoredContext("src/mesh/mesh-world-bounds.ts",
        "transformedRadius += Math.abs(coefficient) * extent[column]!;", "transformedRadius += Math.abs(coefficient) * extent[column]! * 2;"));
    assert.deepEqual(expanded.attribute(expanded.mesh.setup.worldBounds), [-1.5, -0.5, 0, 0.5, 1.5, 0]);
});

test("source instancing hook owns matrix data, placement bounds and activation", async () => {
    const original = await packageFixture(fixture(true));
    assert.equal(original.mesh.setup.instances?.count, 2);
    assert.equal(original.attribute(original.mesh.setup.instances!.matrices)[12], 1);
    assert.deepEqual(original.attribute(original.mesh.setup.worldBounds), [-14, 0, 0, -11, 3, 0]);
    const moved = await packageFixture(fixture(true), doctoredContext("src/loader-gltf/gltf-feature-gpu-instancing.ts",
        "const tx = translation ? translation[i * 3]! : 0;", "const tx = translation ? translation[i * 3]! + 5 : 0;"));
    assert.equal(moved.attribute(moved.mesh.setup.instances!.matrices)[12], 6);
    assert.deepEqual(moved.attribute(moved.mesh.setup.worldBounds), [-19, 0, 0, -16, 3, 0]);
    const disabled = await packageFixture(fixture(true), doctoredContext("src/loader-gltf/load-gltf.ts", "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"));
    assert.equal(disabled.mesh.setup.instances, undefined);
});

test("primitive state follows its source builder and rejects unrepresented GPU state", async () => {
    const make = () => {
        const input = fixture();
        asRecords(asRecords(input.document.meshes)[0]!.primitives)[0]!.mode = 1;
        return input;
    };
    assert.equal((await packageFixture(make())).mesh.setup.topology, "line-list");
    const changed = await packageFixture(make(), doctoredContext("src/material/pbr/pbr-primitive-topology.ts", 'topo === 2 ? "line-list"', 'topo === 2 ? "point-list"'));
    assert.equal(changed.mesh.setup.topology, "point-list");
    await assert.rejects(packageFixture(make(), doctoredContext("src/material/pbr/pbr-primitive-topology.ts", 'prim.cullMode = "none";', 'prim.cullMode = "front";')), /primitive state/);
    const result = await packageFixture();
    const plan = asObject(result.document[GLTF_MESH_PLAN])!;
    asRecords(plan.meshes)[0]!.setup = {...result.mesh.setup, world: 999};
    assert.throws(() => packagedGltfMeshPlan(result.document), /mesh placement/);
});

function visibilityFixture() {
    const hidden = {KHR_node_visibility: {visible: false}};
    return meshPlanFixture({
        extensionsUsed: ["KHR_node_visibility"],
        nodes: [
            {children: [1], extensions: hidden},
            {mesh: 0, children: [2], extensions: {KHR_node_visibility: {visible: true}}},
            {mesh: 1}, {mesh: 2}, {mesh: 2, extensions: hidden},
        ],
        meshes: [{primitives: [{}, {}]}, {primitives: [{}]}, {primitives: [{}]}],
        scenes: [{nodes: [0, 3]}],
    });
}

test("initial visibility follows source node objects, primitive children and selected roots", async () => {
    const {document, bin} = visibilityFixture();
    const plan = await gltfMeshPlan(document, bin);
    assert.deepEqual(plan.nodeVisibility, [false, false, false, true, true]);
    assert.deepEqual(plan.meshes.map(mesh => mesh.setup.visible), [false, false, false, true, true]);
    const changed = await gltfMeshPlan(document, bin, doctoredContext("src/scene/visibility.ts",
        "if (cascade(node, v))", "if (cascade(node, !v))"));
    assert.deepEqual(changed.nodeVisibility, [true, true, true, true, true]);
    assert.ok(changed.meshes.every(mesh => mesh.setup.visible));
    const disabled = await gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/load-gltf.ts",
        "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"));
    assert.ok(disabled.meshes.every(mesh => mesh.setup.visible));
});

test("asset feature scheduling executes source control flow and refuses unknown fragments", async () => {
    const {document, bin} = visibilityFixture();
    const skipped = await gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/load-gltf.ts",
        "const assetFragments = await Promise.all(features.flatMap", "const assetFragments = await Promise.all([].flatMap"));
    assert.ok(skipped.meshes.every(mesh => mesh.setup.visible));
    await assert.rejects(gltfMeshPlan(document, bin, doctoredContext("src/loader-gltf/gltf-ext-node-visibility.ts",
        "return {};", "return { unrepresented: true };")), /mesh asset fragment/);
    await packageGltfMeshPlan(document, bin);
    const plan = packagedGltfMeshPlan(document);
    for (const nodeVisibility of [undefined, [], [true], [true, true, true, true, "false"]]) {
        assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: {...plan, nodeVisibility}}), /Invalid/);
    }
});
