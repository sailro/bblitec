import { readFile } from "node:fs/promises";
import { downloadCachedResource } from "./asset-download-cache.js";
import { isDataUrl, parseDataUrl } from "./data-url.js";
import { dropExtension } from "./compressed-geometry.js";
import {
    GLB_BINARY_CHUNK,
    GLB_JSON_CHUNK,
    GLB_MAGIC,
    asIndex,
    asObject,
    asStrings,
    type JsonRecord,
} from "./gltf-document.js";
import { dirname, extname, resolve } from "node:path";

const MESHOPT_EXTENSION = "EXT_meshopt_compression";
const BASISU_EXTENSION = "KHR_texture_basisu";
/** What a `.ktx2` image declares, and what its transcode packages as. */
const KTX2_MIME = "image/ktx2";
const KTX_MIME = "image/ktx";

/**
 * Which material slots `gltf-ext-basisu.ts` redirects, and at which colour
 * space it uploads each.
 *
 * `prepareBasisuMaterials` strips exactly these textureInfos out of the
 * shared JSON and `applyMaterial` uploads them, so a `KHR_texture_basisu`
 * texture reached from anywhere else is not redirected at all upstream — it
 * would arrive at the core loader with no `source`. The sRGB column is the
 * argument each `uploadBasisuTexture` call passes, and the ORM pair is
 * `uploadOrmTexture`'s single-image arm; the composite arm is refused
 * separately because it decodes to RGBA through an OffscreenCanvas rather
 * than staying compressed. `KHR_materials_specular`'s two slots are refused
 * beside it, at the material walk below, for the same kind of reason: the pin
 * registers the reflectance extension from `setPbrMetallicReflectance`, so
 * resolving them away would change the material's shape rather than its
 * upload.
 */
const basisuSlots: readonly {
    owner: "material" | "pbrMetallicRoughness";
    slot: string;
    srgb: boolean;
}[] = [
    { owner: "pbrMetallicRoughness", slot: "baseColorTexture", srgb: true },
    {
        owner: "pbrMetallicRoughness",
        slot: "metallicRoughnessTexture",
        srgb: false,
    },
    { owner: "material", slot: "normalTexture", srgb: false },
    { owner: "material", slot: "occlusionTexture", srgb: false },
    { owner: "material", slot: "emissiveTexture", srgb: true },
];

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
    if (typeof value !== "string") throw new Error(`glTF ${label} must be a string.`);
    return value;
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === "number" ? value : fallback;
}

function nonNegativeInteger(value: unknown, label: string, fallback?: number): number {
    const resolved = asIndex(value === undefined ? fallback : value);
    if (resolved === undefined) {
        throw new Error(`glTF ${label} must be a non-negative integer.`);
    }
    return resolved;
}

function meshoptExtension(record: JsonRecord): JsonRecord | undefined {
    return asObject(
        asObject(record.extensions)?.[MESHOPT_EXTENSION],
    );
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
function dataUri(uri: string): { bytes: Uint8Array; contentType?: string } | undefined {
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
    return { bytes: new Uint8Array(await readFile(resolve(baseDirectory, uri))) };
}

function glbChunks(bytes: Uint8Array): {
    document: JsonRecord;
    binary: Buffer;
} | undefined {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
        // A KTX2 image never reaches the runtime as one: the transcode
        // below replaces its bytes with the KTX1 container the port's own
        // compressed reader already parses. The type is carried this far so
        // the resolution finds it by the same field the loader would.
        case ".ktx2":
            return KTX2_MIME;
        default:
            throw new Error(`Unsupported external glTF image type: ${uri}.`);
    }
}

/**
 * Which images `KHR_texture_basisu` redirects a material slot to, and the
 * colour space each is uploaded at.
 *
 * Keyed by image index rather than texture index because the transcode is
 * per image: two textures naming one image are one bake. An image reached at
 * both colour spaces would need two containers under one index, which no
 * reached asset asks for, so it is refused by name instead of packaged
 * wrongly.
 */
