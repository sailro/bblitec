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
import {
    GLB_BINARY_CHUNK,
    GLTF_SOURCE_ALBEDO_IDENTITIES,
    glbJsonText,
    instantiatedPrimitiveRecords,
} from "../../dist/src/gltf-document.js";
import { importPinnedModule } from "../../dist/src/pinned-shader-composer.js";
import { findRepositoryRoot } from "../../dist/src/repository-root.js";
import { readJson, sha256 } from "./support.mjs";

/**
 * @import { BuildStamp } from "../../dist/src/build-stamp.js"
 * @import { CompileManifest } from "../../dist/src/compiler/types.js"
 * @import { JsonRecord } from "../../dist/src/gltf-document.js"
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * The source asset and the pinned modules that decode it.
 * @typedef {{ POSITION: number, NORMAL: number, TEXCOORD_0: number }} SourceAttributes a primitive's accessor indices
 * @typedef {{ attributes: SourceAttributes, indices: number, material?: number }} SourcePrimitive
 * @typedef {{ materials: unknown[] }
 *     & Partial<Record<typeof GLTF_SOURCE_ALBEDO_IDENTITIES, { materials: number[] }>>} PackagedDocument the generated GLB's JSON chunk
 * @typedef {Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array} AccessorData
 * @typedef {{
 *     resolveAccessor(document: JsonRecord, binary: Buffer, accessor: number): { _data: AccessorData, _count: number },
 *     buildParentMap(document: JsonRecord): Map<number, number>,
 *     computeNodeWorldMatrix(
 *         document: JsonRecord,
 *         node: number,
 *         parents: Map<number, number>,
 *         cache: Map<number, Float32Array>,
 *     ): Float32Array,
 * }} PinnedGltfParser the pinned `loader-gltf/gltf-parser.js` exports the check calls
 * @typedef {{ x: number, y: number, z: number }} Vector3
 * @typedef {{ position: Vector3, rotation: Vector3, scaling: Vector3 }} PinnedTransformNode
 * @typedef {{ createTransformNode(name: string): PinnedTransformNode }} PinnedTransformNodeModule the pinned `scene/transform-node.js`
 * @typedef {{
 *     parent?: PinnedTransformNode,
 *     rotation: Vector3,
 *     scaling: Vector3,
 *     worldMatrix: Float32Array,
 * }} PinnedMesh
 * @typedef {{ initMeshTransform(partialMesh: Record<string, unknown>): PinnedMesh }} PinnedMeshModule the pinned `mesh/mesh.js`
 * @typedef {{
 *     buffers: Array<{ uri: string }>,
 *     accessors: Array<{
 *         bufferView: number,
 *         byteOffset?: number,
 *         type: "VEC2" | "VEC3" | "SCALAR",
 *         componentType: number,
 *         count: number,
 *     }>,
 *     bufferViews: Array<{ byteOffset?: number, byteStride?: number }>,
 *     nodes: Array<{ name: string, mesh?: number }>,
 *     meshes: Array<{ primitives: Array<{ attributes: SourceAttributes }> }>,
 * }} NodeLocalAsset the node-local-attributes fixture
 * @typedef {{
 *     name: string,
 *     position: Buffer,
 *     normal: Buffer,
 *     uv: Buffer,
 *     world: Buffer,
 *     [field: string]: Buffer | string,
 * }} ExpectedObject one node-local object's source bytes, looked up by native attribute name
 * @typedef {Pick<CompileManifest, "source" | "assets">} GeneratedManifest
 * @typedef {Pick<BuildStamp, "stamp">} GeneratedStamp the generated tree's `build-inputs.json`
 */

/**
 * The browser side: the instrumented buffer capture and the identity observation.
 * @typedef {{ offset: number, data?: string, skipped?: number }} BrowserWrite a recorded write; `skipped` replaces `data` past the recorder's size cap
 * @typedef {{
 *     id: number,
 *     label: string,
 *     size: number,
 *     usage: number,
 *     mappedWrites: BrowserWrite[],
 *     writes: BrowserWrite[],
 * }} BrowserBuffer an instrumented capture's `buffers.json` row
 * @typedef {{ moduleSha256: string }} CaptureMeta the instrumented capture's `capture-meta.json`
 * @typedef {{
 *     kind: "buffer",
 *     id: number,
 *     ordinal: number,
 *     label?: string,
 *     size: number,
 *     usage: number,
 * }} BrowserBufferResource
 * @typedef {BrowserBufferResource | { kind: "view" | "sampler" | "texture" | "shader" }} BrowserResource
 * @typedef {{ id: number, entries: Array<{ binding: number, resource: number }> }} BrowserGroup
 * @typedef {{ format: string, offset: number }} BrowserVertexAttribute
 * @typedef {{ arrayStride: number, attributes: BrowserVertexAttribute[] }} BrowserVertexLayout
 * @typedef {{ buffer: number, offset?: number }} BrowserVertexBinding
 * @typedef {{
 *     id: number,
 *     vertex: { buffers?: BrowserVertexLayout[] },
 *     fragment: { targets: unknown[] },
 * }} BrowserPipeline
 * @typedef {{
 *     method: "drawIndexed",
 *     args: number[],
 *     pipeline: number,
 *     groups: Record<string, { group: number }>,
 *     vertices: Record<string, BrowserVertexBinding>,
 *     index: { buffer: number, format: string, offset?: number },
 * }} BrowserIndexedDraw
 * @typedef {BrowserIndexedDraw | { method: "draw" }} BrowserDraw
 * @typedef {{
 *     name: string,
 *     worldType: string,
 *     worldBytes: number[],
 *     gpuBuffers: {
 *         positionBuffer: number,
 *         normalBuffer: number,
 *         uvBuffer: number,
 *         indexBuffer: number,
 *     },
 * }} IdentityMesh
 * @typedef {{
 *     original: number,
 *     material: number,
 *     texture: number,
 *     view: number,
 *     sampler: number,
 *     sameSourceTexture: boolean,
 *     sameOwner: boolean,
 *     meshes: IdentityMesh[],
 * }} IdentityGroup
 * @typedef {{
 *     sourceSha256: string,
 *     moduleSha256: string,
 *     comparison: { mad: number },
 *     observation: {
 *         resources: BrowserResource[],
 *         groups: BrowserGroup[],
 *         pipelines: BrowserPipeline[],
 *         submissions: BrowserDraw[][],
 *     },
 *     groups: IdentityGroup[],
 * }} Identity the browser reference's `identities.json`
 * @typedef {{ index: number, group: IdentityGroup, mesh: IdentityMesh }} SourceOwner
 * @typedef {SourceOwner & {
 *     attributes: Record<string, Buffer>,
 *     vertexCount: number,
 *     indices: Buffer,
 *     indexCount: number,
 *     world: Buffer,
 * }} Owner a browser mesh with its source asset's attribute, index and world bytes
 * @typedef {{ draws: number, meshes: Set<number>, materials: Set<number> }} ViewCount
 */

