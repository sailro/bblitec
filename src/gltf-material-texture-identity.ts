import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { GLTF_SOURCE_ALBEDO_IDENTITIES } from "./gltf-document.js";
import { asRecords, asStrings, type JsonObject } from "./json-fields.js";
import { javascriptModuleUrl } from "./data-url.js";
import { ensurePinnedLoaderExecution } from "./pinned-material-input.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
    pinnedLibraryRoot,
    pinnedModuleUrl,
} from "./pinned-shader-composer.js";
import { createRecordingDevice, RecordedTexture } from "./recording-device.js";
import {
    BasisuObservation,
    loadPinnedBasisuFeature,
} from "./pinned-gltf-basisu.js";

interface TextureCarrier {
    texture: object;
}
interface MaterialProbe {
    baseColorTexture: TextureCarrier;
    emissiveTexture?: TextureCarrier;
}
interface IdentityPayload {
    materials: number[];
    fallbackTexels: Record<number, number[]>;
    /** Each material's emissive texture identity, or -1; absent with none. */
    emissive?: number[];
}

interface PinnedGltfFeature {
    id: string;
    applyMaterial?: unknown;
}

/**
 * Execute the pin's cache, sampler and material construction with inert GPU
 * transport. Material extensions run as the pin's own triggered features;
 * a texture wrapper would give each use its own object, which is not
 * represented.
 */
