import { writeFileSync } from "node:fs";
import { resolveGlbGeometry } from "../src/compressed-geometry.js";
import { readGlb, writeGlb } from "../src/glb-container.js";
import {
    GLB_BINARY_CHUNK,
    GLB_JSON_CHUNK,
    GLB_MAGIC,
} from "../src/gltf-document.js";

/**
 * A GLB built in memory, for the tests that hand one to a packaging or
 * specialization pass.
 *
 * Three test files were framing chunks by hand against the same three magic
 * numbers, which is one copy per file of a format detail none of them is
 * about. The chunk padding is the format's: both chunks are 4-byte aligned,
 * JSON padded with spaces and the binary with zeros.
 */
export function buildGlb(
    document: Record<string, unknown>,
    binary: Buffer = Buffer.alloc(0),
): Buffer {
    const json = Buffer.from(JSON.stringify(document), "utf8");
    const jsonLength = Math.ceil(json.length / 4) * 4;
    const binaryLength = Math.ceil(binary.length / 4) * 4;
    const total = 12 + 8 + jsonLength + 8 + binaryLength;
    const glb = Buffer.alloc(total, 0);
    glb.writeUInt32LE(GLB_MAGIC, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(total, 8);
    glb.writeUInt32LE(jsonLength, 12);
    glb.writeUInt32LE(GLB_JSON_CHUNK, 16);
    glb.fill(0x20, 20, 20 + jsonLength);
    json.copy(glb, 20);
    const binaryHeader = 20 + jsonLength;
    glb.writeUInt32LE(binaryLength, binaryHeader);
    glb.writeUInt32LE(GLB_BINARY_CHUNK, binaryHeader + 4);
    binary.copy(glb, binaryHeader + 8);
    return glb;
}

/** `buildGlb`, written to `path`. */
export function writeGlbFixture(
    path: string,
    document: Record<string, unknown>,
    binary: Buffer = Buffer.alloc(0),
): void {
    writeFileSync(path, buildGlb(document, binary));
}

/** The JSON and binary chunks back out of a GLB this module built. */
export function readGlbFixture(bytes: Uint8Array): {
    document: Record<string, unknown>;
    binary: Buffer;
} {
    const glb = Buffer.from(bytes);
    const jsonLength = glb.readUInt32LE(12);
    const document = JSON.parse(
        glb
            .subarray(20, 20 + jsonLength)
            .toString("utf8")
            .trim(),
    ) as Record<string, unknown>;
    const binaryHeader = 20 + jsonLength;
    const binaryLength = glb.readUInt32LE(binaryHeader);
    return {
        document,
        binary: glb.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength),
    };
}

/**
 * The generation geometry pass over GLB bytes: the same bytes back when no
 * extension it resolves is present, otherwise the rewritten container.
 */
export async function resolveGeometryExtensions(
    bytes: Uint8Array,
    label: string,
): Promise<Uint8Array> {
    const glb = readGlb(bytes);
    if (!glb) return bytes;
    return (await resolveGlbGeometry(glb, label))
        ? writeGlb(glb.json, glb.binary)
        : bytes;
}
