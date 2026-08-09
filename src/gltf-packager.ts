import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

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

function dataUri(uri: string): { bytes: Uint8Array; contentType?: string } | undefined {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
    if (!match) return undefined;
    const contentType = match[1];
    const bytes = match[2]
        ? Buffer.from(match[3]!, "base64")
        : Buffer.from(decodeURIComponent(match[3]!), "utf8");
    return { bytes, ...(contentType ? { contentType } : {}) };
}

async function readResource(
    uri: string,
    source: string,
    baseDirectory: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const inline = dataUri(uri);
    if (inline) return inline;
    if (/^https?:\/\//i.test(source)) {
        const response = await fetch(new URL(uri, source));
        if (!response.ok) {
            throw new Error(`Failed to download ${response.url}: HTTP ${response.status}.`);
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0];
        return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            ...(contentType ? { contentType } : {}),
        };
    }
    return { bytes: new Uint8Array(await readFile(resolve(baseDirectory, uri))) };
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
    const rootResource = /^https?:\/\//i.test(source)
        ? await readResource(source, source, baseDirectory)
        : { bytes: new Uint8Array(await readFile(resolve(baseDirectory, source))) };
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rootResource.bytes));
    const document = asRecord(parsed);
    const chunks: Buffer[] = [];
    let binaryLength = 0;
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
    for (const buffer of buffers) {
        const uri = stringValue(buffer.uri, "buffer URI");
        const resource = await readResource(uri, source, baseDirectory);
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
        const resource = await readResource(uri, source, baseDirectory);
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
