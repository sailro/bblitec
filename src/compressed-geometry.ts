// Compressed and quantized glTF geometry, resolved at generation time.
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
// `KHR_mesh_quantization` joins them for the same reason and by an easier
// route: its whole implementation is one pinned `preParse` hook over the
// document and its binary chunk, with no browser API in it, so generation
// runs the pin's own module rather than reimplementing the conversion.
//
// An asset that uses none of them is returned unchanged, so a pass cannot
// churn the assets that do not need it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import {
    GAUSSIAN_SPLATTING_EXTENSION,
    GAUSSIAN_SPLAT_DOCUMENT_KEY,
    isGaussianSplatPrimitive,
    GLB_BINARY_CHUNK as BINARY_CHUNK,
    GLB_JSON_CHUNK as JSON_CHUNK,
    GLB_MAGIC,
    asObject,
    type JsonRecord,
} from "./gltf-document.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import { readUpstreamPin } from "./upstream-source.js";

const DRACO_EXTENSION = "KHR_draco_mesh_compression";
const MESHOPT_EXTENSION = "EXT_meshopt_compression";
const QUANTIZATION_EXTENSION = "KHR_mesh_quantization";
// The pinned feature's own id. Sparse accessors are core glTF rather than an
// extension, so the registry triggers the module on a predicate over the
// accessors instead of on an `extensionsUsed` name.
const SPARSE_FEATURE_ID = "_sparse";

const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_SHORT = 5123;
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

/**
 * Drops one resolved extension from the document's own lists.
 *
 * A pass that rewrites the bytes the extension described leaves a document
 * that no longer needs it, and `extensionsRequired` naming it would make the
 * packaged asset declare a requirement its accessors no longer express. The
 * specializer reads both lists to decide what the pinned loader would do with
 * the asset it is handed.
 */
export function dropExtension(json: JsonRecord, name: string): void {
    json.extensionsUsed = declaredExtensions(json).filter(
        (declared) => declared !== name,
    );
    if (Array.isArray(json.extensionsRequired)) {
        const required = (json.extensionsRequired as string[]).filter(
            (declared) => declared !== name,
        );
        if (required.length === 0) {
            delete json.extensionsRequired;
        } else {
            json.extensionsRequired = required;
        }
    }
}

