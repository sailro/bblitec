// Compressed glTF geometry, decoded at generation time.
//
// `KHR_draco_mesh_compression` and `EXT_meshopt_compression` are decoded by
// WebAssembly modules that Babylon Lite loads at run time from
// `lab/public/draco_decoder.js`, `draco_decoder.wasm` and
// `meshopt_decoder.js`. Those artifacts are part of the pin, which is what
// makes decoding here faithful rather than a reimplementation: the browser
// reference and this pass run the same decoder build over the same bytes,
// so the vertices agree by construction instead of by argument.
//
// Doing it at generation time keeps the native runtime free of a
// decompression dependency and preserves the rule that a built scene opens
// only local files. What ships is ordinary geometry.
//
// An asset that uses neither extension is returned unchanged, so the pass
// cannot churn the assets that do not need it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import {
    GLB_BINARY_CHUNK as BINARY_CHUNK,
    GLB_JSON_CHUNK as JSON_CHUNK,
    GLB_MAGIC,
    asObject,
    type JsonRecord,
} from "./gltf-document.js";
import { readUpstreamPin } from "./upstream-source.js";

const DRACO_EXTENSION = "KHR_draco_mesh_compression";
const MESHOPT_EXTENSION = "EXT_meshopt_compression";

const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_INT = 5125;

/** glTF accessor type names by component count. */
const ACCESSOR_TYPES: Record<number, string> = {
    1: "SCALAR",
    2: "VEC2",
    3: "VEC3",
    4: "VEC4",
};

interface GlbChunks {
    json: JsonRecord;
    binary: Buffer;
}

// Cast-only on purpose, unlike gltf-document's filtering asRecords: the
// chunk rewriter trusts documents it just parsed or built itself.
function asRecords(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === "number" ? value : fallback;
}

/** Splits a GLB into its JSON and binary chunks, or undefined if not a GLB. */
function readGlb(bytes: Uint8Array): GlbChunks | undefined {
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
function writeGlb(json: JsonRecord, binary: Buffer): Uint8Array {
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

/**
 * A decoder artifact from the pin, cached under `.cache` by commit so a
 * generation run is offline after the first fetch and a pin bump cannot
 * silently reuse the previous decoder.
 */
async function pinnedArtifact(name: string): Promise<Buffer> {
    const pin = readUpstreamPin().sourceVersion;
    const directory = resolve(".cache", "pinned-decoders", pin);
    const path = join(directory, name);
    if (existsSync(path)) {
        return readFileSync(path);
    }
    const url =
        "https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/" +
        `${pin}/lab/public/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Failed to download the pinned ${name}: HTTP ${response.status}.`,
        );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, bytes);
    return bytes;
}

interface DracoModule {
    Decoder: new () => {
        DecodeBufferToMesh(
            buffer: unknown,
            mesh: unknown,
        ): { ok(): boolean; error_msg(): string };
        GetTrianglesUInt32Array(
            mesh: unknown,
            byteLength: number,
            pointer: number,
        ): void;
        GetAttributeByUniqueId(mesh: unknown, uniqueId: number): unknown;
        GetAttributeDataArrayForAllPoints(
            mesh: unknown,
            attribute: unknown,
            dataType: number,
            byteLength: number,
            pointer: number,
        ): boolean;
    };
    DecoderBuffer: new () => {
        Init(data: Uint8Array, size: number): void;
    };
    Mesh: new () => { num_faces(): number; num_points(): number };
    destroy(value: unknown): void;
    HEAPF32: Float32Array;
    HEAPU32: Uint32Array;
    HEAP32: Int32Array;
    DT_FLOAT32: number;
    DT_INT32: number;
    _malloc(size: number): number;
    _free(pointer: number): void;
}

let dracoModule: Promise<DracoModule> | undefined;

/**
 * The pinned Draco decoder, instantiated without a DOM.
 *
 * `draco_decoder.js` is Emscripten glue written for `<script>` injection,
 * so it is run in a context that has the globals it touches and nothing
 * else; the WebAssembly is handed over directly rather than fetched, which
 * is what keeps the whole thing offline.
 */
async function loadDracoModule(): Promise<DracoModule> {
    if (dracoModule) return dracoModule;
    dracoModule = (async () => {
        const [glue, wasm] = await Promise.all([
            pinnedArtifact("draco_decoder.js"),
            pinnedArtifact("draco_decoder.wasm"),
        ]);
        const sandbox: Record<string, unknown> = {
            console,
            WebAssembly,
            fetch,
            TextDecoder,
            TextEncoder,
            URL,
            Buffer,
            setTimeout,
            clearTimeout,
            performance,
        };
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;
        createContext(sandbox);
        runInContext(glue.toString("utf8"), sandbox, {
            filename: "draco_decoder.js",
        });
        const factory = sandbox.DracoDecoderModule as
            | ((options: unknown) => Promise<DracoModule>)
            | undefined;
        if (typeof factory !== "function") {
            throw new Error(
                "The pinned draco_decoder.js did not define DracoDecoderModule.",
            );
        }
        return factory({ wasmBinary: new Uint8Array(wasm) });
    })();
    return dracoModule;
}

