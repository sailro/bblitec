// Observes the transformed control's actual PAL bindings against source data
// and the installed pin. Run after an opt-in BBLITE_NODE_GPU_CAPTURE=1 capture.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importPinnedModule } from "../dist/src/pinned-shader-composer.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const [browserPath, ...capturePaths] = process.argv.slice(2);
assert(browserPath && capturePaths.length, "Usage: node tools/check-node-local-attributes.mjs <browser-capture-directory> <native-json> [...]");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const bytes = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
const f32 = values => bytes(Float32Array.from(values));
const asset = json(resolve(root, "examples/assets/regression/node-local-attributes.gltf"));
const binary = Buffer.from(asset.buffers[0].uri.split(",")[1], "base64");
const accessor = index => {
    const entry = asset.accessors[index], view = asset.bufferViews[entry.bufferView];
    assert(!view.byteStride, "This observing control requires tight source attributes");
    const lanes = { VEC2: 2, VEC3: 3, SCALAR: 1 }[entry.type];
    const size = entry.componentType === 5123 ? 2 : 4;
    const offset = (view.byteOffset ?? 0) + (entry.byteOffset ?? 0);
    return binary.subarray(offset, offset + entry.count * lanes * size);
};
const parser = await importPinnedModule("loader-gltf/gltf-parser.js");
const meshes = await importPinnedModule("mesh/mesh.js");
const transforms = await importPinnedModule("scene/transform-node.js");
const expected = asset.nodes.flatMap((node, index) => {
    if (node.mesh === undefined) return [];
    const primitive = asset.meshes[node.mesh].primitives[0];
    const a = primitive.attributes;
    return [{
        name: node.name,
        position: accessor(a.POSITION), normal: accessor(a.NORMAL), uv: accessor(a.TEXCOORD_0),
        world: bytes(parser.computeNodeWorldMatrix(asset, index, parser.buildParentMap(asset), new Map())),
    }];
});
// The third authored object uses ordinary scalar TRS storage. Keep its 1.3
// input: the report exposes inherited float narrowing instead of hiding it.
const parent = transforms.createTransformNode("scene-parent");
parent.position.y = 1.25; parent.rotation.z = -0.2; parent.scaling.x = 1.3;
const local = meshes.initMeshTransform({});
local.parent = parent; local.rotation.y = 0.3; local.scaling.y = 0.8;
expected.push({ name: "scene-local",
    position: f32([-0.6,-0.4,0,0.6,-0.4,0,0.6,0.4,0,-0.6,0.4,0]),
    normal: f32([0.2,0.4,2,0.2,0.4,2,0.2,0.4,2,0.2,0.4,2]),
    uv: f32([0,1,1,1,1,0,0,0]), world: bytes(local.worldMatrix),
});
const browser = json(resolve(browserPath, "buffers.json"));
const uploaded = buffer => {
    const result = Buffer.alloc(buffer.size), coverage = Buffer.alloc(buffer.size);
    for (const write of [...buffer.mappedWrites, ...buffer.writes]) {
        assert(!write.skipped);
        const data = Buffer.from(write.data, "base64");
        data.copy(result, write.offset); coverage.fill(1, write.offset, write.offset + data.length);
    }
    assert(coverage.every(value => value === 1), `Incomplete browser upload ${buffer.id}`);
    return result;
};
const browserVertices = browser.filter(buffer => buffer.usage & 32).map(uploaded);
const browserWorlds = browser.filter(buffer => buffer.label === "node-geom-mesh-ubo").map(uploaded);
for (const object of expected) {
    for (const name of ["position", "normal", "uv"]) {
        assert(browserVertices.some(data => data.equals(object[name])), `${object.name} ${name} absent from actual browser uploads`);
    }
    assert.equal(browserWorlds.filter(data => data.subarray(0,64).equals(object.world)).length, 2,
        `${object.name}: both browser views must upload the actual pin world`);
}
const sourceIndices = [0,1,2,0,2,3];
for (const buffer of browser.filter(buffer => buffer.usage & 16)) {
    const data = uploaded(buffer), componentBytes = data.length / sourceIndices.length;
    assert(componentBytes === 2 || componentBytes === 4);
    const values = sourceIndices.map((_, index) => componentBytes === 2
        ? data.readUInt16LE(index * 2) : data.readUInt32LE(index * 4));
    assert.deepEqual(values, sourceIndices, "The pin binds the original index sequence");
}
const orderedWord = word => word & 0x80000000 ? 0x80000000 - (word & 0x7fffffff) : 0x80000000 + word;
const reports = [];
for (const path of capturePaths) {
    const capture = json(path), gpu = capture.nodeGpu;
    assert(gpu, "Native capture must opt into node GPU receipts");
    assert.equal(gpu.frame, capture.frame);
    assert.equal(gpu.draws.length, 9);
    const resources = new Map(gpu.resources.map(resource => [resource.id, resource]));
    const pipelines = new Map(gpu.pipelines.map(pipeline => [pipeline.id, pipeline]));
    const data = id => {
        const resource = resources.get(id);
        assert(resource && !resource.destroyed);
        assert.deepEqual(resource.writtenRanges, [{ offset: 0, bytes: resource.allocationBytes }]);
        assert.equal(resource.uploadedBytes.length, resource.allocationBytes);
        return Buffer.from(resource.uploadedBytes);
    };
    const geometry = gpu.draws.filter(draw => pipelines.get(draw.pipeline).usesLocalAttributes);
    assert.equal(geometry.length, 6);
    const views = new Set(), meshUbos = new Set(), residuals = [], offsets = new Set();
    const textureBindings = new Set(), samplerBindings = new Set();
    for (const draw of gpu.draws) {
        const pipeline = pipelines.get(draw.pipeline);
        assert.equal(pipeline.samples, 1);
        assert.equal(pipeline.topology, "triangle-list");
        assert.equal(pipeline.frontFace, "ccw");
        assert.equal(pipeline.cullMode, "back");
        assert.deepEqual([draw.indexCount,draw.firstIndex,draw.instanceCount,draw.baseVertex], [6,0,1,0]);
        const indices = data(draw.indices);
        assert.deepEqual(Array.from({length:6}, (_, i) => indices.readUInt32LE(draw.indexOffset + i*4)), sourceIndices);
        for (const binding of draw.bindings) {
            if (binding.role.includes("texture")) textureBindings.add(binding.resource);
            if (binding.role.includes("sampler")) samplerBindings.add(binding.resource);
        }
        if (capture.backend === "dawn") {
            assert(draw.group && draw.meshUniform);
            meshUbos.add(draw.meshUniform);
        } else assert.equal(draw.group, 0);
        if (!pipeline.usesLocalAttributes) continue;
        views.add(pipeline.geometryVariant);
        assert.equal(pipeline.colorTargetCount, 2);
        const object = expected[draw.mesh];
        assert(object);
        const vertexData = data(draw.vertices);
        for (const attribute of pipeline.attributes) {
            assert.equal(attribute.slot, 0);
            const source = object[attribute.name];
            assert(Buffer.isBuffer(source));
            const size = attribute.format === "float32x2" ? 8 : 12;
            assert.equal(attribute.format, size === 8 ? "float32x2" : "float32x3");
            const selected = Buffer.concat(Array.from({length:4}, (_, vertex) => {
                const offset = draw.vertexOffset + vertex * attribute.stride + attribute.offset;
                return vertexData.subarray(offset, offset + size);
            }));
            assert(selected.equals(source), `${object.name} actually bound ${attribute.name} differs from source bytes`);
            offsets.add(`${attribute.name}:${attribute.offset}/${attribute.stride}`);
        }
        const world = capture.backend === "dawn" ? data(draw.meshUniform) : Buffer.from(draw.pushedUniformBytes);
        const differences = [];
        for (let lane = 0; lane < 16; ++lane) {
            const nativeWord = world.readUInt32LE(lane*4), pinWord = object.world.readUInt32LE(lane*4);
            if (nativeWord === pinWord) continue;
            const native = world.readFloatLE(lane*4), pin = object.world.readFloatLE(lane*4);
            const signedZero = native === 0 && pin === 0;
            const ulps = signedZero ? 0 : Math.abs(orderedWord(nativeWord) - orderedWord(pinWord));
            assert(signedZero || (object.name === "scene-local" && ulps <= 2), "Unexpected world transport difference");
            differences.push({ lane, nativeWord, pinWord, native, pin, signedZero, ulps });
        }
        residuals.push({ mesh: draw.mesh, name: object.name, view: pipeline.geometryVariant, differences });
    }
    assert.equal(views.size, 2);
    assert.equal(textureBindings.size, 1, "All three views preserve the material's actual texture binding");
    assert.equal(samplerBindings.size, 1);
    if (capture.backend === "dawn") assert.equal(meshUbos.size, 9, "Every mesh/view owns a distinct UBO");
    reports.push({ backend: capture.backend, frame: gpu.frame, draws: 9, rawGeometryDraws: 6,
        selectedAttributes: [...offsets], sourceIndices, distinctMeshUbos: meshUbos.size,
        sourceAttributeBytesExact: true, residuals });
}
for (const report of reports.slice(1)) {
    assert.deepEqual(report.selectedAttributes, reports[0].selectedAttributes);
    assert.deepEqual(report.residuals, reports[0].residuals, "Both PALs must transport the same world values");
}
const output = resolve(browserPath, "../transport-verification.json");
writeFileSync(output, JSON.stringify({ reports }, null, 2) + "\n");
console.log(JSON.stringify({ output, backends: reports.map(({ backend, draws, distinctMeshUbos }) => ({ backend, draws, distinctMeshUbos })) }));