/**
 * The native side: a render capture's nodeGpu receipts.
 * @typedef {{
 *     id: number,
 *     destroyed: boolean,
 *     allocationBytes: number,
 *     uploadedBytes: number[],
 *     writtenRanges: Array<{ offset: number, bytes: number }>,
 * }} NativeResource
 * @typedef {{ name: string, format: string, slot: number, offset: number, stride: number }} NativeAttribute
 * @typedef {{
 *     id: number,
 *     geometryVariant: number,
 *     colorTargetCount: number,
 *     samples: number,
 *     usesLocalAttributes: boolean,
 *     topology: string,
 *     cullMode: string,
 *     frontFace: string,
 *     attributes: NativeAttribute[],
 * }} NativePipeline
 * @typedef {{ role: string, resource: number, view: number }} NativeBinding
 * @typedef {{
 *     pipeline: number,
 *     group: number,
 *     vertices: number,
 *     indices: number,
 *     meshUniform: number,
 *     mesh: number,
 *     material: number,
 *     vertexOffset: number,
 *     indexOffset: number,
 *     indexCount: number,
 *     firstIndex: number,
 *     instanceCount: number,
 *     baseVertex: number,
 *     bindings: NativeBinding[],
 *     pushedUniformBytes: number[],
 * }} NativeDraw
 * @typedef {{
 *     frame: number,
 *     resources: NativeResource[],
 *     pipelines: NativePipeline[],
 *     draws: NativeDraw[],
 * }} NodeGpuCapture
 * @typedef {{ index: number, material: number | null, geometryInfo?: { vertexCount: number } }} NativeMesh
 * @typedef {{
 *     backend: string,
 *     buildStamp: string,
 *     frame: number,
 *     meshes: NativeMesh[],
 *     nodeGpu?: NodeGpuCapture,
 * }} NativeCapture the fields read from a phase's render capture
 * @typedef {Awaited<ReturnType<typeof readScene149Reference>>} Scene149Reference
 */

/**
 * What the check reports: the world words native transport changed.
 * @typedef {{
 *     lane: number,
 *     nativeWord: number,
 *     browserWord: number,
 *     native: number,
 *     browser: number,
 *     signedZero: boolean,
 * }} WorldDifference a native world word that differs from the browser's
 * @typedef {{ mesh: number, view: number, differences: WorldDifference[] }} WorldResidual
 * @typedef {{
 *     lane: number,
 *     nativeWord: number,
 *     pinWord: number,
 *     native: number,
 *     pin: number,
 *     signedZero: boolean,
 *     ulps: number,
 * }} PinWorldDifference a native world word that differs from the pin's
 * @typedef {{
 *     mesh: number,
 *     name: string,
 *     view: number,
 *     differences: PinWorldDifference[],
 * }} PinWorldResidual
 * @typedef {{
 *     backend: string,
 *     frame: number,
 *     draws: number,
 *     rawGeometryDraws: number,
 *     selectedAttributes: string[],
 *     sourceIndices: number[],
 *     distinctMeshUbos: number,
 *     sourceAttributeBytesExact: boolean,
 *     residuals: PinWorldResidual[],
 * }} NodeLocalReport one backend's node-local transport
 */

/** @param {ArrayBufferView} view */
const rawBytes = (view) =>
    Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const ATTRIBUTES = /** @type {const} */ (["position", "normal", "uv"]);
const sourceKeys = /** @type {const} */ ({
    position: "POSITION",
    normal: "NORMAL",
    uv: "TEXCOORD_0",
});
const bufferKeys = /** @type {const} */ ({
    position: "positionBuffer",
    normal: "normalBuffer",
    uv: "uvBuffer",
});

/**
 * @template T, K
 * @param {readonly T[]} values
 * @param {(value: T) => K} key
 * @param {string} label
 * @returns {Map<K, T>}
 */
function uniqueMap(values, key, label) {
    const result = new Map(values.map((value) => [key(value), value]));
    assert.equal(result.size, values.length, `Duplicate ${label}`);
    return result;
}

/**
 * @template A, B
 * @param {Map<A, B>} forward
 * @param {Map<B, A>} reverse
 * @param {A} a
 * @param {B} b
 * @param {string} label
 */
function associate(forward, reverse, a, b, label) {
    if (forward.has(a))
        assert.equal(forward.get(a), b, `${label}: one source splits`);
    if (reverse.has(b))
        assert.equal(reverse.get(b), a, `${label}: distinct sources collapse`);
    forward.set(a, b);
    reverse.set(b, a);
}

/**
 * @param {Buffer} bytes
 * @param {number} count
 * @param {number} offset
 * @param {number} stride
 * @param {number} width
 */