function basisuImageColorSpaces(
    assetName: string,
    document: JsonRecord,
): Map<number, boolean> {
    const textures = asRecords(document.textures);
    const basisuSource = (textureIndex: number): number | undefined =>
        asIndex(
            asObject(
                asObject(textures[textureIndex]?.extensions)?.[
                    BASISU_EXTENSION
                ],
            )?.source,
        );
    const srgbByImage = new Map<number, boolean>();
    const reachedTextures = new Set<number>();
    for (const material of asRecords(document.materials)) {
        const owners: Record<string, JsonRecord> = {
            material,
            pbrMetallicRoughness:
                asObject(material.pbrMetallicRoughness) ?? {},
        };
        const slotTexture = (
            owner: string,
            slot: string,
        ): number | undefined =>
            asIndex(asObject(owners[owner]?.[slot])?.index);
        const metallicRoughness = slotTexture(
            "pbrMetallicRoughness",
            "metallicRoughnessTexture",
        );
        const occlusion = slotTexture("material", "occlusionTexture");
        // BOTH slots, not either: `stripBasisuTexture` fills a slot only
        // when that slot uses the extension, and `uploadOrmTexture` takes
        // its single-image arm unless both indices are present and differ.
        // A material whose metallic-roughness is basisu and whose occlusion
        // is an ordinary PNG never reaches the composite upstream, so
        // refusing it here would refuse a document the pin loads.
        if (
            metallicRoughness !== undefined &&
            occlusion !== undefined &&
            metallicRoughness !== occlusion &&
            basisuSource(metallicRoughness) !== undefined &&
            basisuSource(occlusion) !== undefined
        ) {
            throw new Error(
                `glTF ${assetName} composites separate ` +
                    `${BASISU_EXTENSION} occlusion and metallic-roughness ` +
                    "images, which the pinned extension decodes to RGBA " +
                    "through an OffscreenCanvas rather than uploading " +
                    "compressed blocks.",
            );
        }
        // The two slots the extension also redirects and this packager does
        // not resolve: `prepareBasisuMaterials` strips them out of the shared
        // JSON before `gltf-ext-dielectric` runs, and `applyMaterial` then
        // routes them through `setPbrMetallicReflectance` -- which is what
        // registers the reflectance extension at all. Resolving them away
        // would hand the core loader two ordinary textures and a material
        // that never registers it, so they are refused by name.
        const specular = asObject(
            asObject(material.extensions)?.["KHR_materials_specular"],
        );
        for (const slot of ["specularTexture", "specularColorTexture"]) {
            const textureIndex = asIndex(asObject(specular?.[slot])?.index);
            if (
                textureIndex !== undefined &&
                basisuSource(textureIndex) !== undefined
            ) {
                throw new Error(
                    `glTF ${assetName} reaches ${BASISU_EXTENSION} through ` +
                        `KHR_materials_specular's ${slot}, which the pinned ` +
                        "extension uploads through " +
                        "setPbrMetallicReflectance rather than the core " +
                        "texture path.",
                );
            }
        }
        for (const { owner, slot, srgb } of basisuSlots) {
            const textureIndex = slotTexture(owner, slot);
            if (textureIndex === undefined) continue;
            const source = basisuSource(textureIndex);
            if (source === undefined) continue;
            reachedTextures.add(textureIndex);
            // Resolving the extension away hands these slots back to the
            // CORE material mapper, and the pinned extension's own
            // `applyMaterial` reads three of their inputs differently:
            // it writes `occlusionStrength: 1.0` whatever the document
            // authored, forwards `texCoord` for occlusion alone, and
            // composes no `KHR_texture_transform` because
            // `prepareBasisuMaterials` deleted the textureInfo before the
            // core mapper could see it. A document using any of the three
            // would render differently here and in the browser, so each
            // refuses rather than resolving into a different answer.
            const info = asObject(
                asObject(owners[owner])?.[slot],
            );
            if (slot === "occlusionTexture" && info?.strength !== undefined) {
                throw new Error(
                    `glTF ${assetName} authors an occlusionTexture.strength ` +
                        `beside ${BASISU_EXTENSION}, which the pinned ` +
                        "extension overrides with 1.0 rather than reading.",
                );
            }
            const texCoord = asIndex(info?.texCoord);
            if (texCoord !== undefined && texCoord !== 0) {
                throw new Error(
                    `glTF ${assetName} reaches ${BASISU_EXTENSION} on ` +
                        `${slot} at texCoord ${texCoord}; the pinned ` +
                        "extension forwards a texCoord for occlusion alone " +
                        "and passes none for the other slots.",
                );
            }
            if (asObject(info?.extensions)?.["KHR_texture_transform"]) {
                throw new Error(
                    `glTF ${assetName} carries KHR_texture_transform on a ` +
                        `${BASISU_EXTENSION} ${slot}; the pinned extension ` +
                        "deletes the textureInfo before the transform hook " +
                        "runs, so upstream composes none.",
                );
            }
            const existing = srgbByImage.get(source);
            if (existing !== undefined && existing !== srgb) {
                throw new Error(
                    `glTF ${assetName} reaches ${BASISU_EXTENSION} image ` +
                        `${source} at both colour spaces, which the pinned ` +
                        "loader transcodes twice under its `index:sRGB` " +
                        "cache key.",
                );
            }
            srgbByImage.set(source, srgb);
        }
    }
    for (let textureIndex = 0; textureIndex < textures.length; ++textureIndex) {
        if (
            basisuSource(textureIndex) !== undefined &&
            !reachedTextures.has(textureIndex)
        ) {
            throw new Error(
                `glTF ${assetName} declares ${BASISU_EXTENSION} on texture ` +
                    `${textureIndex}, which no slot the pinned extension ` +
                    "redirects reaches, so upstream leaves it with no image " +
                    "source.",
            );
        }
    }
    return srgbByImage;
}

