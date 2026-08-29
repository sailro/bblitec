import { readFile } from "node:fs/promises";
import { downloadCachedResource } from "./asset-download-cache.js";
import { isDataUrl, parseDataUrl } from "./data-url.js";
import {
    GLB_BINARY_CHUNK,
    GLB_JSON_CHUNK,
    GLB_MAGIC,
} from "./gltf-document.js";
import { dirname, extname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

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
    if (contentType === "image/png" || contentType === "image/jpeg") return contentType;
    switch (extname(uri).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        default:
            throw new Error(`Unsupported external glTF image type: ${uri}.`);
    }
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
    const offsets: number[] = [];
    for (const [index, buffer] of buffers.entries()) {
        if (typeof buffer.uri !== "string") {
            if (parsedGlb && index === 0) {
                offsets.push(0);
                continue;
            }
            throw new Error(`glTF buffer ${index} is missing its URI.`);
        }
        const uri = stringValue(buffer.uri, "buffer URI");
        const resource = await readResource(uri, source, resourceDirectory);
        offsets.push(append(resource.bytes));
    }

    const bufferViews = asRecords(document.bufferViews);
    for (const view of bufferViews) {
        const bufferIndex = numberValue(view.buffer);
        const baseOffset = offsets[bufferIndex];
        if (baseOffset === undefined) {
            throw new Error(`glTF bufferView references missing buffer ${bufferIndex}.`);
        }
        view.buffer = 0;
        view.byteOffset = baseOffset + numberValue(view.byteOffset);
    }

    for (const image of asRecords(document.images)) {
        if (typeof image.uri !== "string") continue;
        const uri = image.uri;
        const resource = await readResource(uri, source, resourceDirectory);
        const offset = append(resource.bytes);
        bufferViews.push({
            buffer: 0,
            byteOffset: offset,
            byteLength: resource.bytes.byteLength,
        });
        image.bufferView = bufferViews.length - 1;
        image.mimeType = imageMimeType(uri, resource.contentType);
        delete image.uri;
    }

    const finalPadding = (4 - (binaryLength % 4)) % 4;
    if (finalPadding) {
        chunks.push(Buffer.alloc(finalPadding));
        binaryLength += finalPadding;
    }
    document.buffers = [{ byteLength: binaryLength }];
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