interface DecodedPrimitive {
    indices: Uint32Array;
    attributes: Map<string, Float32Array | Int32Array>;
    vertexCount: number;
}

/**
 * Decodes one Draco primitive exactly as `draco-decode.ts` does.
 *
 * Every attribute the extension lists is decoded, including one the
 * primitive itself does not declare, and a component count is only known
 * for the declared ones -- the rest fall back to three. That is the pinned
 * behaviour, and the browser reference is rendered from its output, so it
 * is reproduced rather than corrected.
 */
async function decodeDracoPrimitive(
    compressed: Uint8Array,
    attributeMap: Record<string, number>,
    componentCounts: Record<string, number>,
): Promise<DecodedPrimitive> {
    const module = await loadDracoModule();
    const decoder = new module.Decoder();
    const buffer = new module.DecoderBuffer();
    buffer.Init(compressed, compressed.byteLength);
    const mesh = new module.Mesh();
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok()) {
        const message = status.error_msg();
        module.destroy(buffer);
        module.destroy(mesh);
        module.destroy(decoder);
        throw new Error(`Draco decode failed: ${message}`);
    }

    const vertexCount = mesh.num_points();
    const indexCount = mesh.num_faces() * 3;
    // The heap views are re-read after every allocation: `_malloc` can grow
    // the WebAssembly memory and detach the arrays already held.
    const indexPointer = module._malloc(indexCount * 4);
    decoder.GetTrianglesUInt32Array(mesh, indexCount * 4, indexPointer);
    const indices = new Uint32Array(
        module.HEAPU32.buffer,
        indexPointer,
        indexCount,
    ).slice();
    module._free(indexPointer);

    const attributes = new Map<string, Float32Array | Int32Array>();
    for (const [name, uniqueId] of Object.entries(attributeMap)) {
        const componentCount = componentCounts[name] ?? 3;
        const total = vertexCount * componentCount;
        const joints = name === "JOINTS_0" || name === "JOINTS_1";
        const pointer = module._malloc(total * 4);
        const attribute = decoder.GetAttributeByUniqueId(mesh, uniqueId);
        decoder.GetAttributeDataArrayForAllPoints(
            mesh,
            attribute,
            joints ? module.DT_INT32 : module.DT_FLOAT32,
            total * 4,
            pointer,
        );
        attributes.set(
            name,
            joints
                ? new Int32Array(module.HEAP32.buffer, pointer, total).slice()
                : new Float32Array(
                      module.HEAPF32.buffer,
                      pointer,
                      total,
                  ).slice(),
        );
        module._free(pointer);
    }

    module.destroy(buffer);
    module.destroy(mesh);
    module.destroy(decoder);
    return { indices, attributes, vertexCount };
}

/** Appends bytes to the binary chunk at the 4-byte alignment glTF wants. */
class BinaryBuilder {
    private readonly parts: Buffer[] = [];
    private length = 0;

    public constructor(initial: Buffer) {
        this.parts.push(initial);
        this.length = initial.length;
    }

    public append(bytes: ArrayBufferView): number {
        const padding = (4 - (this.length % 4)) % 4;
        if (padding) {
            this.parts.push(Buffer.alloc(padding));
            this.length += padding;
        }
        const offset = this.length;
        const buffer = Buffer.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );
        this.parts.push(Buffer.from(buffer));
        this.length += buffer.length;
        return offset;
    }

    public build(): Buffer {
        return Buffer.concat(this.parts);
    }

    public get byteLength(): number {
        return this.length;
    }
}

/**
 * Replaces every Draco-compressed primitive with ordinary accessors.
 *
 * Returns the asset unchanged when it carries no compressed geometry.
 */
