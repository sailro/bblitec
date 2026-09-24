// Shared GLB packing for the project-owned glTF fixtures.
//
// Each fixture builds a document plus one binary chunk, then writes a `.gltf`
// whose single buffer is that chunk as a `data:` URI — the shape
// `examples/assets/regression/` keeps, so a fixture is one reviewable file
// with no sibling payload. The four generators differed only in the accessors
// they build, so everything before and after that lives here.
import { writeFileSync } from "node:fs";

/**
 * @typedef {{ buffer: number, byteOffset: number, byteLength: number, byteStride?: number }} BufferView
 * @typedef {Record<string, unknown>} JsonRecord a glTF JSON object the fixture writes verbatim
 * @typedef {ReturnType<typeof createBinaryChunk>} BinaryChunk
 */

/** The binary chunk a fixture accumulates, 4-byte aligned like a GLB's. */
export function createBinaryChunk() {
    /** @type {Buffer[]} */
    const chunks = [];
    let length = 0;
    /** @type {BufferView[]} */
    const bufferViews = [];
    /** @type {JsonRecord[]} */
    const accessors = [];

    /**
     * Append `bytes` at the next 4-byte boundary; returns its offset.
     * @param {Uint8Array} bytes
     */
    function append(bytes) {
        const padding = (4 - (length % 4)) % 4;
        if (padding) {
            chunks.push(Buffer.alloc(padding));
            length += padding;
        }
        const offset = length;
        const buffer = Buffer.from(bytes);
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    }

    /**
     * Append `bytes` as a bufferView; returns its index.
     * @param {Uint8Array} bytes
     */
    function view(bytes) {
        const byteOffset = append(bytes);
        bufferViews.push({
            buffer: 0,
            byteOffset,
            byteLength: bytes.length,
        });
        return bufferViews.length - 1;
    }

    /**
     * Record an accessor; returns its index.
     * @param {JsonRecord} entry
     */
    function accessor(entry) {
        accessors.push(entry);
        return accessors.length - 1;
    }

    return {
        bufferViews,
        accessors,
        append,
        view,
        accessor,
        bytes: () => Buffer.concat(chunks),
    };
}

/** @param {readonly number[]} values */
export function f32(values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeFloatLE(value, index * 4));
    return out;
}

/** @param {readonly number[]} values */
export function u8(values) {
    return Buffer.from(Uint8Array.from(values));
}

/** @param {readonly number[]} values */
export function u16(values) {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => out.writeUInt16LE(value, index * 2));
    return out;
}

/** @param {readonly number[]} values */
export function u32(values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32LE(value, index * 4));
    return out;
}

const AXES = /** @type {const} */ ([0, 1, 2]);

/**
 * A FLOAT VEC3 accessor over `triples`, with the bounds glTF wants on a
 * POSITION accessor. Both the shape and the min/max derivation are the same
 * in every fixture that builds one.
 * @param {BinaryChunk} chunk
 * @param {ReadonlyArray<readonly [number, number, number]>} triples
 */
export function vec3Accessor(chunk, triples) {
    return chunk.accessor({
        bufferView: chunk.view(f32(triples.flat())),
        componentType: 5126,
        count: triples.length,
        type: "VEC3",
        min: AXES.map((axis) =>
            Math.min(...triples.map((triple) => triple[axis])),
        ),
        max: AXES.map((axis) =>
            Math.max(...triples.map((triple) => triple[axis])),
        ),
    });
}

/**
 * Write the document with its binary chunk embedded as its one buffer.
 * @param {string} path
 * @param {JsonRecord} document
 * @param {BinaryChunk} chunk
 */
export function writeFixture(path, document, chunk) {
    const binary = chunk.bytes();
    const written = {
        ...document,
        buffers: [
            {
                uri:
                    "data:application/octet-stream;base64," +
                    binary.toString("base64"),
                byteLength: binary.length,
            },
        ],
    };
    writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
    console.log(`wrote ${path} (${binary.length} binary bytes)`);
}
