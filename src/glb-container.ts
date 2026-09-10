import { GLB_BINARY_CHUNK as BINARY_CHUNK, GLB_JSON_CHUNK as JSON_CHUNK, GLB_MAGIC, type JsonRecord } from "./gltf-document.js";
export interface GlbChunks { json: JsonRecord; binary: Buffer }
/** Splits a GLB into its JSON and binary chunks, or undefined if not a GLB. */
export function readGlb(bytes: Uint8Array): GlbChunks | undefined {
    const buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    if (buffer.length < 12 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
        return undefined;
    }
    let offset = 12;
    let json: JsonRecord | undefined;
    let binary = Buffer.alloc(0);
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.readUInt32LE(offset + 4);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === JSON_CHUNK) {
            json = JSON.parse(data.toString("utf8")) as JsonRecord;
        } else if (type === BINARY_CHUNK) {
            binary = Buffer.from(data);
        }
        offset += 8 + length;
    }
    return json ? { json, binary } : undefined;
}

/** The inverse of `readGlb`, with the chunk padding the format requires. */
export function writeGlb(json: JsonRecord, binary: Buffer): Uint8Array {
    const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
    const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
    const binaryLength = Math.ceil(binary.length / 4) * 4;
    const total = 12 + 8 + jsonLength + 8 + binaryLength;
    const glb = Buffer.alloc(total, 0);
    glb.writeUInt32LE(GLB_MAGIC, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(total, 8);
    glb.writeUInt32LE(jsonLength, 12);
    glb.writeUInt32LE(JSON_CHUNK, 16);
    glb.fill(0x20, 20, 20 + jsonLength);
    jsonBytes.copy(glb, 20);
    const binaryHeader = 20 + jsonLength;
    glb.writeUInt32LE(binaryLength, binaryHeader);
    glb.writeUInt32LE(BINARY_CHUNK, binaryHeader + 4);
    binary.copy(glb, binaryHeader + 8);
    return glb;
}