export async function gltfSourceAlbedoIdentities(
    document: JsonObject,
): Promise<IdentityPayload> {
    const unsupported = asStrings(document.extensionsUsed).find(
        (extension) => extension === "KHR_texture_transform",
    );
    if (unsupported)
        throw new Error(
            `Source glTF albedo identity does not yet represent '${unsupported}' material or texture producers.`,
        );
    await ensurePinnedLoaderExecution();
    // Let the extension own per-material caches and overrides. Only image bytes
    // are replaced: each four-byte marker identifies the original image.
    const basisu = asStrings(document.extensionsUsed).includes(
        "KHR_texture_basisu",
    )
        ? await loadPinnedBasisuFeature()
        : undefined;
    const images = asRecords(document.images);
    const markers = new DataView(
        new ArrayBuffer(Math.max(1, images.length) * 4),
    );
    images.forEach((_, index) => markers.setUint32(index * 4, index, true));
    const sourceDocument: JsonObject = basisu
        ? {
              ...structuredClone(document),
              meshes: [],
              images: images.map((_, index) => ({ bufferView: index })),
              bufferViews: images.map((_, index) => ({
                  buffer: 0,
                  byteOffset: index * 4,
                  byteLength: 4,
              })),
          }
        : document;
    if (basisu) await basisu.preMesh(sourceDocument, markers, "");
    const parser = JSON.stringify(
        pathToFileURL(join(pinnedLibraryRoot(), "loader-gltf/gltf-parser.js"))
            .href,
    );
    // Image decoding is the transport leaf. The real makeImageFetcher still
    // owns each cache: separate resolutions produce separate bitmap objects.
    const parserShim = javascriptModuleUrl(`export * from ${parser};
export function resolveImage(_json, _bin, index) {
    return Promise.resolve({width: 1, height: 1, sourceImage: index});
}`);
    const materialUrl = pinnedModuleUrl(
        "loader-gltf/gltf-material.js",
        [],
        new Map([["./gltf-parser.js", parserShim]]),
    );
    const materials = (await import(materialUrl)) as {
        assembleMaterial(
            json: JsonObject,
            bin: ArrayBuffer,
            index: number,
            base: string,
            cache: unknown[],
        ): Promise<JsonObject>;
    };
    const loader = await importPinnedModuleWithExports<{
        uploadMeshes(
            this: void,
            meshes: JsonObject[],
            features: unknown[],
            context: JsonObject,
        ): Promise<Array<{ material: MaterialProbe }>>;
    }>(
        "loader-gltf/load-gltf.js",
        ["uploadMeshes"],
        new Map([
            ["./gltf-material.js", materialUrl],
            [
                "../texture/generate-mipmaps.js",
                javascriptModuleUrl("export function generateMipmaps() {}"),
            ],
        ]),
    );
    const { identityTexWrap } = await importPinnedModule<{
        identityTexWrap: (texture: object) => object;
    }>("loader-gltf/gltf-pbr-builder.js");
    // The pin owns texture object identity. Record uploads to retain factor
    // texels; compressed uploads use tokens without decoding image content.
    const { device } = createRecordingDevice({
        producer: "gltf-albedo-identity",
        device: ["createTexture", "createSampler", "createBuffer"],
        queue: ["copyExternalImageToTexture", "writeTexture"],
    });
    const basisuTextures = new WeakSet<object>();
    const engine = Object.assign(
        new BasisuObservation((image, srgb) => {
            const texture = device.createTexture({
                size: { width: 1, height: 1 },
                format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
                usage: 6,
            });
            basisuTextures.add(texture);
            return {
                texture,
                view: texture.createView(),
                width: 1,
                height: 1,
                sourceImage: image,
            };
        }),
        { _device: device },
    );
    const { loadGltfFeatures, runGltfMaterialFeatures } =
        await importPinnedModule<{
            loadGltfFeatures: (
                json: JsonObject,
            ) => Promise<PinnedGltfFeature[]>;
            runGltfMaterialFeatures: (
                material: unknown,
                features: unknown[],
                context: unknown,
            ) => Promise<unknown>;
        }>("loader-gltf/gltf-feature-registry.js");
    // The observed basisu feature stands in for the pin's own instance.
    const materialFeatures = (await loadGltfFeatures(sourceDocument)).filter(
        (feature) =>
            feature.applyMaterial !== undefined &&
            feature.id !== "KHR_texture_basisu",
    );
    const definitions = asRecords(sourceDocument.materials);
    // Include the pin's implicit default material as the last association.
    const indices = [...definitions.map((_, index) => index), -1];
    const cache: unknown[] = [];
    const bin = new ArrayBuffer(0);
    const assembled = await Promise.all(
        indices.map((index) =>
            materials.assembleMaterial(sourceDocument, bin, index, "", cache),
        ),
    );
    const probeDocument = {
        ...sourceDocument,
        meshes: indices.map(() => ({ name: "material-probe" })),
        nodes: indices.map((_, mesh) => ({ mesh })),
    };
    const meshes = assembled.map((material, index): JsonObject => ({
        _material: material,
        _nodeIndex: index,
        _primitive: {},
        _positions: new Float32Array([0, 0, 0]),
        _normals: new Float32Array([0, 1, 0]),
        _uvs: new Float32Array([0, 0]),
        _indices: new Uint16Array([0]),
        _indexCount: 1,
    }));
    const features = basisu ? [basisu] : [];
    const built = await loader.uploadMeshes(meshes, features, {
        _engine: engine,
        _json: probeDocument,
        _binChunk: bin,
        _baseUrl: "",
        _matExts: [...features, ...materialFeatures],
        _runMatExts: runGltfMaterialFeatures,
        _wrapTex: identityTexWrap,
    });
    const identities = new Map<object, number>();
    const fallbackTexels: Record<number, number[]> = {};
    const associations = built.map(({ material }) => {
        const source = material.baseColorTexture;
        let identity = identities.get(source);
        if (identity === undefined) {
            identity = identities.size;
            identities.set(source, identity);
            if (basisuTextures.has(source.texture)) return identity;
            const upload =
                source.texture instanceof RecordedTexture
                    ? source.texture.uploads.at(-1)
                    : undefined;
            if (!upload) {
                throw new Error(
                    "Pinned glTF albedo has no observed image or factor upload.",
                );
            }
            if (upload.kind === "write")
                fallbackTexels[identity] = [...upload.bytes];
        }
        return identity;
    });
    // An emissive texture shares the albedo identity space: the pin's cache
    // hands one Texture2D to every slot that samples the same image.
    const emissive = built.map(({ material }) => {
        const source = material.emissiveTexture;
        if (!source) return -1;
        let identity = identities.get(source);
        if (identity === undefined) {
            identity = identities.size;
            identities.set(source, identity);
        }
        return identity;
    });
    return {
        materials: associations,
        fallbackTexels,
        ...(emissive.some((identity) => identity >= 0) ? { emissive } : {}),
    };
}

export async function packageSourceAlbedoIdentities(
    document: JsonObject,
): Promise<void> {
    if (GLTF_SOURCE_ALBEDO_IDENTITIES in document) {
        throw new Error(
            "glTF source already carries compiler albedo identity metadata.",
        );
    }
    document[GLTF_SOURCE_ALBEDO_IDENTITIES] =
        await gltfSourceAlbedoIdentities(document);
}
