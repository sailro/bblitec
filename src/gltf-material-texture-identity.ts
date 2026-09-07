import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { asRecords, asStrings, type JsonObject } from "./gltf-document.js";
import { javascriptModuleUrl } from "./data-url.js";
import { ensurePinnedLoaderExecution } from "./pinned-material-input.js";
import { importPinnedModule, importPinnedModuleWithExports, pinnedLibraryRoot, pinnedModuleUrl } from "./pinned-shader-composer.js";

export const GLTF_SOURCE_ALBEDO_IDENTITIES = "__bblitecSourceAlbedoIdentities";

interface TextureObservation { image?: number; fallback?: number[] }
interface TextureCarrier { texture: object }
interface MaterialProbe { baseColorTexture: TextureCarrier }
interface IdentityPayload { materials: number[]; fallbackTexels: Record<number, number[]> }
interface GpuTextureDescriptor { format: string }

/** Execute the pin's cache, sampler and material construction with inert GPU transport. */
export async function gltfSourceAlbedoIdentities(document: JsonObject): Promise<IdentityPayload> {
    const unsupported = asStrings(document.extensionsUsed).find(extension =>
        extension.startsWith("KHR_materials_") || extension === "KHR_texture_transform" || extension === "KHR_texture_basisu");
    if (unsupported) throw new Error(`Source glTF albedo identity does not yet represent '${unsupported}' material or texture producers.`);
    await ensurePinnedLoaderExecution();
    const parser = JSON.stringify(pathToFileURL(join(pinnedLibraryRoot(), "loader-gltf/gltf-parser.js")).href);
    // Image decoding is the transport leaf. The real makeImageFetcher still
    // owns each cache: separate resolutions produce separate bitmap objects.
    const parserShim = javascriptModuleUrl(`export * from ${parser};
export function resolveImage(_json, _bin, index) {
    return Promise.resolve({width: 1, height: 1, sourceImage: index});
}`);
    const materialUrl = pinnedModuleUrl("loader-gltf/gltf-material.js", [], new Map([["./gltf-parser.js", parserShim]]));
    const materials = await import(materialUrl) as {
        assembleMaterial(json: JsonObject, bin: ArrayBuffer, index: number, base: string, cache: unknown[]): Promise<JsonObject>;
    };
    const loader = await importPinnedModuleWithExports<{
        uploadMeshes(meshes: JsonObject[], features: unknown[], context: JsonObject): Promise<Array<{material: MaterialProbe}>>;
    }>("loader-gltf/load-gltf.js", ["uploadMeshes"], new Map([
        ["./gltf-material.js", materialUrl],
        ["../texture/generate-mipmaps.js", javascriptModuleUrl("export function generateMipmaps() {}")],
    ]));
    const { identityTexWrap } = await importPinnedModule<{identityTexWrap: (texture: object) => object}>("loader-gltf/gltf-pbr-builder.js");
    const uploaded = new WeakMap<object, TextureObservation>();
    const device = {
        createTexture(_descriptor: GpuTextureDescriptor) {
            const texture = {createView: () => ({})};
            uploaded.set(texture, {});
            return texture;
        },
        createSampler: (descriptor: object) => ({descriptor}),
        createBuffer: ({size}: {size: number}) => ({getMappedRange: () => new ArrayBuffer(size), unmap() {}}),
        queue: {
            copyExternalImageToTexture(source: {source: {sourceImage: number}}, target: {texture: object}) {
                uploaded.set(target.texture, {image: source.source.sourceImage});
            },
            writeTexture(target: {texture: object}, bytes: Uint8Array) {
                uploaded.set(target.texture, {fallback: [...bytes]});
            },
        },
    };
    const definitions = asRecords(document.materials);
    // Include the pin's implicit default material as the last association.
    const indices = [...definitions.map((_, index) => index), -1];
    const cache: unknown[] = [];
    const bin = new ArrayBuffer(0);
    const assembled = await Promise.all(indices.map(index => materials.assembleMaterial(document, bin, index, "", cache)));
    const probeDocument = {...document,
        meshes: indices.map(() => ({name: "material-probe"})), nodes: indices.map((_, mesh) => ({mesh})),
    };
    const meshes = assembled.map((material, index): JsonObject => ({
        _material: material, _nodeIndex: index, _primitive: {},
        _positions: new Float32Array([0, 0, 0]), _normals: new Float32Array([0, 1, 0]),
        _uvs: new Float32Array([0, 0]), _indices: new Uint16Array([0]), _indexCount: 1,
    }));
    const built = await loader.uploadMeshes(meshes, [], {
        _engine: {_device: device}, _json: probeDocument, _binChunk: bin, _baseUrl: "",
        _matExts: [], _wrapTex: identityTexWrap,
    });
    const identities = new Map<object, number>();
    const fallbackTexels: Record<number, number[]> = {};
    const associations = built.map(({material}) => {
        const source = material.baseColorTexture;
        let identity = identities.get(source);
        if (identity === undefined) {
            identity = identities.size;
            identities.set(source, identity);
            const receipt = uploaded.get(source.texture);
            if (!receipt || (receipt.image === undefined && !receipt.fallback)) {
                throw new Error("Pinned glTF albedo has no observed image or factor upload.");
            }
            if (receipt.fallback) fallbackTexels[identity] = receipt.fallback;
        }
        return identity;
    });
    return {materials: associations, fallbackTexels};
}

export async function packageSourceAlbedoIdentities(document: JsonObject): Promise<void> {
    if (GLTF_SOURCE_ALBEDO_IDENTITIES in document) {
        throw new Error("glTF source already carries compiler albedo identity metadata.");
    }
    document[GLTF_SOURCE_ALBEDO_IDENTITIES] = await gltfSourceAlbedoIdentities(document);
}