/** The extensions a document declares, as the two passes below read them. */
function declaredExtensions(json: JsonRecord): string[] {
    return Array.isArray(json.extensionsUsed)
        ? (json.extensionsUsed as string[])
        : [];
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

interface MeshoptDecoderModule {
    ready: Promise<void>;
    decodeGltfBuffer(
        target: Uint8Array,
        count: number,
        size: number,
        source: Uint8Array,
        mode: string,
        filter?: string,
    ): void;
}

let meshoptDecoder: Promise<MeshoptDecoderModule> | undefined;
let meshoptFeatureDecoder: Promise<void> | undefined;

/**
 * Instantiates the pin's meshoptimizer artifact without asking its browser
 * wrapper to inject a script.
 *
 * The pinned glTF feature remains the owner of the bufferView walk and every
 * decode call; this only supplies the exact global its lazy decoder module
 * would obtain from `/meshopt_decoder.js` in the reference page.
 */
async function loadPinnedMeshoptDecoder(): Promise<MeshoptDecoderModule> {
    if (!meshoptDecoder) {
        const loading = (async () => {
            const glue = await pinnedArtifact("meshopt_decoder.js");
            const sandbox: Record<string, unknown> = {
                console,
                WebAssembly,
                Blob,
                URL,
            };
            sandbox.self = sandbox;
            sandbox.globalThis = sandbox;
            createContext(sandbox);
            runInContext(glue.toString("utf8"), sandbox, {
                filename: "meshopt_decoder.js",
            });
            const decoder = sandbox.MeshoptDecoder as
                | MeshoptDecoderModule
                | undefined;
            if (!decoder || typeof decoder.decodeGltfBuffer !== "function") {
                throw new Error(
                    "The pinned meshopt_decoder.js did not define MeshoptDecoder.",
                );
            }
            await decoder.ready;
            return decoder;
        })();
        meshoptDecoder = loading;
        void loading.catch(() => {
            // Every concurrent caller shares `loading`. Only that rejected
            // generation may evict itself: a retry could already have
            // installed a newer promise by the time this reaction runs.
            if (meshoptDecoder === loading) {
                meshoptDecoder = undefined;
            }
        });
    }
    return meshoptDecoder;
}

/**
 * Primes the pin's lazy browser wrapper with the exact pinned decoder.
 *
 * `meshopt-decode.ts` captures the global only on its first call and caches the
 * resulting module. Keep the global override inside that one call, restore its
 * full descriptor even on failure, and share the whole critical section across
 * concurrent assets. Later feature calls use the wrapper's cached module and
 * never observe or mutate process-global state.
 */
async function preparePinnedMeshoptDecoder(): Promise<void> {
    if (!meshoptFeatureDecoder) {
        const loading = (async () => {
            const decoder = await loadPinnedMeshoptDecoder();
            const key = "MeshoptDecoder";
            const previous = Object.getOwnPropertyDescriptor(globalThis, key);
            if (previous && !previous.configurable) {
                throw new Error(
                    "Cannot install the pinned MeshoptDecoder over a " +
                        "non-configurable global.",
                );
            }
            Object.defineProperty(globalThis, key, {
                configurable: true,
                enumerable: previous?.enumerable ?? false,
                value: decoder,
                writable: true,
            });
            try {
                const module = await importPinnedModule<{
                    getMeshoptDecoder(): Promise<MeshoptDecoderModule>;
                }>("loader-gltf/meshopt-decode.js");
                const captured = await module.getMeshoptDecoder();
                if (captured !== decoder) {
                    throw new Error(
                        "The pinned meshopt loader had already captured a " +
                            "different decoder.",
                    );
                }
            } finally {
                if (previous) {
                    Object.defineProperty(globalThis, key, previous);
                } else {
                    delete (
                        globalThis as typeof globalThis & {
                            MeshoptDecoder?: MeshoptDecoderModule;
                        }
                    ).MeshoptDecoder;
                }
            }
        })();
        meshoptFeatureDecoder = loading;
        void loading.catch(() => {
            // As above, keep successful work shared but let a failed prime be
            // retried. The identity guard prevents an old rejection from
            // clearing a newer in-flight retry.
            if (meshoptFeatureDecoder === loading) {
                meshoptFeatureDecoder = undefined;
            }
        });
    }
    await meshoptFeatureDecoder;
}

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

/** The parsed chunk as the `DataView` every pinned document hook takes. */
function binaryChunkView(glb: GlbChunks): DataView {
    return new DataView(
        glb.binary.buffer,
        glb.binary.byteOffset,
        glb.binary.byteLength,
    );
}

/** Appends bytes to the binary chunk at the 4-byte alignment glTF wants. */
class BinaryBuilder {
    private readonly parts: Buffer[] = [];
    private length = 0;

    public constructor(initial: Buffer) {
        this.parts.push(initial);
        this.length = initial.length;
    }

    /**
     * The bytes are held as a view rather than copied: every caller appends
     * a buffer it has just produced and does not touch again, and one of
     * them is an 11 MB splat row buffer.
     */
    public append(bytes: ArrayBufferView): number {
        const padding = (4 - (this.length % 4)) % 4;
        if (padding) {
            this.parts.push(Buffer.alloc(padding));
            this.length += padding;
        }
        const offset = this.length;
        this.parts.push(
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        this.length += bytes.byteLength;
        return offset;
    }

    public build(): Buffer {
        return Buffer.concat(this.parts);
    }

    public get byteLength(): number {
        return this.length;
    }
}

/** Appends one tightly-packed view over freshly appended bytes. */
function appendBufferView(
    bufferViews: JsonRecord[],
    binary: BinaryBuilder,
    bytes: ArrayBufferView,
): number {
    bufferViews.push({
        buffer: 0,
        byteOffset: binary.append(bytes),
        byteLength: bytes.byteLength,
    });
    return bufferViews.length - 1;
}

/**
 * Packs Draco's signed 32-bit joint output into a glTF-valid joint accessor.
 *
 * Draco exposes integer attributes through one int32 decoder path, while
 * glTF permits JOINTS_n to use only unsigned byte or unsigned short. Keep the
 * decoded values exact and refuse instead of wrapping if an asset exceeds the
 * wider legal representation.
 */
export function encodeUnsignedShortJoints(
    data: Int32Array,
    label: string,
    name: string,
): Uint16Array {
    const encoded = new Uint16Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
        const value = data[index]!;
        if (value < 0 || value > 0xffff) {
            throw new Error(
                `${label}: Draco '${name}' joint ${value} is outside the ` +
                    "unsigned-short range.",
            );
        }
        encoded[index] = value;
    }
    return encoded;
}

/** Replaces every Draco-compressed primitive in a parsed GLB in place. */
async function decodeDracoGlb(
    glb: GlbChunks,
    label: string,
): Promise<boolean> {
    const used = declaredExtensions(glb.json);
    if (!used.includes(DRACO_EXTENSION)) {
        return false;
    }

    const json = glb.json;
    const accessors = asRecords(json.accessors);
    const bufferViews = asRecords(json.bufferViews);
    const binary = new BinaryBuilder(glb.binary);

    const addAccessor = (
        data: Float32Array | Uint16Array | Uint32Array,
        componentCount: number,
        componentType: number,
        count: number,
        existing?: JsonRecord,
    ): number => {
        const view = appendBufferView(bufferViews, binary, data);
        const accessor = existing ?? {};
        accessor.bufferView = view;
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
                    const componentCount =
                        data.length / decoded.vertexCount;
                    const existing = accessors[declared[name] ?? -1];
                    const index = addAccessor(
                        encodeUnsignedShortJoints(data, label, name),
                        componentCount,
                        COMPONENT_UNSIGNED_SHORT,
                        decoded.vertexCount,
                        existing,
                    );
                    declared[name] = index;
                    continue;
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
    dropExtension(json, DRACO_EXTENSION);
    const built = binary.build();
    glb.binary = built;
    json.buffers = [{ byteLength: built.length }];
    console.log(
        `Decoded ${decodedPrimitives} Draco primitive(s) in ${label}.`,
    );
    return true;
}

/**

/**
 * A pinned `preParse` hook, run over one packaged asset.
 *
 * Three geometry passes are exactly this shape: a document-level
 * hook that rewrites accessors into freshly appended tightly-packed
 * bufferViews and hands back the new binary chunk. Each is a pure function of
 * the asset's own bytes with no browser API in it, which is what makes
 * running the pin's own module here the same answer the browser computes
 * rather than a second implementation of it — and each is imported upstream
 * only behind its own trigger, which is the boundary `trigger` keeps.
 */
interface PinnedPreParseFeature {
    default: {
        id: string;
        preParse?: (
            json: JsonRecord,
            binChunk: DataView,
        ) => Promise<DataView | undefined>;
    };
}

interface PinnedPreParsePass {
    /** The pinned module, under `loader-gltf/`. */
    module: string;
    /** The `id` its default export must still declare. */
    id: string;
    /** Upstream's own trigger for importing it. */
    trigger: (json: JsonRecord) => boolean;
    /** What the console line says the pass did. */
    verb: string;
    /** What a run that rewrote nothing means, for the refusal message. */
    shape: string;
    /** Applied to the document after the hook, before it is written. */
    after?: (json: JsonRecord) => void;
    /** Installs a browser-owned dependency before the pin's hook runs. */
    prepare?: () => Promise<void>;
}

const preParseFeatures = new Map<
    string,
    Promise<PinnedPreParseFeature["default"]>
>();

async function loadPreParseFeature(
    pass: PinnedPreParsePass,
): Promise<PinnedPreParseFeature["default"]> {
    let loading = preParseFeatures.get(pass.module);
    if (!loading) {
        loading = (async () => {
            const module = await importPinnedModule<PinnedPreParseFeature>(
                pass.module,
            );
            const feature = module.default;
            if (feature?.id !== pass.id || !feature.preParse) {
                throw new Error(
                    `Pinned ${pass.module} no longer exports a default ` +
                        `${pass.id} feature with a preParse hook.`,
                );
            }
            return feature;
        })();
        preParseFeatures.set(pass.module, loading);
    }
    return loading;
}

/**
 * Runs one pinned `preParse` hook over a parsed GLB, in place.
 *
 * Returns whether it ran. The caller keeps the parsed chunks across passes,
 * so an asset is read and written once however many hooks it triggers.
 */
async function runPinnedPreParse(
    pass: PinnedPreParsePass,
    glb: GlbChunks,
    label: string,
): Promise<boolean> {
    if (!pass.trigger(glb.json)) return false;
    await pass.prepare?.();
    const feature = await loadPreParseFeature(pass);
    const rewritten = await feature.preParse?.(
        glb.json,
        binaryChunkView(glb),
    );
    if (!rewritten) {
        throw new Error(
            `${label} ${pass.shape}, but the pinned ${pass.id} feature ` +
                "rewrote nothing, which means the asset carries a shape " +
                "neither side would resolve.",
        );
    }
    glb.binary = Buffer.from(
        rewritten.buffer,
        rewritten.byteOffset,
        rewritten.byteLength,
    );
    glb.json.buffers = [{ byteLength: glb.binary.length }];
    pass.after?.(glb.json);
    console.log(`${pass.verb} ${label} through the pinned feature.`);
    return true;
}

/**
 * Meshopt is the first feature in the pin's registry. Its hook materializes
 * every compressed bufferView and returns one ordinary binary chunk, after
 * which neither the document nor the native loader needs the extension.
 */
const meshoptPreParsePass: PinnedPreParsePass = {
    module: "loader-gltf/gltf-feature-meshopt.js",
    id: MESHOPT_EXTENSION,
    trigger: (json) =>
        declaredExtensions(json).includes(MESHOPT_EXTENSION),
    verb: "Decompressed",
    shape: `declares ${MESHOPT_EXTENSION}`,
    prepare: preparePinnedMeshoptDecoder,
    after: (json) => dropExtension(json, MESHOPT_EXTENSION),
};

/** The registry's own trigger for the sparse feature. */
function hasSparseAccessor(json: JsonRecord): boolean {
    return asRecords(json.accessors).some(
        (accessor) => accessor.sparse !== undefined,
    );
}

/**
 * The document-level passes, in the pinned registry's own order.
 *
 * Sparse accessors are core glTF rather than an extension, so the registry
 * triggers their module on a predicate over the accessors; quantization
 * triggers on its `extensionsUsed` name and drops it once resolved. Both
 * append tightly-packed bufferViews and clear what they resolved, so the
 * loader that ships sees an ordinary document either way.
 */
const pinnedPreParsePasses: readonly PinnedPreParsePass[] = [
    meshoptPreParsePass,
    {
        module: "loader-gltf/gltf-feature-sparse.js",
        id: SPARSE_FEATURE_ID,
        trigger: hasSparseAccessor,
        verb: "Materialized",
        shape: "carries a sparse accessor",
    },
    {
        module: "loader-gltf/gltf-ext-quantization.js",
        id: QUANTIZATION_EXTENSION,
        trigger: (json) =>
            declaredExtensions(json).includes(QUANTIZATION_EXTENSION),
        verb: "Dequantized",
        shape: `declares ${QUANTIZATION_EXTENSION}`,
        after: (json) => dropExtension(json, QUANTIZATION_EXTENSION),
    },
];

/**
 * The Draco hook runs at the pin's pre-mesh boundary, after every `preParse`
 * — so upstream's own GS conversion reads accessors Draco has not touched
 * yet. A GS primitive carrying compressed attributes is therefore a shape
 * neither side resolves, and it is named here rather than converted from
 * whatever the compressed bufferView happens to hold.
 */
function refuseDracoGaussianSplats(json: JsonRecord, label: string): void {
    for (const mesh of asRecords(json.meshes)) {
        for (const primitive of asRecords(mesh.primitives)) {
            const extensions = asObject(primitive.extensions);
            if (
                isGaussianSplatPrimitive(primitive) &&
                extensions?.[DRACO_EXTENSION] !== undefined
            ) {
                throw new Error(
                    `${label}: a ${GAUSSIAN_SPLATTING_EXTENSION} primitive ` +
                        `also declares ${DRACO_EXTENSION}; the pinned splat ` +
                        "conversion reads its attributes before any Draco " +
                        "decode, so neither side resolves that pairing.",
                );
            }
        }
    }
}

/**
 * `KHR_gaussian_splatting`, resolved at generation like the three passes
 * above and for the same reason: its whole implementation is a `preParse`
 * plus an `applyAsset` over the document and its binary chunk, with no
 * browser API in either, so generation runs the pin's own module rather than
 * reimplementing the conversion.
 *
 * What changes is the shape of the answer. The other passes rewrite accessors
 * and hand back a new chunk; this one *consumes* primitives — a GS primitive
 * is POINTS-mode geometry the core mesh pipeline has no topology for — and
 * produces the pin's own 32-byte-per-splat row buffer, which is exactly what
 * a `.ply`/`.splat` asset packages to. So the rows are appended as an
 * ordinary tightly-packed bufferView, named on the document under
 * `GAUSSIAN_SPLAT_DOCUMENT_KEY`, and the extension is dropped.
 *
 * Consuming rather than rewriting is also what makes the source attributes
 * droppable: an asset whose ONLY primitives were GS ones leaves a document
 * that reaches its binary chunk through nothing at all, so the rows become
 * the whole chunk. That is a two-thirds saving on the reached asset (20.7 MB
 * of ellipsoid attributes against 11.0 MB of rows), and it is taken only
 * where it is provable — anything the document could still read the chunk
 * through keeps the append-only form, which is correct at any size.
 */
async function convertGaussianSplats(
    glb: GlbChunks,
    label: string,
): Promise<boolean> {
    if (
        !declaredExtensions(glb.json).includes(GAUSSIAN_SPLATTING_EXTENSION)
    ) {
        return false;
    }
    refuseDracoGaussianSplats(glb.json, label);
    const { extractGltfGaussianSplats } = await import(
        "./splat-packager.js"
    );
    const splats = await extractGltfGaussianSplats(
        glb.json,
        binaryChunkView(glb),
        label,
    );
    dropExtension(glb.json, GAUSSIAN_SPLATTING_EXTENSION);
    if (splats.length === 0) {
        // A document declaring the extension with no GS primitive in it: the
        // pin converts nothing and neither does this, so the chunk is left as
        // it was.
        console.log(`No Gaussian-splat primitive in ${label}.`);
        return true;
    }
    const reachable = readsBinaryChunk(glb.json);
    if (!reachable) {
        // Nothing left names an accessor, so nothing names a bufferView:
        // both arrays go with the bytes they described, which is what keeps
        // the document consistent rather than leaving indices into a chunk
        // that no longer holds them.
        glb.json.accessors = [];
    }
    const bufferViews = reachable ? asRecords(glb.json.bufferViews) : [];
    const binary = new BinaryBuilder(
        reachable ? glb.binary : Buffer.alloc(0),
    );
    glb.json[GAUSSIAN_SPLAT_DOCUMENT_KEY] = splats.map((splat) => ({
        name: splat.name,
        bufferView: appendBufferView(bufferViews, binary, splat.rows),
        rotation: [...splat.rotation],
    }));
    glb.json.bufferViews = bufferViews;
    glb.binary = binary.build();
    glb.json.buffers = [{ byteLength: glb.binary.length }];
    console.log(
        `Converted ${splats.length} Gaussian-splat primitive(s) in ` +
            `${label} through the pinned feature.`,
    );
    return true;
}

/**
 * Whether anything the document still declares can read its binary chunk.
 *
 * Only the four members that name a bufferView are asked, and each is asked
 * for PRESENCE rather than for which view it names: the question this
 * answers is "may the existing views be discarded", so an unmodelled
 * reference has to read as yes. A document that answers no reaches its chunk
 * through nothing, which is what the GS pass leaves behind when the
 * primitives it consumed were the whole file.
 */
function readsBinaryChunk(json: JsonRecord): boolean {
    return (
        asRecords(json.meshes).some(
            (mesh) => asRecords(mesh.primitives).length > 0,
        ) ||
        asRecords(json.images).length > 0 ||
        asRecords(json.skins).length > 0 ||
        asRecords(json.animations).length > 0 ||
        // Every extension resolved by this module is dropped once it is, so a
        // remaining one is a reader this pass does not model.
        declaredExtensions(json).length > 0
    );
}

/**
 * Every geometry extension this port resolves at generation, in the pin's
 * own order.
 *
 * The order is a contract rather than a convenience, and it is the order
 * `gltf-feature-registry.ts` lists the hooks in: meshopt decompresses
 * bufferViews first, then sparse accessors are materialized so their base can
 * read decompressed data, then `KHR_mesh_quantization` dequantizes what that
 * leaves -- a meshopt-filtered animation output is itself quantized data the
 * last hook has to see. Expressing it here rather than at each call site is
 * what keeps a caller from getting it backwards -- which would produce a
 * plausible wrong mesh rather than an error.
 *
 * The three document-level hooks share one parse, then the Gaussian-splat
 * conversion consumes what it owns and Draco runs at the pin's pre-mesh
 * boundary: an asset is read and written once however many features it
 * triggers, and one that triggers none is returned byte-for-byte.
 *
 * Gaussian splatting sits between them because that is where the pin puts it:
 * its `preParse` strips the GS primitives with the other pre-parse hooks,
 * before Draco's pre-mesh decode ever sees a primitive, and it reads
 * accessors the quantization hook may just have rewritten.
 */
export async function resolveGeometryExtensions(
    bytes: Uint8Array,
    label: string,
): Promise<Uint8Array> {
    const glb = readGlb(bytes);
    if (!glb) return bytes;
    let rewrote = false;
    for (const pass of pinnedPreParsePasses) {
        rewrote = (await runPinnedPreParse(pass, glb, label)) || rewrote;
    }
    rewrote = (await convertGaussianSplats(glb, label)) || rewrote;
    rewrote = (await decodeDracoGlb(glb, label)) || rewrote;
    return rewrote ? writeGlb(glb.json, glb.binary) : bytes;
}
