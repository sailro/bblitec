import assert from "node:assert/strict";
import test from "node:test";
import { BinaryBuilder } from "../src/glb-binary-builder.js";
import { GLTF_MESH_PLAN, type JsonObject } from "../src/gltf-document.js";
import { packageGltfMeshPlan, packagedGltfMeshPlan } from "../src/gltf-mesh-plan.js";
import { gltfRenderables } from "../src/pinned-material-arms.js";
import { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";
import { readPackedGltfAttribute } from "./gltf-mesh-fixture.js";

function fixture() {
    const binary = new BinaryBuilder(Buffer.alloc(0));
    const accessors: JsonObject[] = [], bufferViews: JsonObject[] = [];
    const append = (data: Float32Array | Uint8Array, type: string, normalized = false): number => {
        const components = type === "VEC3" ? 3 : 4;
        bufferViews.push({buffer: 0, byteOffset: binary.append(data), byteLength: data.byteLength});
        accessors.push({bufferView: bufferViews.length - 1, componentType: data instanceof Float32Array ? 5126 : 5121,
            count: data.length / components, type, normalized});
        return accessors.length - 1;
    };
    const positions = append(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), "VEC3");
    const joints = append(new Uint8Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), "VEC4");
    const weights = append(new Uint8Array([128, 127, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0]), "VEC4", true);
    const deltas = append(new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3]), "VEC3");
    const normalDeltas = append(new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0]), "VEC3");
    const primitive: JsonObject = {attributes: {POSITION: positions, JOINTS_0: joints, WEIGHTS_0: weights}, targets: [{POSITION: deltas}, {NORMAL: normalDeltas}]};
    const document: JsonObject = {
        asset: {version: "2.0"}, buffers: [{byteLength: binary.byteLength}], bufferViews, accessors,
        skins: [{joints: [1, 2]}], nodes: [{mesh: 0, skin: 0, weights: [0.9, 0.8]}, {}, {translation: [0, 1, 0]}],
        meshes: [{primitives: [primitive], weights: [0.25]}], scenes: [{nodes: [0, 1, 2]}],
    };
    const bytes = binary.build();
    return {document, primitive, bin: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

async function packaged(context?: LoweringContext) {
    const {document, bin} = fixture();
    const binary = await packageGltfMeshPlan(document, bin, context);
    return {document, binary, mesh: packagedGltfMeshPlan(document).meshes[0]!};
}

test("source features construct joint weights, morph deltas and per-mesh default weights", async () => {
    const {document, binary, mesh} = await packaged();
    assert.equal(mesh.skin?.boneCount, 2);
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.skin!.joints), [0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.skin!.weights), [128, 127, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0].map(value => Math.fround(value / 255)));
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.morph!.weights), [0.25, 0]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.morph!.positions[0]!), [0, 0, 1, 0, 0, 2, 0, 0, 3]);
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.morph!.positions[1]!), Array(9).fill(0));
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.morph!.normals[0]!), Array(9).fill(0));
    assert.deepEqual(readPackedGltfAttribute(document, binary, mesh.morph!.normals[1]!), [1, 0, 0, 2, 0, 0, 3, 0, 0]);
});

test("source discovery and per-mesh guards determine actual attachments and composition", async () => {
    const ordinary = await packaged();
    const filtered = await packaged(doctoredContext("src/loader-gltf/load-gltf.ts", "_appendEnabledGltfFeatures(json, features);", "features.length = 0;"));
    assert.equal(filtered.mesh.skin, undefined);
    assert.equal(filtered.mesh.morph, undefined);
    assert.notEqual((await gltfRenderables(ordinary.document))[0]!.features, (await gltfRenderables(filtered.document))[0]!.features);
    const guarded = await packaged(doctoredContext("src/loader-gltf/gltf-feature-skeleton.ts", "if (!joints || !weightsRaw)", "if (true)"));
    assert.equal(guarded.mesh.skin, undefined);
    assert.ok(guarded.mesh.morph);
});

test("source normalization and GPU constructor writes control packaged deformation data", async () => {
    const normalized = await packaged(doctoredContext("src/loader-gltf/gltf-feature-skeleton.ts", "1 / 255", "1 / 128"));
    assert.equal(readPackedGltfAttribute(normalized.document, normalized.binary, normalized.mesh.skin!.weights)[0], 1);
    const changed = await packaged(doctoredContext("src/morph/create-morph-targets.ts", "deltaData[o + 2] = tgt.positions[v * 3 + 2]!;", "deltaData[o + 2] = tgt.positions[v * 3 + 2]! * 2;"));
    assert.deepEqual(readPackedGltfAttribute(changed.document, changed.binary, changed.mesh.morph!.positions[0]!), [0, 0, 2, 0, 0, 4, 0, 0, 6]);
    const weights = await packaged(doctoredContext("src/morph/create-morph-targets.ts", "morphWeights?.[i] ?? 0", "morphWeights?.[i] ?? 0.5"));
    assert.deepEqual(readPackedGltfAttribute(weights.document, weights.binary, weights.mesh.morph!.weights), [0.25, 0.5]);
    const signed = await packaged(doctoredContext("src/morph/create-morph-targets.ts", "morphWeights?.[i] ?? 0", "morphWeights?.[i] ?? -0"));
    assert.ok(Object.is(readPackedGltfAttribute(signed.document, signed.binary, signed.mesh.morph!.weights)[1], -0));
    await assert.rejects(packaged(doctoredContext("src/morph/create-morph-targets.ts", "MORPH_FLOATS_PER_VERTEX = 6", "MORPH_FLOATS_PER_VERTEX = 7")), /morph storage layout/);
});

test("packaged deformation metadata rejects invalid resource indices and mismatched targets", async () => {
    const {document, mesh} = await packaged();
    const plan = packagedGltfMeshPlan(document);
    for (const value of [{...mesh, skin: {...mesh.skin, index: 99}}, {...mesh, skin: {...mesh.skin, weights: 999}},
        {...mesh, morph: {...mesh.morph, positions: []}}, {...mesh, morph: {...mesh.morph, weights: 999}}])
        assert.throws(() => packagedGltfMeshPlan({...document, [GLTF_MESH_PLAN]: {...plan, meshes: [value]}}), /Invalid packaged glTF/);
});
