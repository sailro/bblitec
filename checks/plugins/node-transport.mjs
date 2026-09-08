// Node-geometry GPU transport: the raw attribute bytes, index sequences,
// texture sharing, per-view bindings and world uploads the native PAL
// binds, joined against the browser's receipts and the source asset.
// Two controls share the decoders: the PowerPlant scene (149), whose
// browser reference directory holds the identity observation and the
// instrumented buffer capture, and the node-local-attributes fixture,
// whose browser side is an instrumented capture of a scene loading it.
// Native receipts are the check's own captures taken with
// BBLITE_NODE_GPU_CAPTURE=1 (`capture.nodeGpu`).
//
// options: { control: "scene149", referenceDirectory?, allowStale? }
//       or { control: "node-local", browserCapture: <directory> }
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GLB_BINARY_CHUNK, GLTF_SOURCE_ALBEDO_IDENTITIES, glbJsonText, instantiatedPrimitiveRecords } from "../../dist/src/gltf-document.js";
import { importPinnedModule } from "../../dist/src/pinned-shader-composer.js";
import { readJson, sha256 } from "./support.mjs";

const rawBytes = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const sourceKeys = { position: "POSITION", normal: "NORMAL", uv: "TEXCOORD_0" };
const bufferKeys = { position: "positionBuffer", normal: "normalBuffer", uv: "uvBuffer" };

function uniqueMap(values, key, label) {
    const result = new Map(values.map((value) => [key(value), value]));
    assert.equal(result.size, values.length, `Duplicate ${label}`);
    return result;
}

function associate(forward, reverse, a, b, label) {
    if (forward.has(a)) assert.equal(forward.get(a), b, `${label}: one source splits`);
    if (reverse.has(b)) assert.equal(reverse.get(b), a, `${label}: distinct sources collapse`);
    forward.set(a, b);
    reverse.set(b, a);
}

function selectedAttribute(bytes, count, offset, stride, width) {
    assert(Number.isInteger(count) && count > 0 && offset >= 0 && stride >= width);
    assert(offset + (count - 1) * stride + width <= bytes.length, "Attribute selection exceeds upload");
    const selected = Buffer.alloc(count * width);
    for (let i = 0; i < count; ++i) bytes.copy(selected, i * width, offset + i * stride, offset + i * stride + width);
    return selected;
}

function selectedIndices(bytes, format, offset, count, first = 0) {
    assert(format === "uint16" || format === "uint32");
    const width = format === "uint16" ? 2 : 4;
    assert(offset >= 0 && offset + (first + count) * width <= bytes.length);
    const selected = Buffer.alloc(count * 4);
    for (let i = 0; i < count; ++i) selected.writeUInt32LE(
        width === 2 ? bytes.readUInt16LE(offset + (first + i) * width) : bytes.readUInt32LE(offset + (first + i) * width), i * 4);
    return selected;
}

/** The bytes an instrumented browser buffer holds after its mapped and queued writes. */
export function browserUpload(buffer) {
    const bytes = Buffer.alloc(buffer.size);
    const covered = Buffer.alloc(buffer.size);
    for (const write of [...buffer.mappedWrites, ...buffer.writes]) {
        assert(!write.skipped, `browser upload ${buffer.id} was too large to record`);
        const data = Buffer.from(write.data, "base64");
        assert(write.offset >= 0 && write.offset + data.length <= bytes.length);
        data.copy(bytes, write.offset);
        covered.fill(1, write.offset, write.offset + data.length);
    }
    return { bytes, covered };
}

/** A native nodeGpu resource's uploaded bytes, whole. */
function nativeUpload(resources, decoded, id) {
    if (decoded.has(id)) return decoded.get(id);
    const value = resources.get(id);
    assert(value && !value.destroyed, `Invalid resource ${id}`);
    assert.deepEqual(value.writtenRanges, [{ offset: 0, bytes: value.allocationBytes }]);
    assert.equal(value.uploadedBytes.length, value.allocationBytes);
    const bytes = Buffer.from(value.uploadedBytes);
    decoded.set(id, bytes);
    return bytes;
}

