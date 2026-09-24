import { readFile } from "node:fs/promises";
import type { AssetDecoders } from "./asset-decoders.js";
import { compressedTextureFormat } from "./compressed-texture-format.js";
import { packageKtx1 } from "./compressed-texture-package.js";
import { downloadCachedResource } from "./asset-download-cache.js";
import { isDataUrl, javascriptModuleUrl, parseDataUrl } from "./data-url.js";
import { dropExtension } from "./compressed-geometry.js";
import { packageSourceAlbedoIdentities } from "./gltf-material-texture-identity.js";
import { packageMeshWalks, type CompiledMeshWalk } from "./gltf-mesh-walks.js";
import { writeGlb } from "./glb-container.js";
import {
    GLB_BINARY_CHUNK,
    GLB_JSON_CHUNK,
    GLB_MAGIC,
    asIndex,
    asObject,
    asStrings,
    type JsonRecord,
} from "./gltf-document.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
    installPinnedImportHook,
} from "./pinned-shader-composer.js";
import { createRecordingDevice } from "./recording-device.js";
import { dirname, extname, resolve } from "node:path";

const MESHOPT_EXTENSION = "EXT_meshopt_compression";
const BASISU_EXTENSION = "KHR_texture_basisu";
/** What a `.ktx2` image declares, and what its transcode packages as. */
const KTX2_MIME = "image/ktx2";
const KTX_MIME = compressedTextureFormat.mimeType;

function asRecord(value: unknown): JsonRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("glTF JSON value is not an object.");
    }
    return value as JsonRecord;
}

function asRecords(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown, label: string): string {
    if (typeof value !== "string")
        throw new Error(`glTF ${label} must be a string.`);
    return value;
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === "number" ? value : fallback;
}

function nonNegativeInteger(
    value: unknown,
    label: string,
    fallback?: number,
): number {
    const resolved = asIndex(value === undefined ? fallback : value);
    if (resolved === undefined) {
        throw new Error(`glTF ${label} must be a non-negative integer.`);
    }
    return resolved;
}

function meshoptExtension(record: JsonRecord): JsonRecord | undefined {
    return asObject(asObject(record.extensions)?.[MESHOPT_EXTENSION]);
}

function isMeshoptFallbackBuffer(buffer: JsonRecord): boolean {
    return meshoptExtension(buffer)?.fallback === true;
}

/**
 * A glTF's own inline resource.
 *
 * The base64 arm is `src/data-url.ts`'s, which is the one an asset URL takes;
 * a glTF may also embed a percent-encoded body, which that module refuses
 * deliberately, so this keeps the second arm rather than widening the
 * asset-facing reader to a form no reached asset URL uses.
 */
function dataUri(
    uri: string,
): { bytes: Uint8Array; contentType?: string } | undefined {
    if (!isDataUrl(uri)) return undefined;
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
    if (!match) return undefined;
    const contentType = match[1];
    if (match[2]) {
        const inline = parseDataUrl(uri)!;
        return {
            bytes: inline.bytes,
            ...(contentType ? { contentType } : {}),
        };
    }
    return {
        bytes: Buffer.from(decodeURIComponent(match[3]!), "utf8"),
        ...(contentType ? { contentType } : {}),
    };
}

async function readResource(
    uri: string,
    source: string,
    baseDirectory: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const inline = dataUri(uri);
    if (inline) return inline;
    if (/^https?:\/\//i.test(source)) {
        // A remote glTF's siblings -- its .bin buffers and its images -- are
        // pinned by the same commit as the document, so they cache with it. The
        // response's content type caches with them: an image can name a type its
        // URL's extension does not, and this packager refuses one it cannot
        // determine.
        return downloadCachedResource(new URL(uri, source).href);
    }
    return {
        bytes: new Uint8Array(await readFile(resolve(baseDirectory, uri))),
    };
}