/**
 * The sampler `ktx2-loader.ts#makeSampler` builds, in glTF enums.
 *
 * The extension's textures never pass through `makeSamplerFor`: the pin
 * uploads them itself and gives each the one sampler that module builds —
 * repeat on both axes, linear min and mag, and a mip filter and anisotropy
 * that follow the chain the container carried. Resolving the extension away
 * hands the texture back to the core sampler path, so the sampler it reads
 * there is written here to say the same thing.
 */
function ktx2SamplerIndex(document: JsonRecord, mipCount: number): number {
    const sampler: JsonRecord = {
        magFilter: 9729,
        // LINEAR_MIPMAP_LINEAR, or LINEAR_MIPMAP_NEAREST for a single
        // level: `gltfTexSamplerDesc` reads the nearest mip filter off the
        // second enum and drops anisotropy with it, which is exactly what
        // `makeSampler` does at a mip count of one.
        minFilter: mipCount > 1 ? 9987 : 9985,
        wrapS: 10497,
        wrapT: 10497,
    };
    const samplers = asRecords(document.samplers);
    // By field, not by serialized text: a document that spells the same
    // four enums in a different key order would otherwise miss the reuse
    // and gain a duplicate sampler.
    const existing = samplers.findIndex((candidate) =>
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
): Promise<Uint8Array> {
    const remote = /^https?:\/\//i.test(source);
    const rootResource = remote
        ? await readResource(source, source, baseDirectory)
        : { bytes: new Uint8Array(await readFile(resolve(baseDirectory, source))) };
    const parsedGlb = glbChunks(rootResource.bytes);
    const document = parsedGlb?.document ?? asRecord(
        JSON.parse(new TextDecoder().decode(rootResource.bytes)),
    );
    const resourceDirectory = remote
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
            throw new Error(`glTF bufferView references missing buffer ${bufferIndex}.`);
        }
        if (placement.kind === "binary") {
            view.buffer = 0;
            view.byteOffset =
                placement.offset + numberValue(view.byteOffset);
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
                compressedPlacement.offset +
                compressedOffset;
        }
    }

    // KHR_texture_basisu is resolved away here, the way the geometry
    // extensions are resolved at materialization: each redirected image is
    // transcoded by the pin's own KTX2 loader and written back as the KTX1
    // container the port's compressed reader parses, so the loader that
    // ships sees an ordinary asset whose images happen to carry blocks.
    // Reading the colour spaces before the images are embedded is what lets
    // the container replace the KTX2 bytes rather than land beside them.
    const basisuColorSpaces = basisuImageColorSpaces(source, document);
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
            const { transcodeKtx2Texture, writeKtx1 } = await import(
                "./basis-transcode.js"
            );
            const { compressedTextureLowerer } = await import(
                "./compiler/compressed-texture.js"
            );
            const lowerer = compressedTextureLowerer();
            const transcoded = await transcodeKtx2Texture(uri, bytes);
            bytes = writeKtx1(
                transcoded,
                lowerer.magicBytes(),
                lowerer.glInternalFormat(
                    srgb
                        ? lowerer.srgbGpuFormat(transcoded.gpuFormat)
                        : transcoded.gpuFormat,
                ),
                lowerer.headerLayout(),
                lowerer.blockSize(transcoded.gpuFormat),
            );
            mimeType = KTX_MIME;
            transcodedSamplers.set(
                imageIndex,
                ktx2SamplerIndex(document, transcoded.mips.length),
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
    document.buffers = [
        { byteLength: binaryLength },
        ...fallbackBuffers,
    ];
    document.bufferViews = bufferViews;

    const json = Buffer.from(JSON.stringify(document), "utf8");
    const jsonLength = Math.ceil(json.length / 4) * 4;
    const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
    const glb = Buffer.alloc(totalLength, 0);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(totalLength, 8);
    glb.writeUInt32LE(jsonLength, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    glb.fill(0x20, 20, 20 + jsonLength);
    json.copy(glb, 20);
    const binaryHeader = 20 + jsonLength;
    glb.writeUInt32LE(binaryLength, binaryHeader);
    glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
    Buffer.concat(chunks).copy(glb, binaryHeader + 8);
    return glb;
}