function selectedAttribute(bytes, count, offset, stride, width) {
    assert(
        Number.isInteger(count) && count > 0 && offset >= 0 && stride >= width,
    );
    assert(
        offset + (count - 1) * stride + width <= bytes.length,
        "Attribute selection exceeds upload",
    );
    const selected = Buffer.alloc(count * width);
    for (let i = 0; i < count; ++i)
        bytes.copy(
            selected,
            i * width,
            offset + i * stride,
            offset + i * stride + width,
        );
    return selected;
}

/**
 * @param {Buffer} bytes
 * @param {string} format
 * @param {number} offset
 * @param {number} count
 * @param {number} [first]
 */
function selectedIndices(bytes, format, offset, count, first = 0) {
    assert(format === "uint16" || format === "uint32");
    const width = format === "uint16" ? 2 : 4;
    assert(offset >= 0 && offset + (first + count) * width <= bytes.length);
    const selected = Buffer.alloc(count * 4);
    for (let i = 0; i < count; ++i)
        selected.writeUInt32LE(
            width === 2
                ? bytes.readUInt16LE(offset + (first + i) * width)
                : bytes.readUInt32LE(offset + (first + i) * width),
            i * 4,
        );
    return selected;
}

/**
 * The bytes an instrumented browser buffer holds after its mapped and queued writes.
 * @param {BrowserBuffer} buffer
 */
export function browserUpload(buffer) {
    const bytes = Buffer.alloc(buffer.size);
    const covered = Buffer.alloc(buffer.size);
    for (const write of [...buffer.mappedWrites, ...buffer.writes]) {
        assert(
            !write.skipped,
            `browser upload ${buffer.id} was too large to record`,
        );
        assert(
            write.data !== undefined,
            `browser upload ${buffer.id} recorded a write without data`,
        );
        const data = Buffer.from(write.data, "base64");
        assert(write.offset >= 0 && write.offset + data.length <= bytes.length);
        data.copy(bytes, write.offset);
        covered.fill(1, write.offset, write.offset + data.length);
    }
    return { bytes, covered };
}

/**
 * A native nodeGpu resource's uploaded bytes, whole.
 * @param {Map<number, NativeResource>} resources
 * @param {Map<number, Buffer>} decoded
 * @param {number} id
 */
function nativeUpload(resources, decoded, id) {
    const cached = decoded.get(id);
    if (cached !== undefined) return cached;
    const value = resources.get(id);
    assert(value && !value.destroyed, `Invalid resource ${id}`);
    assert.deepEqual(value.writtenRanges, [
        { offset: 0, bytes: value.allocationBytes },
    ]);
    assert.equal(value.uploadedBytes.length, value.allocationBytes);
    const bytes = Buffer.from(value.uploadedBytes);
    decoded.set(id, bytes);
    return bytes;
}

/** @param {Map<number, ViewCount>} views */
function viewSummary(views) {
    assert.deepEqual(
        [...views.keys()].sort((a, b) => a - b),
        [1, 4, 7],
    );
    return [...views].map(([targets, view]) => {
        assert.deepEqual(
            [view.draws, view.meshes.size, view.materials.size],
            [285, 285, 79],
        );
        return {
            targets,
            draws: view.draws,
            meshes: view.meshes.size,
            materials: view.materials.size,
        };
    });
}

/**
 * @param {Map<number, ViewCount>} views
 * @param {number} targets
 * @param {number} mesh
 * @param {number} material
 */
function countDraw(views, targets, mesh, material) {
    let view = views.get(targets);
    if (view === undefined) {
        view = { draws: 0, meshes: new Set(), materials: new Set() };
        views.set(targets, view);
    }
    assert(
        !view.meshes.has(mesh),
        `Repeated mesh ${mesh} in ${targets}-target view`,
    );
    ++view.draws;
    view.meshes.add(mesh);
    view.materials.add(material);
}

/**
 * @param {string} referenceDirectory
 * @param {string} generatedDirectory
 */