function glbChunks(bytes: Uint8Array):
    | {
          document: JsonRecord;
          binary: Buffer;
      }
    | undefined {
    const buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    if (buffer.length < 12 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
        return undefined;
    }
    let offset = 12;
    let document: JsonRecord | undefined;
    let binary = Buffer.alloc(0);
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length;
        if (end > buffer.length) throw new Error("Truncated GLB chunk.");
        const chunk = buffer.subarray(offset + 8, end);
        if (type === GLB_JSON_CHUNK) {
            document = asRecord(JSON.parse(chunk.toString("utf8")));
        } else if (type === GLB_BINARY_CHUNK) {
            binary = Buffer.from(chunk);
        }
        offset = end;
    }
    if (!document) throw new Error("GLB is missing its JSON chunk.");
    return { document, binary };
}

function imageMimeType(uri: string, contentType?: string): string {
    if (
        contentType === "image/png" ||
        contentType === "image/jpeg" ||
        contentType === KTX2_MIME
    ) {
        return contentType;
    }
    switch (extname(uri).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        // The pinned transcode resolves this source MIME before packaging.
        case ".ktx2":
            return KTX2_MIME;
        default:
            throw new Error(`Unsupported external glTF image type: ${uri}.`);
    }
}

/** One upload `gltf-ext-basisu.ts` made: the image it read and its colour space. */
interface BasisuUpload {
    image: number;
    srgb: boolean;
}

/**
 * One material's routing run, handed to the pin as its engine: the KTX2
 * stand-in receives the engine with every upload, so concurrent packaging
 * runs record into their own observation.
 */
class BasisuObservation {
    public readonly uploads: BasisuUpload[] = [];
}

/** Why the pinned extension took an arm this packager does not resolve. */
class BasisuArmRefusal extends Error {}

interface PinnedBasisuFeature {
    id: string;
    preMesh: (
        json: JsonRecord,
        binChunk: DataView,
        baseUrl: string,
    ) => Promise<unknown>;
    applyMaterial: (
        mat: JsonRecord,
        ctx: JsonRecord,
    ) => Promise<JsonRecord | null>;
}

let pinnedBasisuFeature: Promise<PinnedBasisuFeature> | undefined;

/**
 * `gltf-ext-basisu.ts`, executed with its two transport imports answered.
 *
 * The KTX2 loader is where the pin hands over an image's bytes and the
 * colour space it wants, so its stand-in records that pair and returns a
 * token texture; the bytes are a marker naming the image (see
 * `basisuImageColorSpaces`). Its bitmap decoder is reached only by the composite
 * ORM arm, and `set-metallic-reflectance.js` only by the specular arm --
 * the two arms that do not end in a compressed upload of a core slot -- so
 * both stand-ins refuse, naming what the pin does there.
 */
function loadPinnedBasisuFeature(): Promise<PinnedBasisuFeature> {
    pinnedBasisuFeature ??= (async () => {
        const { hook } = installPinnedImportHook(
            (engine: unknown, image: number, srgb: boolean): void => {
                if (!(engine instanceof BasisuObservation)) {
                    throw new Error(
                        "The pinned KTX2 upload reached a basisu routing run " +
                            "with no observation.",
                    );
                }
                engine.uploads.push({ image, srgb });
            },
        );
        const { hook: refuse } = installPinnedImportHook(
            (what: string): never => {
                throw new BasisuArmRefusal(what);
            },
        );
        const marker = "new DataView(buffer).getUint32(0, true)";
        const ktx2 = javascriptModuleUrl(
            `export async function uploadKtx2Texture2D(engine, buffer, sRGB) {
    globalThis[${JSON.stringify(hook)}](engine, ${marker}, sRGB);
    return { image: ${marker}, sRGB };
}
export async function decodeKtx2ImageBitmapFromBuffer() {
    globalThis[${JSON.stringify(refuse)}]("composites separate occlusion and metallic-roughness images, which the pinned extension decodes to RGBA through an OffscreenCanvas rather than uploading compressed blocks");
}`,
        );
        const reflectance = javascriptModuleUrl(
            `export function setPbrMetallicReflectance() {
    globalThis[${JSON.stringify(refuse)}]("reaches KHR_materials_specular textures, which the pinned extension uploads through setPbrMetallicReflectance rather than the core texture path");
}`,
        );
        const module = await importPinnedModuleWithExports<{
            default: PinnedBasisuFeature;
        }>(
            "loader-gltf/gltf-ext-basisu.js",
            [],
            new Map([
                ["../texture/ktx2-loader.js", ktx2],
                ["../material/pbr/set-metallic-reflectance.js", reflectance],
            ]),
        );
        const feature = module.default;
        if (
            feature?.id !== BASISU_EXTENSION ||
            !feature.preMesh ||
            !feature.applyMaterial
        ) {
            throw new Error(
                "Pinned gltf-ext-basisu.js no longer exports a default " +
                    `${BASISU_EXTENSION} feature with preMesh and applyMaterial.`,
            );
        }
        return feature;
    })();
    return pinnedBasisuFeature;
}

