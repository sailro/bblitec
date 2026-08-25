// Shared GLB packing for the project-owned glTF fixtures.
//
// Each fixture builds a document plus one binary chunk, then writes a `.gltf`
// whose single buffer is that chunk as a `data:` URI — the shape
// `examples/assets/regression/` keeps, so a fixture is one reviewable file
// with no sibling payload. The four generators differed only in the accessors
// they build, so everything before and after that lives here.
import { writeFileSync } from "node:fs";

/** The binary chunk a fixture accumulates, 4-byte aligned like a GLB's. */
export function createBinaryChunk() {
    const chunks = [];
    let length = 0;
    const bufferViews = [];
    const accessors = [];

    /** Append `bytes` at the next 4-byte boundary; returns its offset. */
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

    /** Append `bytes` as a bufferView; returns its index. */
    function view(bytes) {
        const byteOffset = append(bytes);
        bufferViews.push({
            buffer: 0,
            byteOffset,
            byteLength: bytes.length,
        });
        return bufferViews.length - 1;
    }

    /** Record an accessor; returns its index. */
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

export function f32(values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeFloatLE(value, index * 4));
    return out;
}

export function u8(values) {
    return Buffer.from(Uint8Array.from(values));
}

export function u16(values) {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => out.writeUInt16LE(value, index * 2));
    return out;
}

export function u32(values) {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32LE(value, index * 4));
    return out;
}

/**
 * A FLOAT VEC3 accessor over `triples`, with the bounds glTF wants on a
 * POSITION accessor. Both the shape and the min/max derivation are the same
 * in every fixture that builds one.
 */
export function vec3Accessor(chunk, triples) {
    return chunk.accessor({
        bufferView: chunk.view(f32(triples.flat())),
        componentType: 5126,
        count: triples.length,
        type: "VEC3",
        min: [0, 1, 2].map((axis) =>
            Math.min(...triples.map((triple) => triple[axis])),
        ),
        max: [0, 1, 2].map((axis) =>
            Math.max(...triples.map((triple) => triple[axis])),
        ),
    });
}

/** Write the document with its binary chunk embedded as its one buffer. */
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
