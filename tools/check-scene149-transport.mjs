// Read-only proof over saved browser/native GPU receipts. No GPU or rebuild.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GLB_BINARY_CHUNK, glbJsonText, instantiatedPrimitiveRecords } from "../dist/src/gltf-document.js";
import { importPinnedModule } from "../dist/src/pinned-shader-composer.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const rawBytes = view => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const sourceKeys = { position: "POSITION", normal: "NORMAL", uv: "TEXCOORD_0" };
const bufferKeys = { position: "positionBuffer", normal: "normalBuffer", uv: "uvBuffer" };

function uniqueMap(values, key, label) {
    const result = new Map(values.map(value => [key(value), value]));
    assert.equal(result.size, values.length, `Duplicate ${label}`);
    return result;
}

function associate(forward, reverse, a, b, label) {
    if (forward.has(a)) assert.equal(forward.get(a), b, `${label}: one source splits`);
    if (reverse.has(b)) assert.equal(reverse.get(b), a, `${label}: distinct sources collapse`);
    forward.set(a, b); reverse.set(b, a);
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
    ++view.draws; view.meshes.add(mesh); view.materials.add(material);
}

export async function readScene149Reference(referenceDirectory, generatedDirectory) {
    const identity = json(join(referenceDirectory, "identities.json"));
    const raw = json(join(referenceDirectory, "instrumented/buffers.json"));
    const meta = json(join(referenceDirectory, "instrumented/capture-meta.json"));
    assert.equal(meta.moduleSha256, identity.moduleSha256);
    assert.equal(identity.comparison.mad, 0, "Identity instrumentation changes canonical pixels");
    const manifest = json(join(generatedDirectory, "manifest.json"));
    assert.equal(sha(readFileSync(manifest.source)), identity.sourceSha256, "Generated source differs from browser source");
    const assets = manifest.assets.filter(asset => asset.kind === "gltf");
    assert.equal(assets.length, 1);
    const assetPath = join(generatedDirectory, "assets", assets[0].output);
    const glb = readFileSync(assetPath), document = JSON.parse(glbJsonText(glb));
    const binaryHeader = 20 + glb.readUInt32LE(12);
    assert.equal(glb.readUInt32LE(binaryHeader + 4), GLB_BINARY_CHUNK);
    const binary = glb.subarray(binaryHeader + 8, binaryHeader + 8 + glb.readUInt32LE(binaryHeader));
    const primitives = instantiatedPrimitiveRecords(document);
    assert.equal(primitives.length, 285);
    const associations = document.__bblitecSourceAlbedoIdentities?.materials;
    assert.equal(associations?.length, document.materials.length + 1);
    const parser = await importPinnedModule("loader-gltf/gltf-parser.js");
    const browserResources = identity.observation.resources.filter(resource => resource.kind === "buffer");
    assert.equal(browserResources.length, raw.length);
    const uploads = new Map();
    for (const resource of browserResources) {
        const buffer = raw[resource.ordinal - 1];
        assert.deepEqual([resource.label ?? "", resource.size, resource.usage], [buffer.label, buffer.size, buffer.usage]);
        const bytes = Buffer.alloc(buffer.size), covered = Buffer.alloc(buffer.size);
        for (const write of [...buffer.mappedWrites, ...buffer.writes]) {
            assert(!write.skipped);
            const data = Buffer.from(write.data, "base64");
            assert(write.offset >= 0 && write.offset + data.length <= bytes.length);
            data.copy(bytes, write.offset); covered.fill(1, write.offset, write.offset + data.length);
        }
        uploads.set(resource.id, { bytes, covered });
    }
    const upload = id => {
        const value = uploads.get(id);
        assert(value && value.covered.every(byte => byte === 1), `Incomplete browser upload ${id}`);
        return value.bytes;
    };
    const owners = uniqueMap(identity.groups.flatMap(group => group.meshes.map(mesh => {
        assert(group.sameSourceTexture && group.sameOwner, "Browser node material must retain its source owner/texture");
        const match = /^gltf_mesh_(\d+)$/.exec(mesh.name);
        assert(match, `Unexpected source mesh name ${mesh.name}`);
        return { index: Number(match[1]), group, mesh };
    })), owner => owner.index, "source mesh index");
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
    assert.equal(new Set(identity.groups.map(group => group.sampler)).size, 1);
    const groups = uniqueMap(identity.observation.groups, group => group.id, "browser group");
    const pipelines = uniqueMap(identity.observation.pipelines, pipeline => pipeline.id, "browser pipeline");
    const bufferOwners = uniqueMap([...owners.values()], owner => `${owner.mesh.gpuBuffers.positionBuffer}/${owner.mesh.gpuBuffers.indexBuffer}`, "browser vertex/index owner");
    const submissions = identity.observation.submissions.map(draws => {
        const indexed = draws.filter(draw => draw.method === "drawIndexed");
        assert.equal(indexed.length, 855);
        const views = new Map(), worldBuffers = new Set();
        for (const draw of indexed) {
            const matching = Object.values(draw.vertices).map(vertex => bufferOwners.get(`${vertex.buffer}/${draw.index.buffer}`)).filter(Boolean);
            assert.equal(matching.length, 1, "Actual browser bindings must identify one source mesh");
            const owner = matching[0], pipeline = pipelines.get(draw.pipeline), targets = pipeline.fragment.targets.length;
            countDraw(views, targets, owner.index, owner.group.material);
            assert.deepEqual([draw.args[0], draw.args[1] ?? 1, draw.args[2] ?? 0, draw.args[3] ?? 0, draw.args[4] ?? 0], [owner.indexCount, 1, 0, 0, 0]);
            assert(selectedIndices(upload(draw.index.buffer), draw.index.format, draw.index.offset ?? 0, owner.indexCount).equals(owner.indices));
            const entries = groups.get(draw.groups[1].group).entries;
            assert(entries.some(binding => binding.resource === owner.group.view));
            assert(entries.some(binding => binding.resource === owner.group.sampler));
            const ubo = entries.find(binding => binding.binding === 0).resource;
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
        generatedStamp: json(join(generatedDirectory, "build-inputs.json")).stamp,
        browser: { buffers: raw.length, submissions, sourceMaterials: sourceMaterials.size, sourceTextures: partition.size, sourceSamplers: 1,
            assetSha256: sha(glb), texturePartition: [...partition].map(([association, texture]) => ({ association, texture,
                materials: [...sourceMaterials.keys()].filter(index => associations[index] === association) })) } };
}

export function checkScene149Native(capture, reference, { allowStale = false } = {}) {
    const gpu = capture.nodeGpu;
    assert.match(capture.buildStamp, /^[a-f0-9]{64}$/);
    if (!allowStale) assert.equal(capture.buildStamp, reference.generatedStamp,
        "Capture predates the current generated build; --allow-stale is for intermediate diagnostics only");
    assert.equal(gpu.frame, capture.frame);
    assert.equal(gpu.draws.length, 855);
    assert.equal(capture.meshes.length, 285);
    const meshes = uniqueMap(capture.meshes, mesh => mesh.index, "native mesh");
    const resources = uniqueMap(gpu.resources, resource => resource.id, "native resource");
    const pipelines = uniqueMap(gpu.pipelines, pipeline => pipeline.id, "native pipeline");
    const decoded = new Map();
    const resource = id => { const value = resources.get(id); assert(value && !value.destroyed, `Invalid resource ${id}`); return value; };
    const upload = id => {
        if (decoded.has(id)) return decoded.get(id);
        const value = resource(id);
        assert.deepEqual(value.writtenRanges, [{ offset: 0, bytes: value.allocationBytes }]);
        assert.equal(value.uploadedBytes.length, value.allocationBytes);
        const bytes = Buffer.from(value.uploadedBytes); decoded.set(id, bytes); return bytes;
    };
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
        const textures = draw.bindings.filter(binding => binding.role.includes("texture"));
        const samplers = draw.bindings.filter(binding => binding.role.includes("sampler"));
        assert.equal(textures.length, 1); assert.equal(samplers.length, 1);
        resource(textures[0].resource); resource(samplers[0].resource);
        if (capture.backend === "dawn") { resource(textures[0].view); resource(draw.group); }
        const bindings = [textures[0].resource, textures[0].view, samplers[0].resource];
        if (textureBindings.has(draw.material)) assert.deepEqual(bindings, textureBindings.get(draw.material), `Material ${draw.material} changes texture/sampler across views`);
        textureBindings.set(draw.material, bindings);
        if (capture.backend === "dawn") {
            assert(draw.meshUniform && draw.bindings.some(binding => binding.role === "meshU" && binding.resource === draw.meshUniform));
            ubos.add(draw.meshUniform);
        } else assert.equal(draw.group, 0);
        assert.equal(pipeline.usesLocalAttributes, pipeline.colorTargetCount !== 1);
        if (!pipeline.usesLocalAttributes) continue;
        ++geometryDraws;
        assert.deepEqual(pipeline.attributes.map(attribute => attribute.name).sort(), ["normal", "position", "uv"]);
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
        // The existing coordinate adapter can change a zero's sign. Retain
        // those words verbatim; every nonzero numeric difference still fails.
        assert(differences.every(difference => difference.signedZero),
            `${owner.mesh.name}: nonzero numeric world difference: ${JSON.stringify(differences)}`);
        worldResiduals.push({ mesh: draw.mesh, view: pipeline.colorTargetCount, differences });
    }
    assert.equal(geometryDraws, 570); assert.equal(materials.size, 79);
    if (capture.backend === "dawn") assert.equal(ubos.size, 855);
    return { backend: capture.backend, buildStamp: capture.buildStamp,
        matchesCurrentGeneratedBuild: capture.buildStamp === reference.generatedStamp,
        frame: capture.frame, views: viewSummary(views),
        geometryDraws, rawAttributeBytesExact: true, sourceIndicesExact: true, selectedLayouts: [...layouts],
        distinctMeshUbos: ubos.size, materialBindings: [...textureBindings].map(([material, [texture, view, sampler]]) => ({ material, texture, view, sampler })),
        textureAllocations: new Set([...textureBindings.values()].map(binding => binding[0])).size,
        samplerAllocations: new Set([...textureBindings.values()].map(binding => binding[2])).size,
        world: { exactDraws: exactWorlds, byteExact: worldResiduals.length === 0,
            numericExact: worldResiduals.every(row => row.differences.every(difference => difference.signedZero)), residuals: worldResiduals } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2), allowStale = args.includes("--allow-stale");
    const [referenceDirectory, generatedDirectory, sdlPath, dawnPath, outputDirectory] = args.filter(arg => arg !== "--allow-stale");
    assert(referenceDirectory && generatedDirectory && sdlPath && dawnPath,
        "Usage: node tools/check-scene149-transport.mjs <reference-dir> <generated-dir> <native-sdl.json> <native-dawn.json> [output-dir] [--allow-stale]");
    const reference = await readScene149Reference(referenceDirectory, generatedDirectory);
    const backends = [];
    for (const path of [sdlPath, dawnPath]) backends.push(checkScene149Native(json(path), reference, { allowStale }));
    assert.deepEqual(backends.map(result => result.backend), ["sdl_gpu", "dawn"]);
    assert.equal(backends[0].buildStamp, backends[1].buildStamp, "Saved backends come from different builds");
    assert.deepEqual(backends[0].world.residuals, backends[1].world.residuals, "Backends disagree on actual world transport");
    const report = { inputs: { referenceDirectory: resolve(referenceDirectory), generatedDirectory: resolve(generatedDirectory),
            nativeCaptures: [sdlPath, dawnPath].map(path => resolve(path)) },
        sourceSha256: reference.sourceSha256, moduleSha256: reference.moduleSha256,
        generatedStamp: reference.generatedStamp, allowStale,
        matchesCurrentGeneratedBuild: backends.every(result => result.matchesCurrentGeneratedBuild),
        browser: reference.browser, backends,
        bitExactWorld: backends.every(result => result.world.byteExact),
        numericWorldEqual: backends.every(result => result.world.numericExact),
        signedZeroOnly: backends.every(result => result.world.residuals.every(row => row.differences.every(difference => difference.signedZero))) };
    const directory = resolve(outputDirectory ?? join(referenceDirectory, "transport-verification"));
    mkdirSync(directory, { recursive: true });
    const output = join(directory, "verification.json");
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output, matchesCurrentGeneratedBuild: report.matchesCurrentGeneratedBuild,
        bitExactWorld: report.bitExactWorld, numericWorldEqual: report.numericWorldEqual, signedZeroOnly: report.signedZeroOnly,
        backends: backends.map(result => ({ backend: result.backend,
        geometryDraws: result.geometryDraws, rawAttributeBytesExact: result.rawAttributeBytesExact,
        sourceIndicesExact: result.sourceIndicesExact, textureAllocations: result.textureAllocations,
        worldByteExact: result.world.byteExact, worldNumericExact: result.world.numericExact, worldResidualDraws: result.world.residuals.length })) }, null, 2));
}