/** Every textureInfo (an object carrying a numeric `index`) under `value`. */
function textureInfos(
    value: unknown,
    path: readonly string[] = [],
): Array<{ path: readonly string[]; info: JsonRecord }> {
    const record = asObject(value);
    if (!record) return [];
    if (typeof record.index === "number") return [{ path, info: record }];
    return Object.entries(record).flatMap(([key, child]) =>
        textureInfos(child, [...path, key]),
    );
}

/** The value at `path`, or undefined where any step is missing. */
function valueAt(root: unknown, path: readonly string[]): unknown {
    let value = root;
    for (const key of path) value = asObject(value)?.[key];
    return value;
}

/**
 * Which images `KHR_texture_basisu` redirects a material slot to, and the
 * colour space each is uploaded at -- read by running the pinned extension.
 *
 * Its `preMesh` strips every textureInfo it takes over out of the material
 * JSON (`prepareBasisuMaterials`), and its `applyMaterial` uploads each at the
 * colour space it chooses. Both run over a probe of the document: the
 * material and texture JSON as authored, and each image replaced by a
 * four-byte bufferView naming its own index, which is how an upload is
 * traced back to the image the pin read. What this packager adds are the
 * refusals of the documents where resolving the extension away would change
 * the result: a textureInfo the pin deletes before the transform hook runs,
 * a texCoord it does not forward, a strength it overrides, an image reached
 * at both colour spaces, a basisu texture no redirected slot reaches.
 */