function viewSummary(views) {
    assert.deepEqual([...views.keys()].sort((a, b) => a - b), [1, 4, 7]);
    return [...views].map(([targets, view]) => {
        assert.deepEqual([view.draws, view.meshes.size, view.materials.size], [285, 285, 79]);
        return { targets, draws: view.draws, meshes: view.meshes.size, materials: view.materials.size };
    });
}

function countDraw(views, targets, mesh, material) {
    if (!views.has(targets)) views.set(targets, { draws: 0, meshes: new Set(), materials: new Set() });
    const view = views.get(targets);
    assert(!view.meshes.has(mesh), `Repeated mesh ${mesh} in ${targets}-target view`);
    ++view.draws;
    view.meshes.add(mesh);
    view.materials.add(material);
}

async function readScene149Reference(referenceDirectory, generatedDirectory) {
    const identity = readJson(join(referenceDirectory, "identities.json"));
    const raw = readJson(join(referenceDirectory, "instrumented/buffers.json"));
    const meta = readJson(join(referenceDirectory, "instrumented/capture-meta.json"));
    assert.equal(meta.moduleSha256, identity.moduleSha256);
    assert.equal(identity.comparison.mad, 0, "Identity instrumentation changes canonical pixels");
    const manifest = readJson(join(generatedDirectory, "manifest.json"));
    assert.equal(sha256(readFileSync(manifest.source)), identity.sourceSha256, "Generated source differs from browser source");
    const assets = manifest.assets.filter((asset) => asset.kind === "gltf");
    assert.equal(assets.length, 1);
    const glb = readFileSync(join(generatedDirectory, "assets", assets[0].output));
    const document = JSON.parse(glbJsonText(glb));
    const binaryHeader = 20 + glb.readUInt32LE(12);
    assert.equal(glb.readUInt32LE(binaryHeader + 4), GLB_BINARY_CHUNK);
    const binary = glb.subarray(binaryHeader + 8, binaryHeader + 8 + glb.readUInt32LE(binaryHeader));
    const primitives = instantiatedPrimitiveRecords(document);
    assert.equal(primitives.length, 285);
    const associations = document[GLTF_SOURCE_ALBEDO_IDENTITIES]?.materials;
    assert.equal(associations?.length, document.materials.length + 1);
    const parser = await importPinnedModule("loader-gltf/gltf-parser.js");
    const browserResources = identity.observation.resources.filter((resource) => resource.kind === "buffer");
    assert.equal(browserResources.length, raw.length);
    const uploads = new Map();
    for (const resource of browserResources) {
        const buffer = raw[resource.ordinal - 1];
        assert.deepEqual([resource.label ?? "", resource.size, resource.usage], [buffer.label, buffer.size, buffer.usage]);
        uploads.set(resource.id, browserUpload(buffer));
    }
    const upload = (id) => {
        const value = uploads.get(id);
        assert(value && value.covered.every((byte) => byte === 1), `Incomplete browser upload ${id}`);
        return value.bytes;
    };
    const owners = uniqueMap(identity.groups.flatMap((group) => group.meshes.map((mesh) => {
        assert(group.sameSourceTexture && group.sameOwner, "Browser node material must retain its source owner/texture");
        const match = /^gltf_mesh_(\d+)$/.exec(mesh.name);
        assert(match, `Unexpected source mesh name ${mesh.name}`);
        return { index: Number(match[1]), group, mesh };
    })), (owner) => owner.index, "source mesh index");
    assert.deepEqual([...owners.keys()].sort((a, b) => a - b), Array.from({ length: 285 }, (_, i) => i));
    const sourceMaterials = new Map(), originalMaterials = new Map(), partition = new Map(), sourceTextures = new Map();
    for (const owner of owners.values()) {
        const primitive = primitives[owner.index];
        owner.attributes = {};
        for (const [name, key] of Object.entries(sourceKeys)) {
            const values = parser.resolveAccessor(document, binary, primitive.attributes[key]);
            const bytes = rawBytes(values._data);
            assert(upload(owner.mesh.gpuBuffers[bufferKeys[name]]).equals(bytes), `${owner.mesh.name}: ${key} does not match the generated asset's node/primitive row`);
            owner.attributes[name] = bytes;
            if (name === "position") owner.vertexCount = values._count;
        }
        const indices = parser.resolveAccessor(document, binary, primitive.indices)._data;
        owner.indices = selectedIndices(rawBytes(indices), indices.BYTES_PER_ELEMENT === 2 ? "uint16" : "uint32", 0, indices.length);
        owner.indexCount = indices.length;
        const sourceMaterial = primitive.material ?? document.materials.length;
        associate(sourceMaterials, originalMaterials, sourceMaterial, owner.group.original, "Asset/browser material ownership");
        associate(partition, sourceTextures, associations[sourceMaterial], owner.group.texture, "Asset/browser Texture2D partition");
        assert.equal(owner.mesh.worldType, "Float32Array");
        assert.equal(owner.mesh.worldBytes.length, 64);
        owner.world = Buffer.from(owner.mesh.worldBytes);
    }
    assert.equal(sourceMaterials.size, 79);
    assert.equal(partition.size, 65);
    assert.equal(new Set(identity.groups.map((group) => group.sampler)).size, 1);
    const groups = uniqueMap(identity.observation.groups, (group) => group.id, "browser group");
    const pipelines = uniqueMap(identity.observation.pipelines, (pipeline) => pipeline.id, "browser pipeline");
    const bufferOwners = uniqueMap([...owners.values()], (owner) => `${owner.mesh.gpuBuffers.positionBuffer}/${owner.mesh.gpuBuffers.indexBuffer}`, "browser vertex/index owner");
    const submissions = identity.observation.submissions.map((draws) => {
        const indexed = draws.filter((draw) => draw.method === "drawIndexed");
        assert.equal(indexed.length, 855);
        const views = new Map(), worldBuffers = new Set();
        for (const draw of indexed) {
            const matching = Object.values(draw.vertices).map((vertex) => bufferOwners.get(`${vertex.buffer}/${draw.index.buffer}`)).filter(Boolean);
            assert.equal(matching.length, 1, "Actual browser bindings must identify one source mesh");
            const owner = matching[0], pipeline = pipelines.get(draw.pipeline), targets = pipeline.fragment.targets.length;
            countDraw(views, targets, owner.index, owner.group.material);
            assert.deepEqual([draw.args[0], draw.args[1] ?? 1, draw.args[2] ?? 0, draw.args[3] ?? 0, draw.args[4] ?? 0], [owner.indexCount, 1, 0, 0, 0]);
            assert(selectedIndices(upload(draw.index.buffer), draw.index.format, draw.index.offset ?? 0, owner.indexCount).equals(owner.indices));
            const entries = groups.get(draw.groups[1].group).entries;
            assert(entries.some((binding) => binding.resource === owner.group.view));
            assert(entries.some((binding) => binding.resource === owner.group.sampler));
            const ubo = entries.find((binding) => binding.binding === 0).resource;
            assert(upload(ubo).subarray(0, 64).equals(owner.world), `${owner.mesh.name}: browser bound world differs from source`);
            worldBuffers.add(ubo);
            if (targets === 1) continue;
            for (const [name, key] of Object.entries(bufferKeys)) {
                const selected = Object.entries(draw.vertices).filter(([, vertex]) => vertex.buffer === owner.mesh.gpuBuffers[key]);
                assert.equal(selected.length, 1);
                const [slot, vertex] = selected[0], layout = pipeline.vertex.buffers[slot];
                assert.equal(layout.attributes.length, 1);
                const attribute = layout.attributes[0], width = name === "uv" ? 8 : 12;
                assert.equal(attribute.format, name === "uv" ? "float32x2" : "float32x3");
                assert(selectedAttribute(upload(vertex.buffer), owner.vertexCount, (vertex.offset ?? 0) + attribute.offset, layout.arrayStride, width).equals(owner.attributes[name]));
            }
        }
        assert.equal(worldBuffers.size, 855);
        return viewSummary(views);
    });
    assert(submissions.length > 0);
    return { owners, sourceSha256: identity.sourceSha256, moduleSha256: identity.moduleSha256,
        generatedStamp: readJson(join(generatedDirectory, "build-inputs.json")).stamp,
        browser: { buffers: raw.length, submissions, sourceMaterials: sourceMaterials.size, sourceTextures: partition.size, sourceSamplers: 1,
            assetSha256: sha256(glb), texturePartition: [...partition].map(([association, texture]) => ({ association, texture,
                materials: [...sourceMaterials.keys()].filter((index) => associations[index] === association) })) } };
}