async function readScene149Reference(referenceDirectory, generatedDirectory) {
    const identity = /** @type {Identity} */ (
        readJson(join(referenceDirectory, "identities.json"))
    );
    const raw = /** @type {BrowserBuffer[]} */ (
        readJson(join(referenceDirectory, "instrumented/buffers.json"))
    );
    const meta = /** @type {CaptureMeta} */ (
        readJson(join(referenceDirectory, "instrumented/capture-meta.json"))
    );
    assert.equal(meta.moduleSha256, identity.moduleSha256);
    assert.equal(
        identity.comparison.mad,
        0,
        "Identity instrumentation changes canonical pixels",
    );
    const manifest = /** @type {GeneratedManifest} */ (
        readJson(join(generatedDirectory, "manifest.json"))
    );
    assert.equal(
        // manifest.json records repository-relative source paths.
        sha256(readFileSync(resolve(findRepositoryRoot(), manifest.source))),
        identity.sourceSha256,
        "Generated source differs from browser source",
    );
    const assets = manifest.assets.filter((asset) => asset.kind === "gltf");
    assert.equal(assets.length, 1);
    const [asset] = assets;
    assert(asset);
    const glb = readFileSync(join(generatedDirectory, "assets", asset.output));
    const json = glbJsonText(glb);
    assert(json !== undefined, `${asset.output} is not a GLB`);
    const document = /** @type {PackagedDocument} */ (JSON.parse(json));
    const binaryHeader = 20 + glb.readUInt32LE(12);
    assert.equal(glb.readUInt32LE(binaryHeader + 4), GLB_BINARY_CHUNK);
    const binary = glb.subarray(
        binaryHeader + 8,
        binaryHeader + 8 + glb.readUInt32LE(binaryHeader),
    );
    const primitives = /** @type {SourcePrimitive[]} */ (
        instantiatedPrimitiveRecords(document)
    );
    assert.equal(primitives.length, 285);
    const associations = document[GLTF_SOURCE_ALBEDO_IDENTITIES]?.materials;
    assert.equal(associations?.length, document.materials.length + 1);
    /** @type {PinnedGltfParser} */
    const parser = await importPinnedModule("loader-gltf/gltf-parser.js");
    const browserResources = identity.observation.resources.filter(
        (resource) => resource.kind === "buffer",
    );
    assert.equal(browserResources.length, raw.length);
    /** @type {Map<number, { bytes: Buffer, covered: Buffer }>} */
    const uploads = new Map();
    for (const resource of browserResources) {
        const buffer = raw[resource.ordinal - 1];
        assert(
            buffer,
            `Browser buffer ordinal ${resource.ordinal} is absent from buffers.json`,
        );
        assert.deepEqual(
            [resource.label ?? "", resource.size, resource.usage],
            [buffer.label, buffer.size, buffer.usage],
        );
        uploads.set(resource.id, browserUpload(buffer));
    }
    /** @param {number} id */
    const upload = (id) => {
        const value = uploads.get(id);
        assert(
            value && value.covered.every((byte) => byte === 1),
            `Incomplete browser upload ${id}`,
        );
        return value.bytes;
    };
    const sources = uniqueMap(
        identity.groups.flatMap((group) =>
            group.meshes.map((mesh) => {
                assert(
                    group.sameSourceTexture && group.sameOwner,
                    "Browser node material must retain its source owner/texture",
                );
                const match = /^gltf_mesh_(\d+)$/.exec(mesh.name);
                assert(match, `Unexpected source mesh name ${mesh.name}`);
                return { index: Number(match[1]), group, mesh };
            }),
        ),
        (source) => source.index,
        "source mesh index",
    );
    assert.deepEqual(
        [...sources.keys()].sort((a, b) => a - b),
        Array.from({ length: 285 }, (_, i) => i),
    );
    /** @type {Map<number, number>} */
    const sourceMaterials = new Map();
    /** @type {Map<number, number>} */
    const originalMaterials = new Map();
    /** @type {Map<number | undefined, number>} */
    const partition = new Map();
    /** @type {Map<number, number | undefined>} */
    const sourceTextures = new Map();
    /** @type {Map<number, Owner>} */
    const owners = new Map();
    for (const source of sources.values()) {
        const primitive = primitives[source.index];
        assert(
            primitive,
            `${source.mesh.name}: the generated asset has no node/primitive row`,
        );
        /** @type {Record<string, Buffer>} */
        const attributes = {};
        /** @type {number | undefined} */
        let vertexCount;
        for (const name of ATTRIBUTES) {
            const key = sourceKeys[name];
            const values = parser.resolveAccessor(
                document,
                binary,
                primitive.attributes[key],
            );
            const bytes = rawBytes(values._data);
            assert(
                upload(source.mesh.gpuBuffers[bufferKeys[name]]).equals(bytes),
                `${source.mesh.name}: ${key} does not match the generated asset's node/primitive row`,
            );
            attributes[name] = bytes;
            if (name === "position") vertexCount = values._count;
        }
        assert(vertexCount !== undefined);
        const indices = parser.resolveAccessor(
            document,
            binary,
            primitive.indices,
        )._data;
        const indexBytes = selectedIndices(
            rawBytes(indices),
            indices.BYTES_PER_ELEMENT === 2 ? "uint16" : "uint32",
            0,
            indices.length,
        );
        const sourceMaterial = primitive.material ?? document.materials.length;
        associate(
            sourceMaterials,
            originalMaterials,
            sourceMaterial,
            source.group.original,
            "Asset/browser material ownership",
        );
        associate(
            partition,
            sourceTextures,
            associations[sourceMaterial],
            source.group.texture,
            "Asset/browser Texture2D partition",
        );
        assert.equal(source.mesh.worldType, "Float32Array");
        assert.equal(source.mesh.worldBytes.length, 64);
        owners.set(source.index, {
            ...source,
            attributes,
            vertexCount,
            indices: indexBytes,
            indexCount: indices.length,
            world: Buffer.from(source.mesh.worldBytes),
        });
    }
    assert.equal(sourceMaterials.size, 79);
    assert.equal(partition.size, 65);
    assert.equal(
        new Set(identity.groups.map((group) => group.sampler)).size,
        1,
    );
    const groups = uniqueMap(
        identity.observation.groups,
        (group) => group.id,
        "browser group",
    );
    const pipelines = uniqueMap(
        identity.observation.pipelines,
        (pipeline) => pipeline.id,
        "browser pipeline",
    );
    const bufferOwners = uniqueMap(
        [...owners.values()],
        (owner) =>
            `${owner.mesh.gpuBuffers.positionBuffer}/${owner.mesh.gpuBuffers.indexBuffer}`,
        "browser vertex/index owner",
    );
    const submissions = identity.observation.submissions.map((draws) => {
        const indexed = draws.filter((draw) => draw.method === "drawIndexed");
        assert.equal(indexed.length, 855);
        /** @type {Map<number, ViewCount>} */
        const views = new Map();
        /** @type {Set<number>} */
        const worldBuffers = new Set();
        for (const draw of indexed) {
            const matching = Object.values(draw.vertices)
                .map((vertex) =>
                    bufferOwners.get(`${vertex.buffer}/${draw.index.buffer}`),
                )
                .filter(Boolean);
            assert.equal(
                matching.length,
                1,
                "Actual browser bindings must identify one source mesh",
            );
            const owner = matching[0];
            assert(owner);
            const pipeline = pipelines.get(draw.pipeline);
            assert(pipeline, `Unobserved browser pipeline ${draw.pipeline}`);
            const targets = pipeline.fragment.targets.length;
            countDraw(views, targets, owner.index, owner.group.material);
            assert.deepEqual(
                [
                    draw.args[0],
                    draw.args[1] ?? 1,
                    draw.args[2] ?? 0,
                    draw.args[3] ?? 0,
                    draw.args[4] ?? 0,
                ],
                [owner.indexCount, 1, 0, 0, 0],
            );
            assert(
                selectedIndices(
                    upload(draw.index.buffer),
                    draw.index.format,
                    draw.index.offset ?? 0,
                    owner.indexCount,
                ).equals(owner.indices),
            );
            const meshGroup = draw.groups[1];
            const entries = meshGroup && groups.get(meshGroup.group)?.entries;
            assert(entries, "The browser draw binds no observed group 1");
            assert(
                entries.some(
                    (binding) => binding.resource === owner.group.view,
                ),
            );
            assert(
                entries.some(
                    (binding) => binding.resource === owner.group.sampler,
                ),
            );
            const ubo = entries.find(
                (binding) => binding.binding === 0,
            )?.resource;
            assert(
                ubo !== undefined,
                "The browser mesh group has no binding 0",
            );
            assert(
                upload(ubo).subarray(0, 64).equals(owner.world),
                `${owner.mesh.name}: browser bound world differs from source`,
            );
            worldBuffers.add(ubo);
            if (targets === 1) continue;
            for (const [name, key] of Object.entries(bufferKeys)) {
                /** @type {Array<[string, BrowserVertexBinding]>} */
                const selected = Object.entries(draw.vertices).filter(
                    ([, vertex]) =>
                        vertex.buffer === owner.mesh.gpuBuffers[key],
                );
                assert.equal(selected.length, 1);
                const [vertexBinding] = selected;
                assert(vertexBinding);
                const [slot, vertex] = vertexBinding;
                /** @type {BrowserVertexLayout | undefined} */
                const layout = pipeline.vertex.buffers?.[Number(slot)];
                assert(
                    layout,
                    `Browser pipeline ${pipeline.id} declares no vertex buffer ${slot}`,
                );
                assert.equal(layout.attributes.length, 1);
                /** @type {BrowserVertexAttribute | undefined} */
                const attribute = layout.attributes[0];
                const width = name === "uv" ? 8 : 12;
                assert(attribute);
                assert.equal(
                    attribute.format,
                    name === "uv" ? "float32x2" : "float32x3",
                );
                const source = owner.attributes[name];
                assert(source, `${owner.mesh.name}: no source ${name} bytes`);
                assert(
                    selectedAttribute(
                        upload(vertex.buffer),
                        owner.vertexCount,
                        (vertex.offset ?? 0) + attribute.offset,
                        layout.arrayStride,
                        width,
                    ).equals(source),
                );
            }
        }
        assert.equal(worldBuffers.size, 855);
        return viewSummary(views);
    });
    assert(submissions.length > 0);
    return {
        owners,
        sourceSha256: identity.sourceSha256,
        moduleSha256: identity.moduleSha256,
        generatedStamp: /** @type {GeneratedStamp} */ (
            readJson(join(generatedDirectory, "build-inputs.json"))
        ).stamp,
        browser: {
            buffers: raw.length,
            submissions,
            sourceMaterials: sourceMaterials.size,
            sourceTextures: partition.size,
            sourceSamplers: 1,
            assetSha256: sha256(glb),
            texturePartition: [...partition].map(([association, texture]) => ({
                association,
                texture,
                materials: [...sourceMaterials.keys()].filter(
                    (index) => associations[index] === association,
                ),
            })),
        },
    };
}

