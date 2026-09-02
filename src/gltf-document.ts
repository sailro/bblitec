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

/**
 * `KHR_gaussian_splatting`, and where packaging names what it resolved the
 * extension into.
 *
 * The conversion runs at generation (`compressed-geometry.ts` over the pin's
 * own hooks), so a packaged document carries the pin's 32-byte splat rows as
 * an ordinary bufferView under this key and no longer declares the
 * extension. Both facts are spelled here because the packager writes them,
 * the specializer refuses a survivor by them, and the generated loader reads
 * them.
 */
export const GAUSSIAN_SPLATTING_EXTENSION = "KHR_gaussian_splatting";
export const GAUSSIAN_SPLAT_DOCUMENT_KEY = "__bblitecGaussianSplats";

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

/** Every primitive in the document, flattened out of its meshes. */
export const primitiveRecords = (document: JsonRecord): JsonRecord[] =>
    asRecords(document.meshes).flatMap((mesh) =>
        asRecords(mesh.primitives),
    );

/**
 * Whether one primitive is a Gaussian-splat primitive, by the pin's own
 * test.
 *
 * `isGsPrimitive` accepts EITHER the extension object on the primitive or
 * any attribute namespaced under the extension -- a document that takes
 * only the second form is still one the pinned conversion reads, and a
 * check that looked at `extensions` alone would let it past.
 */
export const isGaussianSplatPrimitive = (
    primitive: JsonObject,
): boolean => {
    if (
        asObject(primitive.extensions)?.[GAUSSIAN_SPLATTING_EXTENSION] !==
        undefined
    ) {
        return true;
    }
    const attributes = asObject(primitive.attributes);
    return (
        attributes !== undefined &&
        Object.keys(attributes).some((key) =>
            key.startsWith(`${GAUSSIAN_SPLATTING_EXTENSION}:`),
        )
    );
};

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

/**
 * A glTF index field: a non-negative integer. Stricter than `asNumber` on
 * purpose — every field read through this names a position in a document
 * array, and a fractional or negative one is malformed rather than absent.
 */
export const asIndex = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
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

/**
 * The `KHR_materials_variants` names a document declares, in the index order
 * its primitives' `mappings` refer to.
 */
export function gltfVariantNames(document: JsonRecord): string[] {
    return asRecords(
        asObject(asObject(document.extensions)?.["KHR_materials_variants"])
            ?.variants,
    ).map((variant) => asString(variant.name) ?? "");
}

/**
 * The index a scene's `selectVariant` name resolves to, or undefined when the
 * scene selected nothing. A name the document does not declare throws here,
 * once, rather than degrading to "no selection" in one consumer and refusing
 * in another.
 */
export function selectedVariantIndex(
    document: JsonRecord,
    selectedVariantName: string | undefined,
    assetName: string,
): number | undefined {
    if (selectedVariantName === undefined) return undefined;
    const names = gltfVariantNames(document);
    const index = names.indexOf(selectedVariantName);
    if (index < 0) {
        throw new Error(
            `${assetName}: selectVariant names '${selectedVariantName}', ` +
                `which the asset does not declare (${
                    names.join(", ") || "no variants"
                }).`,
        );
    }
    return index;
}

/**
 * The material a primitive draws with once a variant is selected, which is the
 * pin's `loadVariantMaterials` mapping walk and `selectVariant`'s
 * reassignment composed: `selectVariant` restores every original and then
 * assigns every entry the chosen variant maps, in order, so the last mapping
 * naming that variant wins and a primitive it does not map keeps
 * `primitive.material`. With no selection nothing is reassigned at all,
 * which is why an asset carrying the extension renders identically to one
 * without it until a scene selects.
 */
export function variantMaterialIndex(
    primitive: JsonRecord,
    selectedVariant: number | undefined,
): number | undefined {
    const own = asIndex(primitive.material);
    if (selectedVariant === undefined) return own;
    let mapped = own;
    for (
        const mapping of asRecords(
            asObject(asObject(primitive.extensions)?.[
                "KHR_materials_variants"
            ])?.mappings,
        )
    ) {
        const variants = Array.isArray(mapping.variants)
            ? mapping.variants
            : [];
        if (variants.some((index) => asIndex(index) === selectedVariant)) {
            mapped = asIndex(mapping.material) ?? mapped;
        }
    }
    return mapped;
}