function checkScene149Native(capture, reference, { allowStale = false } = {}) {
    const gpu = capture.nodeGpu;
    assert(gpu, "the native capture carries no nodeGpu receipts (BBLITE_NODE_GPU_CAPTURE=1)");
    assert.match(capture.buildStamp, /^[a-f0-9]{64}$/);
    if (!allowStale) assert.equal(capture.buildStamp, reference.generatedStamp, "Capture predates the current generated build");
    assert.equal(gpu.frame, capture.frame);
    assert.equal(gpu.draws.length, 855);
    assert.equal(capture.meshes.length, 285);
    const meshes = uniqueMap(capture.meshes, (mesh) => mesh.index, "native mesh");
    const resources = uniqueMap(gpu.resources, (resource) => resource.id, "native resource");
    const pipelines = uniqueMap(gpu.pipelines, (pipeline) => pipeline.id, "native pipeline");
    const decoded = new Map();
    const resource = (id) => { const value = resources.get(id); assert(value && !value.destroyed, `Invalid resource ${id}`); return value; };
    const upload = (id) => nativeUpload(resources, decoded, id);
    const views = new Map(), ubos = new Set(), materials = new Map(), reverseMaterials = new Map();
    const textureBindings = new Map(), worldResiduals = [], layouts = new Set();
    let geometryDraws = 0, exactWorlds = 0;
    for (const draw of gpu.draws) {
        const owner = reference.owners.get(draw.mesh), mesh = meshes.get(draw.mesh), pipeline = pipelines.get(draw.pipeline);
        assert(owner && mesh && pipeline);
        assert.equal(mesh.material, draw.material);
        associate(materials, reverseMaterials, draw.material, owner.group.material, "Native/browser material ownership");
        countDraw(views, pipeline.colorTargetCount, draw.mesh, draw.material);
        assert.deepEqual([pipeline.samples, pipeline.topology, pipeline.cullMode, pipeline.frontFace], [4, "triangle-list", "back", "ccw"]);
        assert.deepEqual([draw.indexCount, draw.firstIndex, draw.instanceCount, draw.baseVertex], [owner.indexCount, 0, 1, 0]);
        assert.equal(mesh.geometryInfo.vertexCount, owner.vertexCount);
        assert(selectedIndices(upload(draw.indices), "uint32", draw.indexOffset, draw.indexCount, draw.firstIndex).equals(owner.indices), `${owner.mesh.name}: bound source indices differ`);
        const textures = draw.bindings.filter((binding) => binding.role.includes("texture"));
        const samplers = draw.bindings.filter((binding) => binding.role.includes("sampler"));
        assert.equal(textures.length, 1);
        assert.equal(samplers.length, 1);
        resource(textures[0].resource);
        resource(samplers[0].resource);
        if (capture.backend === "dawn") { resource(textures[0].view); resource(draw.group); }
        const bindings = [textures[0].resource, textures[0].view, samplers[0].resource];
        if (textureBindings.has(draw.material)) assert.deepEqual(bindings, textureBindings.get(draw.material), `Material ${draw.material} changes texture/sampler across views`);
        textureBindings.set(draw.material, bindings);
        if (capture.backend === "dawn") {
            assert(draw.meshUniform && draw.bindings.some((binding) => binding.role === "meshU" && binding.resource === draw.meshUniform));
            ubos.add(draw.meshUniform);
        } else assert.equal(draw.group, 0);
        assert.equal(pipeline.usesLocalAttributes, pipeline.colorTargetCount !== 1);
        if (!pipeline.usesLocalAttributes) continue;
        ++geometryDraws;
        assert.deepEqual(pipeline.attributes.map((attribute) => attribute.name).sort(), ["normal", "position", "uv"]);
        for (const attribute of pipeline.attributes) {
            const width = attribute.name === "uv" ? 8 : 12;
            assert.equal(attribute.slot, 0);
            assert.equal(attribute.format, width === 8 ? "float32x2" : "float32x3");
            assert(selectedAttribute(upload(draw.vertices), owner.vertexCount, draw.vertexOffset + attribute.offset, attribute.stride, width).equals(owner.attributes[attribute.name]), `${owner.mesh.name}: actually bound ${attribute.name} differs from browser/asset bytes`);
            layouts.add(`${attribute.name}:${attribute.offset}/${attribute.stride}`);
        }
        const world = capture.backend === "dawn" ? upload(draw.meshUniform) : Buffer.from(draw.pushedUniformBytes);
        assert(world.length >= 64);
        if (world.subarray(0, 64).equals(owner.world)) { ++exactWorlds; continue; }
        const differences = [];
        for (let lane = 0; lane < 16; ++lane) {
            const nativeWord = world.readUInt32LE(lane * 4), browserWord = owner.world.readUInt32LE(lane * 4);
            if (nativeWord === browserWord) continue;
            const native = world.readFloatLE(lane * 4), browser = owner.world.readFloatLE(lane * 4);
            differences.push({ lane, nativeWord, browserWord, native, browser, signedZero: native === 0 && browser === 0 });
        }
        // The coordinate adapter can change a zero's sign; those words are
        // retained verbatim, and every nonzero numeric difference fails.
        assert(differences.every((difference) => difference.signedZero), `${owner.mesh.name}: nonzero numeric world difference: ${JSON.stringify(differences)}`);
        worldResiduals.push({ mesh: draw.mesh, view: pipeline.colorTargetCount, differences });
    }
    assert.equal(geometryDraws, 570);
    assert.equal(materials.size, 79);
    if (capture.backend === "dawn") assert.equal(ubos.size, 855);
    return { backend: capture.backend, buildStamp: capture.buildStamp,
        matchesCurrentGeneratedBuild: capture.buildStamp === reference.generatedStamp,
        frame: capture.frame, views: viewSummary(views),
        geometryDraws, rawAttributeBytesExact: true, sourceIndicesExact: true, selectedLayouts: [...layouts],
        distinctMeshUbos: ubos.size, materialBindings: [...textureBindings].map(([material, [texture, view, sampler]]) => ({ material, texture, view, sampler })),
        textureAllocations: new Set([...textureBindings.values()].map((binding) => binding[0])).size,
        samplerAllocations: new Set([...textureBindings.values()].map((binding) => binding[2])).size,
        world: { exactDraws: exactWorlds, byteExact: worldResiduals.length === 0,
            numericExact: worldResiduals.every((row) => row.differences.every((difference) => difference.signedZero)), residuals: worldResiduals } };
}