async function basisuImageColorSpaces(
    assetName: string,
    document: JsonRecord,
): Promise<Map<number, boolean>> {
    const textures = asRecords(document.textures);
    const basisuSource = (
        texture: JsonRecord | undefined,
    ): number | undefined =>
        asIndex(
            asObject(asObject(texture?.extensions)?.[BASISU_EXTENSION])?.source,
        );
    const srgbByImage = new Map<number, boolean>();
    if (!textures.some((texture) => basisuSource(texture) !== undefined)) {
        return srgbByImage;
    }
    const images = asRecords(document.images);
    const markers = new DataView(
        new ArrayBuffer(Math.max(images.length, 1) * 4),
    );
    images.forEach((_, index) => markers.setUint32(index * 4, index, true));
    const authored = asRecords(structuredClone(document.materials ?? []));
    const probe: JsonRecord = {
        materials: structuredClone(document.materials ?? []),
        textures: structuredClone(document.textures ?? []),
        images: images.map((_, index) => ({ bufferView: index })),
        bufferViews: images.map((_, index) => ({
            buffer: 0,
            byteOffset: index * 4,
            byteLength: 4,
        })),
    };
    const feature = await loadPinnedBasisuFeature();
    await feature.preMesh(probe, markers, "");
    const reachedTextures = new Set<number>();
    for (const [index, material] of asRecords(probe.materials).entries()) {
        const stripped = textureInfos(authored[index]).filter(
            ({ path }) => valueAt(material, path) === undefined,
        );
        const observation = new BasisuObservation();
        let out: JsonRecord | null;
        try {
            out = await feature.applyMaterial(
                { _rawMatDef: material },
                { _engine: observation },
            );
        } catch (error) {
            if (error instanceof BasisuArmRefusal) {
                throw new Error(`glTF ${assetName} ${error.message}.`, {
                    cause: error,
                });
            }
            throw error;
        }
        for (const { path, info } of stripped) {
            const slot = path.at(-1) ?? "";
            reachedTextures.add(asIndex(info.index) ?? -1);
            if (asObject(info.extensions)?.["KHR_texture_transform"]) {
                throw new Error(
                    `glTF ${assetName} carries KHR_texture_transform on a ` +
                        `${BASISU_EXTENSION} ${slot}; the pinned extension ` +
                        "deletes the textureInfo before the transform hook " +
                        "runs, so upstream composes none.",
                );
            }
            // A texCoord the pin forwards is one its fragment carries under
            // the slot's own name (`occlusionTexture` -> `occlusionTexCoord`).
            const texCoord = asIndex(info.texCoord);
            const forwarded =
                slot.endsWith("Texture") &&
                out?.[`${slot.slice(0, -"Texture".length)}TexCoord`] ===
                    texCoord;
            if (texCoord !== undefined && texCoord !== 0 && !forwarded) {
                throw new Error(
                    `glTF ${assetName} reaches ${BASISU_EXTENSION} on ` +
                        `${slot} at texCoord ${texCoord}, which the pinned ` +
                        "extension does not forward.",
                );
            }
            if (info.strength !== undefined) {
                throw new Error(
                    `glTF ${assetName} authors a ${slot}.strength beside ` +
                        `${BASISU_EXTENSION}, which the pinned extension ` +
                        "overrides rather than reading.",
                );
            }
        }
        for (const { image, srgb } of observation.uploads) {
            const existing = srgbByImage.get(image);
            if (existing !== undefined && existing !== srgb) {
                throw new Error(
                    `glTF ${assetName} reaches ${BASISU_EXTENSION} image ` +
                        `${image} at both colour spaces, which the pinned ` +
                        "loader transcodes twice under its `index:sRGB` " +
                        "cache key.",
                );
            }
            srgbByImage.set(image, srgb);
        }
    }
    textures.forEach((texture, index) => {
        if (
            basisuSource(texture) !== undefined &&
            !reachedTextures.has(index)
        ) {
            throw new Error(
                `glTF ${assetName} declares ${BASISU_EXTENSION} on texture ` +
                    `${index}, which no slot the pinned extension redirects ` +
                    "reaches, so upstream leaves it with no image source.",
            );
        }
    });
    return srgbByImage;
}

/**
 * The glTF specification's sampler enumerations (`sampler.magFilter`,
 * `sampler.minFilter`, `sampler.wrapS`/`wrapT`). The pin reads them but
 * never tabulates them: `gltfTexSamplerDesc` tests the values it must tell
 * apart and lets every other fall to its default arm. Spelled once, as the
 * search space the derivation below runs the pin's own mapping over.
 */
const GLTF_SAMPLER_ENUMS = {
    magFilter: [9728, 9729],
    minFilter: [9728, 9729, 9984, 9985, 9986, 9987],
    wrap: [33071, 33648, 10497],
} as const;

/** A WebGPU sampler descriptor as both pinned functions spell it. */
type PinnedSamplerDescriptor = Readonly<Record<string, string | number>>;

/**
 * The sampler `ktx2-loader.ts#makeSampler` builds for a chain of `mipCount`
 * levels, read by executing it against a recording device: the one
 * descriptor it asks the device for.
 */
