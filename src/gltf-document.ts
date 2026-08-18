/**
 * The one authority for reading a GLB's JSON chunk.
 *
 * Generation, the compose gate, the asset specializer and the CLI's codec
 * detection each grew their own copy of the same twenty lines, and the copies
 * differed only in how they fail. The readers live here side by side so each
 * divergence is a documented choice instead of an accident:
 *
 * - `glbDocument` is the tolerant form: anything that is not a well-formed GLB
 *   with parseable JSON is `undefined`, because its callers treat "not a glTF
 *   asset" as an ordinary answer, not an error.
 * - `parseGlbJson` is the throwing form the asset specializer runs on inputs
 *   it is about to compile, where a malformed GLB is an error worth naming. It
 *   alone verifies the first chunk's type and strips the NUL/space padding a
 *   writer may have added, because it alone reports parse failures instead of
 *   swallowing them.
 *
 * The module also owns the JSON-shaped helper family those readers' consumers
 * share, and `animatedMaterialPointerPatterns` — the pointer list generation
 * and the compose gate must agree on.
 *
 * What deliberately does NOT live here: `compressed-geometry.ts`'s chunk walk
 * (it rewrites GLBs and needs the binary chunk; it shares only the constants)
 * and `gltf-packager.ts`'s writer.
 */
import { readFileSync } from "node:fs";

export const GLB_MAGIC = 0x46546c67;
export const GLB_JSON_CHUNK = 0x4e4f534a;
export const GLB_BINARY_CHUNK = 0x004e4942;

/** A parsed JSON object — the shape every glTF document read shares. */
export type JsonObject = Record<string, unknown>;
/** The same type under the packagers' historical name. */
export type JsonRecord = JsonObject;

export const asObject = (value: unknown): JsonObject | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;

/**
 * The array's object entries, dropping everything else.
 *
 * `compressed-geometry.ts` keeps a cast-only variant on purpose: its chunk
 * rewriter trusts documents it just built, which is a different contract.
 */
export const asRecords = (value: unknown): JsonObject[] =>
    Array.isArray(value)
        ? value
            .map(asObject)
            .filter((entry): entry is JsonObject => entry !== undefined)
        : [];

/**
 * Any number. `asset-specializer.ts` keeps a deliberately stricter local
 * reading — a non-negative integer — for glTF index fields; that is a second
 * semantic, not a second copy of this one.
 */
export const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;

export const asNumbers = (value: unknown): number[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "number")
        ? (value as number[])
        : undefined;

export const asString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

export const asStrings = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

/**
 * The JSON chunk's raw text of a GLB buffer, or nothing when the buffer is
 * not a GLB or is too short to carry the declared chunk.
 *
 * Parsing is left to the caller because the callers disagree on it: the
 * tolerant readers swallow a parse failure, the CLI's codec detection lets it
 * throw.
 */
export function glbJsonText(bytes: Buffer): string | undefined {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) {
        return undefined;
    }
    const jsonLength = bytes.readUInt32LE(12);
    if (bytes.length < 20 + jsonLength) return undefined;
    return bytes.subarray(20, 20 + jsonLength).toString("utf8");
}

/** Reads a .glb's JSON chunk. Returns nothing for anything else. */
export function glbDocument(path: string): JsonObject | undefined {
    let bytes: Buffer;
    try {
        bytes = readFileSync(path);
    } catch {
        return undefined;
    }
    const text = glbJsonText(bytes);
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text) as JsonObject;
    } catch {
        return undefined;
    }
}

/**
 * The throwing form: the JSON chunk of a GLB the caller requires to be one.
 *
 * Beyond throwing where `glbDocument` returns `undefined`, this checks the
 * first chunk's type and trims trailing NUL/space padding — the extra care an
 * input error message has to be right about.
 */
export function parseGlbJson(path: string): JsonRecord {
    const bytes = readFileSync(path);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
        throw new Error(`${path} is not a GLB file.`);
    }
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== GLB_JSON_CHUNK) {
        throw new Error(`${path} has no JSON first chunk.`);
    }
    const text = new TextDecoder()
        .decode(bytes.subarray(20, 20 + jsonLength))
        .replace(/[\0 ]+$/g, "");
    const parsed: unknown = JSON.parse(text);
    const record = asObject(parsed);
    if (!record) throw new Error(`${path} GLB JSON root is not an object.`);
    return record;
}

/**
 * The material pointers whose animation changes the composed fragment, as
 * `gltfAnimatedMaterialPointers` suffix patterns.
 *
 * THE single authority: generation's `materialSubjects` builds every
 * composer input from this list, and the compose gate compares captures
 * against subjects built by that same function — so a pointer added here
 * reaches both at once, and a pointer added anywhere else is the exact bug
 * this constant exists to make impossible (the gate silently unsyncing from
 * generation).
 *
 * `emissive` carries two patterns because the pin funnels both the factor
 * and `KHR_materials_emissive_strength` into the same `_emissiveColor`
 * field, so either one animating needs the uniform lane.
 */
export const animatedMaterialPointerPatterns = {
    /** The factor becomes a UBO lane instead of a folded constant. */
    baseColorFactor: "pbrMetallicRoughness/baseColorFactor",
    /** Any texture slot's `KHR_texture_transform` offset, scale or rotation. */
    uvTransform: ".*/KHR_texture_transform/(?:offset|scale|rotation)",
    emissive: [
        "emissiveFactor",
        "extensions/KHR_materials_emissive_strength/emissiveStrength",
    ],
} as const;