async function checkNodeLocal(browserCapture, captures) {
    const asset = readJson(resolve("examples/assets/regression/node-local-attributes.gltf"));
    const binary = Buffer.from(asset.buffers[0].uri.split(",")[1], "base64");
    const bytes = (values) => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const f32 = (values) => bytes(Float32Array.from(values));
    const accessor = (index) => {
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
        return [{ name: node.name, position: accessor(a.POSITION), normal: accessor(a.NORMAL), uv: accessor(a.TEXCOORD_0),
            world: bytes(parser.computeNodeWorldMatrix(asset, index, parser.buildParentMap(asset), new Map())) }];
    });
    // The third authored object uses ordinary scalar TRS storage; its 1.3
    // input exposes inherited float narrowing instead of hiding it.
    const parent = transforms.createTransformNode("scene-parent");
    parent.position.y = 1.25; parent.rotation.z = -0.2; parent.scaling.x = 1.3;
    const local = meshes.initMeshTransform({});
    local.parent = parent; local.rotation.y = 0.3; local.scaling.y = 0.8;
    expected.push({ name: "scene-local", position: f32([-0.6, -0.4, 0, 0.6, -0.4, 0, 0.6, 0.4, 0, -0.6, 0.4, 0]),
        normal: f32([0.2, 0.4, 2, 0.2, 0.4, 2, 0.2, 0.4, 2, 0.2, 0.4, 2]), uv: f32([0, 1, 1, 1, 1, 0, 0, 0]), world: bytes(local.worldMatrix) });
    const browser = readJson(resolve(browserCapture, "buffers.json"));
    const uploaded = (buffer) => {
        const { bytes: data, covered } = browserUpload(buffer);
        assert(covered.every((value) => value === 1), `Incomplete browser upload ${buffer.id}`);
        return data;
    };
    const browserVertices = browser.filter((buffer) => buffer.usage & 32).map(uploaded);
    const browserWorlds = browser.filter((buffer) => buffer.label === "node-geom-mesh-ubo").map(uploaded);
    for (const object of expected) {
        for (const name of ["position", "normal", "uv"]) {
            assert(browserVertices.some((data) => data.equals(object[name])), `${object.name} ${name} absent from actual browser uploads`);
        }
        assert.equal(browserWorlds.filter((data) => data.subarray(0, 64).equals(object.world)).length, 2, `${object.name}: both browser views must upload the actual pin world`);
    }
    const sourceIndices = [0, 1, 2, 0, 2, 3];
    for (const buffer of browser.filter((entry) => entry.usage & 16)) {
        const data = uploaded(buffer), componentBytes = data.length / sourceIndices.length;
        assert(componentBytes === 2 || componentBytes === 4);
        const values = sourceIndices.map((_, index) => componentBytes === 2 ? data.readUInt16LE(index * 2) : data.readUInt32LE(index * 4));
        assert.deepEqual(values, sourceIndices, "The pin binds the original index sequence");
    }
    const orderedWord = (word) => word & 0x80000000 ? 0x80000000 - (word & 0x7fffffff) : 0x80000000 + word;
    const reports = [];
    for (const capture of captures) {
        const gpu = capture.nodeGpu;
        assert(gpu, "Native capture must opt into node GPU receipts");
        assert.equal(gpu.frame, capture.frame);
        assert.equal(gpu.draws.length, 9);
        const resources = new Map(gpu.resources.map((resource) => [resource.id, resource]));
        const pipelines = new Map(gpu.pipelines.map((pipeline) => [pipeline.id, pipeline]));
        const decoded = new Map();
        const data = (id) => nativeUpload(resources, decoded, id);
        const geometry = gpu.draws.filter((draw) => pipelines.get(draw.pipeline).usesLocalAttributes);
        assert.equal(geometry.length, 6);
        const views = new Set(), meshUbos = new Set(), residuals = [], offsets = new Set();
        const textureBindings = new Set(), samplerBindings = new Set();
        for (const draw of gpu.draws) {
            const pipeline = pipelines.get(draw.pipeline);
            assert.equal(pipeline.samples, 1);
            assert.equal(pipeline.topology, "triangle-list");
            assert.equal(pipeline.frontFace, "ccw");
            assert.equal(pipeline.cullMode, "back");
            assert.deepEqual([draw.indexCount, draw.firstIndex, draw.instanceCount, draw.baseVertex], [6, 0, 1, 0]);
            const indices = data(draw.indices);
            assert.deepEqual(Array.from({ length: 6 }, (_, i) => indices.readUInt32LE(draw.indexOffset + i * 4)), sourceIndices);
            for (const binding of draw.bindings) {
                if (binding.role.includes("texture")) textureBindings.add(binding.resource);
                if (binding.role.includes("sampler")) samplerBindings.add(binding.resource);
            }
            if (capture.backend === "dawn") { assert(draw.group && draw.meshUniform); meshUbos.add(draw.meshUniform); } else assert.equal(draw.group, 0);
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
                const selected = Buffer.concat(Array.from({ length: 4 }, (_, vertex) => {
                    const offset = draw.vertexOffset + vertex * attribute.stride + attribute.offset;
                    return vertexData.subarray(offset, offset + size);
                }));
                assert(selected.equals(source), `${object.name} actually bound ${attribute.name} differs from source bytes`);
                offsets.add(`${attribute.name}:${attribute.offset}/${attribute.stride}`);
            }
            const world = capture.backend === "dawn" ? data(draw.meshUniform) : Buffer.from(draw.pushedUniformBytes);
            const differences = [];
            for (let lane = 0; lane < 16; ++lane) {
                const nativeWord = world.readUInt32LE(lane * 4), pinWord = object.world.readUInt32LE(lane * 4);
                if (nativeWord === pinWord) continue;
                const native = world.readFloatLE(lane * 4), pin = object.world.readFloatLE(lane * 4);
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
        reports.push({ backend: capture.backend, frame: gpu.frame, draws: 9, rawGeometryDraws: 6, selectedAttributes: [...offsets], sourceIndices,
            distinctMeshUbos: meshUbos.size, sourceAttributeBytesExact: true, residuals });
    }
    for (const report of reports.slice(1)) {
        assert.deepEqual(report.selectedAttributes, reports[0].selectedAttributes);
        assert.deepEqual(report.residuals, reports[0].residuals, "Both PALs must transport the same world values");
    }
    return reports;
}