async function pinnedKtx2SamplerDescriptor(
    mipCount: number,
): Promise<PinnedSamplerDescriptor> {
    const { makeSampler } = await importPinnedModule<{
        makeSampler: (engine: unknown, mipCount: number) => unknown;
    }>("texture/ktx2-loader.js");
    const { device, recorder } = createRecordingDevice<{
        sampler: PinnedSamplerDescriptor;
        shaderModule: object;
        bindGroupLayout: object;
        pipelineLayout: object;
        renderPipeline: object;
        bindGroup: object;
    }>({ producer: "ktx2-sampler", device: ["createSampler"] });
    makeSampler({ _device: device }, mipCount);
    const descriptor = recorder.samplers[0];
    if (recorder.samplers.length !== 1 || !descriptor) {
        throw new Error(
            "Pinned ktx2-loader makeSampler asked its device for " +
                `${recorder.samplers.length} samplers rather than one.`,
        );
    }
    return descriptor;
}

/**
 * The glTF sampler the pin's own `gltfTexSamplerDesc` turns into
 * `descriptor`, found by running that mapping over the specification's
 * enumerations and refused unless exactly one sampler reproduces it.
 */
async function gltfSamplerFor(
    descriptor: PinnedSamplerDescriptor,
    what: string,
): Promise<JsonRecord> {
    const { gltfTexSamplerDesc } = await importPinnedModuleWithExports<{
        gltfTexSamplerDesc: (
            json: JsonRecord,
            texInfo: { index: number },
        ) => PinnedSamplerDescriptor;
    }>("loader-gltf/gltf-sampler-desc.js", ["gltfTexSamplerDesc"]);
    const reproduces = (mapped: PinnedSamplerDescriptor): boolean =>
        [
            ...new Set([...Object.keys(descriptor), ...Object.keys(mapped)]),
        ].every((key) => descriptor[key] === mapped[key]);
    const matches: JsonRecord[] = [];
    for (const magFilter of GLTF_SAMPLER_ENUMS.magFilter) {
        for (const minFilter of GLTF_SAMPLER_ENUMS.minFilter) {
            for (const wrapS of GLTF_SAMPLER_ENUMS.wrap) {
                for (const wrapT of GLTF_SAMPLER_ENUMS.wrap) {
                    const sampler: JsonRecord = {
                        magFilter,
                        minFilter,
                        wrapS,
                        wrapT,
                    };
                    const mapped = gltfTexSamplerDesc(
                        { textures: [{ sampler: 0 }], samplers: [sampler] },
                        { index: 0 },
                    );
                    if (reproduces(mapped)) matches.push(sampler);
                }
            }
        }
    }
    const match = matches[0];
    if (matches.length !== 1 || !match) {
        throw new Error(
            `${what}: ${matches.length} glTF samplers map to the pinned ` +
                `descriptor ${JSON.stringify(descriptor)} through ` +
                "gltfTexSamplerDesc, where exactly one must.",
        );
    }
    return match;
}

/**
 * The sampler `ktx2-loader.ts#makeSampler` builds, in glTF enums.
 *
 * The extension's textures never pass through `makeSamplerFor`: the pin
 * uploads them itself and gives each the one sampler that module builds.
 * Resolving the extension away hands the texture back to the core sampler
 * path, so the sampler written into the document has to be the one that
 * path maps to the same descriptor -- both halves executed from the pin,
 * for a chain of `mipCount` levels.
 */
async function ktx2SamplerIndex(
    document: JsonRecord,
    mipCount: number,
): Promise<number> {
    const sampler = await gltfSamplerFor(
        await pinnedKtx2SamplerDescriptor(mipCount),
        `${BASISU_EXTENSION} sampler`,
    );
    const samplers = asRecords(document.samplers);
    // By field, not by serialized text: a document that spells the same
    // four enums in a different key order would otherwise miss the reuse
    // and gain a duplicate sampler.
    const existing = samplers.findIndex(
        (candidate) =>
            Object.keys(sampler).every(
                (key) => candidate[key] === sampler[key],
            ) && Object.keys(candidate).length === Object.keys(sampler).length,
    );
    if (existing >= 0) return existing;
    samplers.push(sampler);
    document.samplers = samplers;
    return samplers.length - 1;
}