/**
 * @param {NativeCapture} capture
 * @param {Scene149Reference} reference
 * @param {{ allowStale?: boolean }} [options]
 */
function checkScene149Native(capture, reference, { allowStale = false } = {}) {
    const gpu = capture.nodeGpu;
    assert(
        gpu,
        "the native capture carries no nodeGpu receipts (BBLITE_NODE_GPU_CAPTURE=1)",
    );
    assert.match(capture.buildStamp, /^[a-f0-9]{64}$/);
    if (!allowStale)
        assert.equal(
            capture.buildStamp,
            reference.generatedStamp,
            "Capture predates the current generated build",
        );
    assert.equal(gpu.frame, capture.frame);
    assert.equal(gpu.draws.length, 855);
    assert.equal(capture.meshes.length, 285);
    const meshes = uniqueMap(
        capture.meshes,
        (mesh) => mesh.index,
        "native mesh",
    );
    const resources = uniqueMap(
        gpu.resources,
        (resource) => resource.id,
        "native resource",
    );
    const pipelines = uniqueMap(
        gpu.pipelines,
        (pipeline) => pipeline.id,
        "native pipeline",
    );
    /** @type {Map<number, Buffer>} */
    const decoded = new Map();
    /** @param {number} id */
    const resource = (id) => {
        const value = resources.get(id);
        assert(value && !value.destroyed, `Invalid resource ${id}`);
        return value;
    };
    /** @param {number} id */
    const upload = (id) => nativeUpload(resources, decoded, id);
    /** @type {Map<number, ViewCount>} */
    const views = new Map();
    /** @type {Set<number>} */
    const ubos = new Set();
    /** @type {Map<number, number>} */
    const materials = new Map();
    /** @type {Map<number, number>} */
    const reverseMaterials = new Map();
    /** @type {Map<number, [number, number, number]>} */
    const textureBindings = new Map();
    /** @type {WorldResidual[]} */
    const worldResiduals = [];
    /** @type {Set<string>} */
    const layouts = new Set();
    let geometryDraws = 0,
        exactWorlds = 0;
    for (const draw of gpu.draws) {
        const owner = reference.owners.get(draw.mesh),
            mesh = meshes.get(draw.mesh),
            pipeline = pipelines.get(draw.pipeline);
        assert(owner && mesh && pipeline);
        assert.equal(mesh.material, draw.material);
        associate(
            materials,
            reverseMaterials,
            draw.material,
            owner.group.material,
            "Native/browser material ownership",
        );
        countDraw(views, pipeline.colorTargetCount, draw.mesh, draw.material);
        assert.deepEqual(
            [
                pipeline.samples,
                pipeline.topology,
                pipeline.cullMode,
                pipeline.frontFace,
            ],
            [4, "triangle-list", "back", "ccw"],
        );
        assert.deepEqual(
            [
                draw.indexCount,
                draw.firstIndex,
                draw.instanceCount,
                draw.baseVertex,
            ],
            [owner.indexCount, 0, 1, 0],
        );
        assert.equal(mesh.geometryInfo?.vertexCount, owner.vertexCount);
        assert(
            selectedIndices(
                upload(draw.indices),
                "uint32",
                draw.indexOffset,
                draw.indexCount,
                draw.firstIndex,
            ).equals(owner.indices),
            `${owner.mesh.name}: bound source indices differ`,
        );
        const textures = draw.bindings.filter((binding) =>
            binding.role.includes("texture"),
        );
        const samplers = draw.bindings.filter((binding) =>
            binding.role.includes("sampler"),
        );
        assert.equal(textures.length, 1);
        assert.equal(samplers.length, 1);
        const [texture] = textures,
            [sampler] = samplers;
        assert(texture && sampler);
        resource(texture.resource);
        resource(sampler.resource);
        if (capture.backend === "dawn") {
            resource(texture.view);
            resource(draw.group);
        }
        /** @type {[number, number, number]} */
        const bindings = [texture.resource, texture.view, sampler.resource];
        if (textureBindings.has(draw.material))
            assert.deepEqual(
                bindings,
                textureBindings.get(draw.material),
                `Material ${draw.material} changes texture/sampler across views`,
            );
        textureBindings.set(draw.material, bindings);
        if (capture.backend === "dawn") {
            assert(
                draw.meshUniform &&
                    draw.bindings.some(
                        (binding) =>
                            binding.role === "meshU" &&
                            binding.resource === draw.meshUniform,
                    ),
            );
            ubos.add(draw.meshUniform);
        } else assert.equal(draw.group, 0);
        assert.equal(
            pipeline.usesLocalAttributes,
            pipeline.colorTargetCount !== 1,
        );
        if (!pipeline.usesLocalAttributes) continue;
        ++geometryDraws;
        assert.deepEqual(
            pipeline.attributes.map((attribute) => attribute.name).sort(),
            ["normal", "position", "uv"],
        );
        for (const attribute of pipeline.attributes) {
            const width = attribute.name === "uv" ? 8 : 12;
            assert.equal(attribute.slot, 0);
            assert.equal(
                attribute.format,
                width === 8 ? "float32x2" : "float32x3",
            );
            const source = owner.attributes[attribute.name];
            assert(
                source,
                `${owner.mesh.name}: no browser/asset ${attribute.name} bytes`,
            );
            assert(
                selectedAttribute(
                    upload(draw.vertices),
                    owner.vertexCount,
                    draw.vertexOffset + attribute.offset,
                    attribute.stride,
                    width,
                ).equals(source),
                `${owner.mesh.name}: actually bound ${attribute.name} differs from browser/asset bytes`,
            );
            layouts.add(
                `${attribute.name}:${attribute.offset}/${attribute.stride}`,
            );
        }
        const world =
            capture.backend === "dawn"
                ? upload(draw.meshUniform)
                : Buffer.from(draw.pushedUniformBytes);
        assert(world.length >= 64);
        if (world.subarray(0, 64).equals(owner.world)) {
            ++exactWorlds;
            continue;
        }
        /** @type {WorldDifference[]} */
        const differences = [];
        for (let lane = 0; lane < 16; ++lane) {
            const nativeWord = world.readUInt32LE(lane * 4),
                browserWord = owner.world.readUInt32LE(lane * 4);
            if (nativeWord === browserWord) continue;
            const native = world.readFloatLE(lane * 4),
                browser = owner.world.readFloatLE(lane * 4);
            differences.push({
                lane,
                nativeWord,
                browserWord,
                native,
                browser,
                signedZero: native === 0 && browser === 0,
            });
        }
        // The coordinate adapter can change a zero's sign; those words are
        // retained verbatim, and every nonzero numeric difference fails.
        assert(
            differences.every((difference) => difference.signedZero),
            `${owner.mesh.name}: nonzero numeric world difference: ${JSON.stringify(differences)}`,
        );
        worldResiduals.push({
            mesh: draw.mesh,
            view: pipeline.colorTargetCount,
            differences,
        });
    }
    assert.equal(geometryDraws, 570);
    assert.equal(materials.size, 79);
    if (capture.backend === "dawn") assert.equal(ubos.size, 855);
    return {
        backend: capture.backend,
        buildStamp: capture.buildStamp,
        matchesCurrentGeneratedBuild:
            capture.buildStamp === reference.generatedStamp,
        frame: capture.frame,
        views: viewSummary(views),
        geometryDraws,
        rawAttributeBytesExact: true,
        sourceIndicesExact: true,
        selectedLayouts: [...layouts],
        distinctMeshUbos: ubos.size,
        materialBindings: [...textureBindings].map(
            ([material, [texture, view, sampler]]) => ({
                material,
                texture,
                view,
                sampler,
            }),
        ),
        textureAllocations: new Set(
            [...textureBindings.values()].map((binding) => binding[0]),
        ).size,
        samplerAllocations: new Set(
            [...textureBindings.values()].map((binding) => binding[2]),
        ).size,
        world: {
            exactDraws: exactWorlds,
            byteExact: worldResiduals.length === 0,
            numericExact: worldResiduals.every((row) =>
                row.differences.every((difference) => difference.signedZero),
            ),
            residuals: worldResiduals,
        },
    };
}

