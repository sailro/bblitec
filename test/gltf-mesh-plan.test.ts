import assert from "node:assert/strict";
import test from "node:test";
import { GLTF_MESH_PLAN, type JsonObject } from "../src/gltf-document.js";
import { gltfMeshPlan, packageGltfMeshPlan, packagedGltfMeshPlan } from "../src/gltf-mesh-plan.js";
import { packageGltfLoadPlan } from "../src/gltf-load-plan.js";
import { materialSubjects, gltfRenderables, gltfLinearImageProcessing } from "../src/pinned-material-arms.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";
import { meshPlanFixture, readPackedGltfAttribute } from "./gltf-mesh-fixture.js";
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
        {node: 0, primitive: 0, material: 0, geometry: 0, name: "gltf_mesh_0", flatNormal: true},
        {node: 0, primitive: 1, material: 1, geometry: 1, name: "gltf_mesh_1", flatNormal: true},
        {node: 2, primitive: 0, material: 2, geometry: 2, name: "first", flatNormal: true},
        {node: 3, primitive: 0, material: 0, geometry: 0, name: "gltf_mesh_3", flatNormal: true},
        {node: 3, primitive: 1, material: 1, geometry: 1, name: "gltf_mesh_4", flatNormal: true},
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
    assert.deepEqual(packed.binary.subarray(0, binary.length), binary);
    assert.ok(packed.binary.length > binary.length);
    assert.throws(() => packagedGltfMeshPlan({} as JsonObject), /missing packaged/);
});


test("packaged geometry carries actual source uploads, generated indices and flat-normal state", async () => {
    const make = () => meshPlanFixture({nodes: [{mesh: 0}], meshes: [{primitives: [{}]}], scenes: [{nodes: [0]}]});
    const original = make();
    const binary = await packageGltfMeshPlan(original.document, original.bin);
    const plan = packagedGltfMeshPlan(original.document), geometry = plan.geometries[0]!;
    assert.deepEqual(readPackedGltfAttribute(original.document, binary, geometry.attributes.POSITION!), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(readPackedGltfAttribute(original.document, binary, geometry.attributes.TEXCOORD_0!), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(readPackedGltfAttribute(original.document, binary, geometry.indices), [0, 1, 2]);
    assert.equal(plan.meshes[0]!.flatNormal, true);
    const changed = make();
    const changedBinary = await packageGltfMeshPlan(changed.document, changed.bin, doctoredContext(module,
        "positionBuffer: createMappedBuffer(engine, meshData._positions!, BU.VERTEX)",
        "positionBuffer: createMappedBuffer(engine, meshData._positions!.map(value => value * 2), BU.VERTEX)"));
    const changedPlan = packagedGltfMeshPlan(changed.document);
    assert.deepEqual(readPackedGltfAttribute(changed.document, changedBinary, changedPlan.geometries[0]!.attributes.POSITION!), [0, 0, 0, 2, 0, 0, 0, 2, 0]);
    const smooth = make();
    await packageGltfMeshPlan(smooth.document, smooth.bin, doctoredContext(module, "_flatNormal: meshData._flatNormal,", "_flatNormal: false,"));
    assert.equal(packagedGltfMeshPlan(smooth.document).meshes[0]!.flatNormal, false);
    assert.notEqual((await gltfRenderables(original.document))[0]!.features, (await gltfRenderables(smooth.document))[0]!.features);
    const invalid = make();
    await assert.rejects(packageGltfMeshPlan(invalid.document, invalid.bin, doctoredContext(module,
        'uint32 ? "uint32" : "uint16"', 'uint32 ? "uint32" : "invalid"')), /index format/);
});

test("interleaved uploads retain shared buffer bytes, attribute offsets and index format", async () => {
    const values = new Float32Array([
        0, 0, 0, 0, 0, 1, 0.2, 0.3,
        1, 0, 0, 0, 0, 1, 0.4, 0.5,
        0, 1, 0, 0, 0, 1, 0.6, 0.7,
    ]);
    const document: JsonObject = {
        buffers: [{byteLength: values.byteLength}],
        bufferViews: [{buffer: 0, byteOffset: 0, byteLength: values.byteLength, byteStride: 32}],
        accessors: [
            {bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"},
            {bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3"},
            {bufferView: 0, byteOffset: 24, componentType: 5126, count: 3, type: "VEC2"},
        ],
        nodes: [{mesh: 0}, {mesh: 0}], scenes: [{nodes: [0, 1]}],
        meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}}]}],
    };
    const binary = await packageGltfMeshPlan(document, new DataView(values.buffer));
    const plan = packagedGltfMeshPlan(document);
    assert.equal(plan.geometries.length, 1);
    assert.deepEqual(plan.meshes.map(mesh => [mesh.geometry, mesh.flatNormal]), [[0, false], [0, false]]);
    const geometry = plan.geometries[0]!;
    assert.deepEqual(readPackedGltfAttribute(document, binary, geometry.attributes.POSITION!), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, geometry.attributes.NORMAL!), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, geometry.attributes.TEXCOORD_0!), [...new Float32Array([0.2, 0.3, 0.4, 0.5, 0.6, 0.7])]);
});

test("source extraction packages normalized color and UV streams with synthesized alpha", async () => {
    for (const [Ctor, componentType, maximum] of [[Uint8Array, 5121, 255], [Uint16Array, 5123, 65535], [Float32Array, 5126, 1]] as const) {
        for (const components of [3, 4]) {
            const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
            const colors = new Ctor(Array.from({length: 3 * components}, (_, index) => [0, maximum / 2, maximum, maximum / 4][index % 4]!));
            const uvs = new Ctor([0, maximum, maximum / 2, maximum / 4, maximum, 0]);
            const uvOffset = positions.byteLength + Math.ceil(colors.byteLength / 4) * 4;
            const source = Buffer.alloc(uvOffset + uvs.byteLength);
            Buffer.from(positions.buffer).copy(source);
            Buffer.from(colors.buffer).copy(source, positions.byteLength);
            Buffer.from(uvs.buffer).copy(source, uvOffset);
            const document: JsonObject = {
                buffers: [{byteLength: source.length}],
                bufferViews: [
                    {buffer: 0, byteOffset: 0, byteLength: positions.byteLength},
                    {buffer: 0, byteOffset: positions.byteLength, byteLength: colors.byteLength},
                    {buffer: 0, byteOffset: uvOffset, byteLength: uvs.byteLength},
                ],
                accessors: [
                    {bufferView: 0, componentType: 5126, count: 3, type: "VEC3"},
                    {bufferView: 1, componentType, count: 3, type: `VEC${components}`, normalized: true},
                    {bufferView: 2, componentType, count: 3, type: "VEC2", normalized: true},
                ],
                nodes: [{mesh: 0}], scenes: [{nodes: [0]}],
                meshes: [{primitives: [{attributes: {POSITION: 0, COLOR_0: 1, TEXCOORD_0: 2}}]}],
            };
            const binary = await packageGltfMeshPlan(document, new DataView(source.buffer, source.byteOffset, source.byteLength));
            const geometry = packagedGltfMeshPlan(document).geometries[0]!;
            const expectedColor = Array.from({length: 12}, (_, index) => index % 4 === 3 && components === 3
                ? 1 : Math.fround(colors[Math.floor(index / 4) * components + index % 4]! / maximum));
            assert.deepEqual(readPackedGltfAttribute(document, binary, geometry.attributes.COLOR_0!), expectedColor);
            assert.deepEqual(readPackedGltfAttribute(document, binary, geometry.attributes.TEXCOORD_0!), [...uvs].map(value => Math.fround(value / maximum)));
        }
    }
});