export async function packageGltf(
    source: string,
    baseDirectory: string,
    sourceTextureReads = false,
    meshWalks: readonly (CompiledMeshWalk | undefined)[] = [],
    decoders: AssetDecoders = {},
): Promise<Uint8Array> {
    const remote = /^https?:\/\//i.test(source);
    const rootResource = await readResource(source, source, baseDirectory);
    const parsedGlb = glbChunks(rootResource.bytes);
    const document =
        parsedGlb?.document ??
        asRecord(JSON.parse(new TextDecoder().decode(rootResource.bytes)));
    if (sourceTextureReads) await packageSourceAlbedoIdentities(document);
    await packageMeshWalks(document, meshWalks);
    const resourceDirectory =
        remote || isDataUrl(source)
            ? baseDirectory
            : dirname(resolve(baseDirectory, source));
    const chunks: Buffer[] = parsedGlb ? [parsedGlb.binary] : [];
    let binaryLength = parsedGlb?.binary.length ?? 0;
    const append = (bytes: Uint8Array): number => {
        const padding = (4 - (binaryLength % 4)) % 4;
        if (padding) {
            chunks.push(Buffer.alloc(padding));
            binaryLength += padding;
        }
        const offset = binaryLength;
        const buffer = Buffer.from(bytes);
        chunks.push(buffer);
        binaryLength += buffer.length;
        return offset;
    };

    const buffers = asRecords(document.buffers);
    const bufferViews = asRecords(document.bufferViews);
    const requiredExtensions = asStrings(document.extensionsRequired);
    const usedExtensions = asStrings(document.extensionsUsed);
    type BufferPlacement =
        | { kind: "binary"; offset: number; length: number }
        | { kind: "meshopt-fallback"; buffer: number };
    const placements: BufferPlacement[] = [];
    const fallbackBuffers: JsonRecord[] = [];
    type ParentView = {
        view: JsonRecord;
        viewIndex: number;
        compressed: JsonRecord | undefined;
    };
    const parentViewsByBuffer = new Map<number, ParentView[]>();
    const compressedSourceViewsByBuffer = new Map<number, number[]>();
    for (const [viewIndex, view] of bufferViews.entries()) {
        const compressed = meshoptExtension(view);
        const parentBuffer = numberValue(view.buffer, -1);
        if (parentBuffer >= 0) {
            const parentViews = parentViewsByBuffer.get(parentBuffer) ?? [];
            parentViews.push({ view, viewIndex, compressed });
            parentViewsByBuffer.set(parentBuffer, parentViews);
        }
        const compressedBuffer = numberValue(compressed?.buffer, -1);
        if (compressedBuffer >= 0) {
            const sourceViews =
                compressedSourceViewsByBuffer.get(compressedBuffer) ?? [];
            sourceViews.push(viewIndex);
            compressedSourceViewsByBuffer.set(compressedBuffer, sourceViews);
        }
    }
    for (const [index, buffer] of buffers.entries()) {
        const parentViews = parentViewsByBuffer.get(index) ?? [];
        const taggedFallback = isMeshoptFallbackBuffer(buffer);
        const implicitFallback =
            typeof buffer.uri !== "string" &&
            !(parsedGlb && index === 0) &&
            parentViews.length > 0 &&
            parentViews.every(({ compressed }) => compressed !== undefined);
        const fallback = taggedFallback || implicitFallback;

        // `fallback: true` is optional, but the fallback reference rules apply
        // whenever the marker is present or an URI-less placeholder is implied.
        if (fallback) {
            const byteLength = nonNegativeInteger(
                buffer.byteLength,
                `meshopt fallback buffer ${index} byteLength`,
            );
            for (const { view, viewIndex, compressed } of parentViews) {
                if (!compressed) {
                    throw new Error(
                        `glTF meshopt fallback buffer ${index} is referenced by ` +
                            `bufferView ${viewIndex} without ${MESHOPT_EXTENSION}.`,
                    );
                }
                const byteOffset = nonNegativeInteger(
                    view.byteOffset,
                    `bufferView ${viewIndex} byteOffset`,
                    0,
                );
                const viewByteLength = nonNegativeInteger(
                    view.byteLength,
                    `bufferView ${viewIndex} byteLength`,
                );
                if (byteOffset + viewByteLength > byteLength) {
                    throw new Error(
                        `glTF bufferView ${viewIndex} exceeds meshopt fallback ` +
                            `buffer ${index}.`,
                    );
                }
            }
            const compressedSourceView =
                compressedSourceViewsByBuffer.get(index)?.[0];
            if (compressedSourceView !== undefined) {
                throw new Error(
                    `glTF meshopt fallback buffer ${index} is used as the ` +
                        `compressed source of bufferView ${compressedSourceView}.`,
                );
            }
        }

        if (typeof buffer.uri !== "string") {
            if (parsedGlb && index === 0) {
                placements.push({
                    kind: "binary",
                    offset: 0,
                    length: parsedGlb.binary.length,
                });
                continue;
            }
            if (!fallback) {
                throw new Error(`glTF buffer ${index} is missing its URI.`);
            }
            if (!requiredExtensions.includes(MESHOPT_EXTENSION)) {
                throw new Error(
                    `glTF meshopt fallback buffer ${index} has no URI, so ` +
                        `${MESHOPT_EXTENSION} must be required.`,
                );
            }
            if (!usedExtensions.includes(MESHOPT_EXTENSION)) {
                throw new Error(
                    `glTF meshopt fallback buffer ${index} has no URI, so ` +
                        `${MESHOPT_EXTENSION} must be listed in extensionsUsed.`,
                );
            }
            const fallbackIndex = 1 + fallbackBuffers.length;
            fallbackBuffers.push(buffer);
            placements.push({
                kind: "meshopt-fallback",
                buffer: fallbackIndex,
            });
            continue;
        }
        const uri = stringValue(buffer.uri, "buffer URI");
        const resource = await readResource(uri, source, resourceDirectory);
        placements.push({
            kind: "binary",
            offset: append(resource.bytes),
            length: resource.bytes.byteLength,
        });
    }

    for (const [viewIndex, view] of bufferViews.entries()) {
        const bufferIndex = numberValue(view.buffer);
        const placement = placements[bufferIndex];
        if (!placement) {
            throw new Error(
                `glTF bufferView references missing buffer ${bufferIndex}.`,
            );
        }
        if (placement.kind === "binary") {
            view.buffer = 0;
            view.byteOffset = placement.offset + numberValue(view.byteOffset);
        } else {
            view.buffer = placement.buffer;
        }

        // The extension's source is a second buffer range, independent of
        // the parent bufferView's fallback range. Rebase it through the same
        // embedding map so the pinned decoder sees every compressed source in
        // the GLB binary chunk at buffer 0.
        const compressed = meshoptExtension(view);
        if (compressed) {
            const compressedBuffer = nonNegativeInteger(
                compressed.buffer,
                `${MESHOPT_EXTENSION} buffer on bufferView ${viewIndex}`,
            );
            const compressedPlacement = placements[compressedBuffer];
            if (!compressedPlacement) {
                throw new Error(
                    `glTF ${MESHOPT_EXTENSION} on bufferView ${viewIndex} ` +
                        `references missing buffer ${compressedBuffer}.`,
                );
            }
            if (compressedPlacement.kind !== "binary") {
                throw new Error(
                    `glTF ${MESHOPT_EXTENSION} on bufferView ${viewIndex} ` +
                        "uses a fallback buffer as its compressed source.",
                );
            }
            const compressedOffset = nonNegativeInteger(
                compressed.byteOffset,
                `${MESHOPT_EXTENSION} byteOffset on bufferView ${viewIndex}`,
                0,
            );
            const compressedLength = nonNegativeInteger(
                compressed.byteLength,
                `${MESHOPT_EXTENSION} byteLength on bufferView ${viewIndex}`,
            );
            if (
                compressedOffset + compressedLength >
                compressedPlacement.length
            ) {
                throw new Error(
                    `glTF ${MESHOPT_EXTENSION} source range on bufferView ` +
                        `${viewIndex} exceeds buffer ${compressedBuffer}.`,
                );
            }
            compressed.buffer = 0;
            compressed.byteOffset =
                compressedPlacement.offset + compressedOffset;
        }
    }

    // Resolve KHR_texture_basisu to the pinned transcode and mip list.
    // Select colour spaces before replacing the embedded images.
    const basisuColorSpaces = await basisuImageColorSpaces(source, document);
    const transcodedSamplers = new Map<number, number>();
    for (const [imageIndex, image] of asRecords(document.images).entries()) {
        if (typeof image.uri !== "string") {
            if (
                image.mimeType === KTX2_MIME ||
                basisuColorSpaces.has(imageIndex)
            ) {
                throw new Error(
                    `glTF ${source} embeds ${BASISU_EXTENSION} image ` +
                        `${imageIndex} in its binary chunk, which this ` +
                        "packager transcodes only from an external URI.",
                );
            }
            continue;
        }
        const uri = image.uri;
        const resource = await readResource(uri, source, resourceDirectory);
        let bytes = resource.bytes;
        let mimeType = imageMimeType(uri, resource.contentType);
        if (mimeType === KTX2_MIME) {
            const srgb = basisuColorSpaces.get(imageIndex);
            if (srgb === undefined) {
                throw new Error(
                    `glTF ${source} carries KTX2 image ${imageIndex} that ` +
                        `no ${BASISU_EXTENSION} texture names.`,
                );
            }
            const { transcodeKtx2Texture, writeKtx1 } =
                await import("./basis-transcode.js");
            const { compressedTextureLowerer } =
                await import("./compiler/compressed-texture.js");
            const lowerer = compressedTextureLowerer();
            const transcoded = await transcodeKtx2Texture(
                uri,
                bytes,
                await decoders.ktx2?.(),
            );
            bytes = await packageKtx1(
                writeKtx1(
                    transcoded,
                    lowerer.magicBytes(),
                    lowerer.glInternalFormat(
                        srgb
                            ? lowerer.srgbGpuFormat(transcoded.gpuFormat)
                            : transcoded.gpuFormat,
                    ),
                    lowerer.headerLayout(),
                    lowerer.blockSize(transcoded.gpuFormat),
                ),
            );
            mimeType = KTX_MIME;
            transcodedSamplers.set(
                imageIndex,
                await ktx2SamplerIndex(document, transcoded.mips.length),
            );
        }
        const offset = append(bytes);
        bufferViews.push({
            buffer: 0,
            byteOffset: offset,
            byteLength: bytes.byteLength,
        });
        image.bufferView = bufferViews.length - 1;
        image.mimeType = mimeType;
        delete image.uri;
    }
    if (basisuColorSpaces.size > 0) {
        for (const texture of asRecords(document.textures)) {
            const extensions = asObject(texture.extensions);
            const basisu = asObject(extensions?.[BASISU_EXTENSION]);
            const image = asIndex(basisu?.source);
            if (image === undefined) continue;
            texture.source = image;
            texture.sampler = transcodedSamplers.get(image);
            delete extensions![BASISU_EXTENSION];
            if (Object.keys(extensions!).length === 0) {
                delete texture.extensions;
            }
        }
        // The same drop the geometry passes make, from the same home: a
        // document whose bytes no longer carry the extension must not go
        // on requiring it, and the empty-`extensionsRequired` rule is
        // stated once rather than in each resolving pass.
        dropExtension(document, BASISU_EXTENSION);
    }

    const finalPadding = (4 - (binaryLength % 4)) % 4;
    if (finalPadding) {
        chunks.push(Buffer.alloc(finalPadding));
        binaryLength += finalPadding;
    }
    document.buffers = [{ byteLength: binaryLength }, ...fallbackBuffers];
    document.bufferViews = bufferViews;

    return writeGlb(document, Buffer.concat(chunks));
}