/**
 * @param {string} browserCapture
 * @param {NativeCapture[]} captures
 */
async function checkNodeLocal(browserCapture, captures) {
    const asset = /** @type {NodeLocalAsset} */ (
        readJson(
            resolve("examples/assets/regression/node-local-attributes.gltf"),
        )
    );
    const payload = asset.buffers[0]?.uri.split(",")[1];
    assert(
        payload !== undefined,
        "The node-local fixture embeds its buffer as a data URI",
    );
    const binary = Buffer.from(payload, "base64");
    /** @param {ArrayBufferView} values */
    const bytes = (values) =>
        Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    /** @param {number[]} values */
    const f32 = (values) => bytes(Float32Array.from(values));
    /** @param {number} index */
    const accessor = (index) => {
        const entry = asset.accessors[index];
        assert(entry, `The node-local fixture has no accessor ${index}`);
        const view = asset.bufferViews[entry.bufferView];
        assert(view, `Accessor ${index} names no buffer view`);
        assert(
            !view.byteStride,
            "This observing control requires tight source attributes",
        );
        const lanes = { VEC2: 2, VEC3: 3, SCALAR: 1 }[entry.type];
        const size = entry.componentType === 5123 ? 2 : 4;
        const offset = (view.byteOffset ?? 0) + (entry.byteOffset ?? 0);
        return binary.subarray(offset, offset + entry.count * lanes * size);
    };
    /** @type {PinnedGltfParser} */
    const parser = await importPinnedModule("loader-gltf/gltf-parser.js");
    /** @type {PinnedMeshModule} */
    const meshes = await importPinnedModule("mesh/mesh.js");
    /** @type {PinnedTransformNodeModule} */
    const transforms = await importPinnedModule("scene/transform-node.js");
    /** @type {ExpectedObject[]} */
    const expected = asset.nodes.flatMap((node, index) => {
        if (node.mesh === undefined) return [];
        const primitive = asset.meshes[node.mesh]?.primitives[0];
        assert(primitive, `${node.name}: mesh ${node.mesh} has no primitive`);
        const a = primitive.attributes;
        return [
            {
                name: node.name,
                position: accessor(a.POSITION),
                normal: accessor(a.NORMAL),
                uv: accessor(a.TEXCOORD_0),
                world: bytes(
                    parser.computeNodeWorldMatrix(
                        asset,
                        index,
                        parser.buildParentMap(asset),
                        new Map(),
                    ),
                ),
            },
        ];
    });
    // The third authored object uses ordinary scalar TRS storage; its 1.3
    // input exposes inherited float narrowing instead of hiding it.
    const parent = transforms.createTransformNode("scene-parent");
    parent.position.y = 1.25;
    parent.rotation.z = -0.2;
    parent.scaling.x = 1.3;
    const local = meshes.initMeshTransform({});
    local.parent = parent;
    local.rotation.y = 0.3;
    local.scaling.y = 0.8;
    expected.push({
        name: "scene-local",
        position: f32([-0.6, -0.4, 0, 0.6, -0.4, 0, 0.6, 0.4, 0, -0.6, 0.4, 0]),
        normal: f32([0.2, 0.4, 2, 0.2, 0.4, 2, 0.2, 0.4, 2, 0.2, 0.4, 2]),
        uv: f32([0, 1, 1, 1, 1, 0, 0, 0]),
        world: bytes(local.worldMatrix),
    });
    const browser = /** @type {BrowserBuffer[]} */ (
        readJson(resolve(browserCapture, "buffers.json"))
    );
    /** @param {BrowserBuffer} buffer */
    const uploaded = (buffer) => {
        const { bytes: data, covered } = browserUpload(buffer);
        assert(
            covered.every((value) => value === 1),
            `Incomplete browser upload ${buffer.id}`,
        );
        return data;
    };
    const browserVertices = browser
        .filter((buffer) => buffer.usage & 32)
        .map(uploaded);
    const browserWorlds = browser
        .filter((buffer) => buffer.label === "node-geom-mesh-ubo")
        .map(uploaded);
    for (const object of expected) {
        for (const name of ATTRIBUTES) {
            assert(
                browserVertices.some((data) => data.equals(object[name])),
                `${object.name} ${name} absent from actual browser uploads`,
            );
        }
        assert.equal(
            browserWorlds.filter((data) =>
                data.subarray(0, 64).equals(object.world),
            ).length,
            2,
            `${object.name}: both browser views must upload the actual pin world`,
        );
    }
    const sourceIndices = [0, 1, 2, 0, 2, 3];
    for (const buffer of browser.filter((entry) => entry.usage & 16)) {
        const data = uploaded(buffer),
            componentBytes = data.length / sourceIndices.length;
        assert(componentBytes === 2 || componentBytes === 4);
        const values = sourceIndices.map((_, index) =>
            componentBytes === 2
                ? data.readUInt16LE(index * 2)
                : data.readUInt32LE(index * 4),
        );
        assert.deepEqual(
            values,
            sourceIndices,
            "The pin binds the original index sequence",
        );
    }
    /** @param {number} word */
    const orderedWord = (word) =>
        word & 0x80000000
            ? 0x80000000 - (word & 0x7fffffff)
            : 0x80000000 + word;
    /** @type {NodeLocalReport[]} */
    const reports = [];
    for (const capture of captures) {
        const gpu = capture.nodeGpu;
        assert(gpu, "Native capture must opt into node GPU receipts");
        assert.equal(gpu.frame, capture.frame);
        assert.equal(gpu.draws.length, 9);
        const resources = new Map(
            gpu.resources.map((resource) => [resource.id, resource]),
        );
        const pipelines = new Map(
            gpu.pipelines.map((pipeline) => [pipeline.id, pipeline]),
        );
        /** @type {Map<number, Buffer>} */
        const decoded = new Map();
        /** @param {number} id */
        const data = (id) => nativeUpload(resources, decoded, id);
        /** @param {NativeDraw} draw */
        const drawPipeline = (draw) => {
            const pipeline = pipelines.get(draw.pipeline);
            assert(pipeline, `Unknown native pipeline ${draw.pipeline}`);
            return pipeline;
        };
        const geometry = gpu.draws.filter(
            (draw) => drawPipeline(draw).usesLocalAttributes,
        );
        assert.equal(geometry.length, 6);
        /** @type {Set<number>} */
        const views = new Set();
        /** @type {Set<number>} */
        const meshUbos = new Set();
        /** @type {PinWorldResidual[]} */
        const residuals = [];
        /** @type {Set<string>} */
        const offsets = new Set();
        /** @type {Set<number>} */
        const textureBindings = new Set();
        /** @type {Set<number>} */
        const samplerBindings = new Set();
        for (const draw of gpu.draws) {
            const pipeline = drawPipeline(draw);
            assert.equal(pipeline.samples, 1);
            assert.equal(pipeline.topology, "triangle-list");
            assert.equal(pipeline.frontFace, "ccw");
            assert.equal(pipeline.cullMode, "back");
            assert.deepEqual(
                [
                    draw.indexCount,
                    draw.firstIndex,
                    draw.instanceCount,
                    draw.baseVertex,
                ],
                [6, 0, 1, 0],
            );
            const indices = data(draw.indices);
            assert.deepEqual(
                Array.from({ length: 6 }, (_, i) =>
                    indices.readUInt32LE(draw.indexOffset + i * 4),
                ),
                sourceIndices,
            );
            for (const binding of draw.bindings) {
                if (binding.role.includes("texture"))
                    textureBindings.add(binding.resource);
                if (binding.role.includes("sampler"))
                    samplerBindings.add(binding.resource);
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
                assert.equal(
                    attribute.format,
                    size === 8 ? "float32x2" : "float32x3",
                );
                const selected = Buffer.concat(
                    Array.from({ length: 4 }, (_, vertex) => {
                        const offset =
                            draw.vertexOffset +
                            vertex * attribute.stride +
                            attribute.offset;
                        return vertexData.subarray(offset, offset + size);
                    }),
                );
                assert(
                    selected.equals(source),
                    `${object.name} actually bound ${attribute.name} differs from source bytes`,
                );
                offsets.add(
                    `${attribute.name}:${attribute.offset}/${attribute.stride}`,
                );
            }
            const world =
                capture.backend === "dawn"
                    ? data(draw.meshUniform)
                    : Buffer.from(draw.pushedUniformBytes);
            /** @type {PinWorldDifference[]} */
            const differences = [];
            for (let lane = 0; lane < 16; ++lane) {
                const nativeWord = world.readUInt32LE(lane * 4),
                    pinWord = object.world.readUInt32LE(lane * 4);
                if (nativeWord === pinWord) continue;
                const native = world.readFloatLE(lane * 4),
                    pin = object.world.readFloatLE(lane * 4);
                const signedZero = native === 0 && pin === 0;
                const ulps = signedZero
                    ? 0
                    : Math.abs(orderedWord(nativeWord) - orderedWord(pinWord));
                assert(
                    signedZero || (object.name === "scene-local" && ulps <= 2),
                    "Unexpected world transport difference",
                );
                differences.push({
                    lane,
                    nativeWord,
                    pinWord,
                    native,
                    pin,
                    signedZero,
                    ulps,
                });
            }
            residuals.push({
                mesh: draw.mesh,
                name: object.name,
                view: pipeline.geometryVariant,
                differences,
            });
        }
        assert.equal(views.size, 2);
        assert.equal(
            textureBindings.size,
            1,
            "All three views preserve the material's actual texture binding",
        );
        assert.equal(samplerBindings.size, 1);
        if (capture.backend === "dawn")
            assert.equal(
                meshUbos.size,
                9,
                "Every mesh/view owns a distinct UBO",
            );
        reports.push({
            backend: capture.backend,
            frame: gpu.frame,
            draws: 9,
            rawGeometryDraws: 6,
            selectedAttributes: [...offsets],
            sourceIndices,
            distinctMeshUbos: meshUbos.size,
            sourceAttributeBytesExact: true,
            residuals,
        });
    }
    const [first] = reports;
    for (const report of reports.slice(1)) {
        assert(first);
        assert.deepEqual(report.selectedAttributes, first.selectedAttributes);
        assert.deepEqual(
            report.residuals,
            first.residuals,
            "Both PALs must transport the same world values",
        );
    }
    return reports;
}