export async function decompressGeometry(
    bytes: Uint8Array,
    label: string,
): Promise<Uint8Array> {
    const glb = readGlb(bytes);
    if (!glb) return bytes;
    const used = Array.isArray(glb.json.extensionsUsed)
        ? (glb.json.extensionsUsed as string[])
        : [];
    if (used.includes(MESHOPT_EXTENSION)) {
        throw new Error(
            `${label} uses ${MESHOPT_EXTENSION}, which generation-time ` +
                "decoding does not implement yet.",
        );
    }
    if (!used.includes(DRACO_EXTENSION)) {
        return bytes;
    }

    const json = glb.json;
    const accessors = asRecords(json.accessors);
    const bufferViews = asRecords(json.bufferViews);
    const binary = new BinaryBuilder(glb.binary);

    const addAccessor = (
        data: Float32Array | Int32Array | Uint32Array,
        componentCount: number,
        componentType: number,
        count: number,
        existing?: JsonRecord,
    ): number => {
        const offset = binary.append(data);
        bufferViews.push({
            buffer: 0,
            byteOffset: offset,
            byteLength: data.byteLength,
        });
        const accessor = existing ?? {};
        accessor.bufferView = bufferViews.length - 1;
        accessor.byteOffset = 0;
        accessor.componentType = componentType;
        accessor.count = count;
        accessor.type = ACCESSOR_TYPES[componentCount] ?? "VEC3";
        // A Draco stream is never sparse and never normalized on output:
        // the decoder hands back plain float32 (or int32 joints).
        delete accessor.sparse;
        delete accessor.normalized;
        if (existing) {
            return accessors.indexOf(existing);
        }
        accessors.push(accessor);
        return accessors.length - 1;
    };

    let decodedPrimitives = 0;
    for (const mesh of asRecords(json.meshes)) {
        for (const primitive of asRecords(mesh.primitives)) {
            const extensions = asObject(primitive.extensions);
            const draco = asObject(extensions?.[DRACO_EXTENSION]);
            if (!extensions || !draco) continue;

            const view = bufferViews[numberValue(draco.bufferView)];
            if (!view) {
                throw new Error(
                    `${label}: ${DRACO_EXTENSION} references a missing bufferView.`,
                );
            }
            const start = numberValue(view.byteOffset);
            const compressed = glb.binary.subarray(
                start,
                start + numberValue(view.byteLength),
            );

            const attributeMap = (asObject(draco.attributes) ??
                {}) as Record<string, number>;
            const declared = (asObject(primitive.attributes) ??
                {}) as Record<string, number>;
            const componentCounts: Record<string, number> = {};
            for (const name of Object.keys(attributeMap)) {
                const accessor = accessors[declared[name] ?? -1];
                const type = accessor?.type;
                if (typeof type === "string") {
                    const size = Object.entries(ACCESSOR_TYPES).find(
                        ([, value]) => value === type,
                    )?.[0];
                    if (size) componentCounts[name] = Number(size);
                }
            }

            const decoded = await decodeDracoPrimitive(
                compressed,
                attributeMap,
                componentCounts,
            );

            for (const [name, data] of decoded.attributes) {
                if (declared[name] === undefined) {
                    // The Draco stream can carry an attribute the primitive
                    // never declares -- scene 30 ships a TANGENT that way.
                    // The pin decodes it (its component count falls back to
                    // three, since only declared attributes have a known
                    // type) and its loader prefers decoded attributes, so
                    // the browser shades with a three-float tangent in a
                    // slot the pipeline reads as four. Emitting that here
                    // makes the accessor genuinely malformed, so the
                    // undeclared attribute is dropped and the material
                    // takes the cotangent-frame path the primitive's own
                    // declaration implies.
                    continue;
                }
                if (data instanceof Int32Array) {
                    // Draco hands joints back as int32, which is not a
                    // component type glTF allows for JOINTS_n. Re-encoding
                    // to unsigned short is the obvious fix, but no reached
                    // asset needs it, so it fails here rather than shipping
                    // an untested conversion.
                    throw new Error(
                        `${label}: Draco '${name}' decodes to int32, which needs ` +
                            "an unsigned-short re-encode that no reached asset exercises.",
                    );
                }
                const componentCount = data.length / decoded.vertexCount;
                const existing = accessors[declared[name] ?? -1];
                const index = addAccessor(
                    data,
                    componentCount,
                    COMPONENT_FLOAT,
                    decoded.vertexCount,
                    existing,
                );
                declared[name] = index;
            }
            primitive.attributes = declared;
            primitive.indices = addAccessor(
                decoded.indices,
                1,
                COMPONENT_UNSIGNED_INT,
                decoded.indices.length,
                accessors[numberValue(primitive.indices, -1)],
            );

            delete extensions[DRACO_EXTENSION];
            if (Object.keys(extensions).length === 0) {
                delete primitive.extensions;
            }
            decodedPrimitives += 1;
        }
    }

    json.accessors = accessors;
    json.bufferViews = bufferViews;
    json.extensionsUsed = used.filter(
        (name) => name !== DRACO_EXTENSION,
    );
    if (Array.isArray(json.extensionsRequired)) {
        json.extensionsRequired = (
            json.extensionsRequired as string[]
        ).filter((name) => name !== DRACO_EXTENSION);
        if ((json.extensionsRequired as string[]).length === 0) {
            delete json.extensionsRequired;
        }
    }
    const built = binary.build();
    json.buffers = [{ byteLength: built.length }];
    console.log(
        `Decoded ${decodedPrimitives} Draco primitive(s) in ${label}.`,
    );
    return writeGlb(json, built);
}