export async function check(context) {
    const captures = context.backends.map((backend) => {
        const phase = context.results[backend].canonical;
        assert(phase, `${backend}: the check declares no canonical phase`);
        return phase.capture;
    });
    if (context.options.control === "node-local") {
        assert(typeof context.options.browserCapture === "string", "options.browserCapture names the instrumented browser capture directory");
        return { details: await checkNodeLocal(resolve(context.options.browserCapture), captures) };
    }
    const referenceDirectory = resolve(context.options.referenceDirectory ?? "artifacts/scene149-reference");
    const reference = await readScene149Reference(referenceDirectory, resolve(context.target.output));
    const backends = captures.map((capture) => checkScene149Native(capture, reference, { allowStale: context.options.allowStale === true }));
    if (backends.length === 2) {
        assert.equal(backends[0].buildStamp, backends[1].buildStamp, "The backends come from different builds");
        assert.deepEqual(backends[0].world.residuals, backends[1].world.residuals, "Backends disagree on actual world transport");
    }
    for (const result of backends) {
        context.log(`${result.backend}: ${result.geometryDraws} geometry draws, world ${result.world.byteExact ? "byte-exact" : `${result.world.residuals.length} signed-zero residual draw(s)`}`);
    }
    return { details: { sourceSha256: reference.sourceSha256, moduleSha256: reference.moduleSha256, generatedStamp: reference.generatedStamp, browser: reference.browser, backends,
        bitExactWorld: backends.every((result) => result.world.byteExact), numericWorldEqual: backends.every((result) => result.world.numericExact) } };
}