/** @param {PluginContext} context */
export async function check(context) {
    const captures = context.backends.map((backend) => {
        const phase = context.results[backend]?.canonical;
        assert(phase, `${backend}: the check declares no canonical phase`);
        assert(
            phase.capture,
            `${backend}: the canonical phase left no capture`,
        );
        return /** @type {NativeCapture} */ (phase.capture);
    });
    if (context.options.control === "node-local") {
        assert(
            typeof context.options.browserCapture === "string",
            "options.browserCapture names the instrumented browser capture directory",
        );
        return {
            details: await checkNodeLocal(
                resolve(context.options.browserCapture),
                captures,
            ),
        };
    }
    const referenceDirectory =
        context.options.referenceDirectory ?? "artifacts/scene149-reference";
    assert(
        typeof referenceDirectory === "string",
        "options.referenceDirectory names the browser reference directory",
    );
    const reference = await readScene149Reference(
        resolve(referenceDirectory),
        resolve(context.target.output),
    );
    const backends = captures.map((capture) =>
        checkScene149Native(capture, reference, {
            allowStale: context.options.allowStale === true,
        }),
    );
    if (backends.length === 2) {
        const [first, second] = backends;
        assert(first && second);
        assert.equal(
            first.buildStamp,
            second.buildStamp,
            "The backends come from different builds",
        );
        assert.deepEqual(
            first.world.residuals,
            second.world.residuals,
            "Backends disagree on actual world transport",
        );
    }
    for (const result of backends) {
        context.log(
            `${result.backend}: ${result.geometryDraws} geometry draws, world ${result.world.byteExact ? "byte-exact" : `${result.world.residuals.length} signed-zero residual draw(s)`}`,
        );
    }
    return {
        details: {
            sourceSha256: reference.sourceSha256,
            moduleSha256: reference.moduleSha256,
            generatedStamp: reference.generatedStamp,
            browser: reference.browser,
            backends,
            bitExactWorld: backends.every((result) => result.world.byteExact),
            numericWorldEqual: backends.every(
                (result) => result.world.numericExact,
            ),
        },
    };
}
