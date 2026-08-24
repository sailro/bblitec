import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    captureBuffersPath,
    captureDrawsPath,
    captureShadersDirectory,
    captureTextureUploadsPath,
} from "./parity-scene.js";
import {
    fieldOffsets,
    lastWriteBytes,
    layoutOf,
    parseWgslStructs,
    storageUsage,
    storageValueCap,
    uniformUsage,
    type WgslStruct,
} from "./capture-uniforms.js";

/**
 * Pairing the browser's instrumented capture with the native one.
 *
 * Two captures describe the same frame from opposite sides: `scene --
 * capture` records what Babylon Lite uploaded to WebGPU, and `scene --
 * capture <id> --native` records what our renderer computed for the same
 * pose. Both are complete, and neither answers anything on its own — the
 * finding is always in the difference, and reading two directories of
 * JSON by hand is what makes a residual take an afternoon.
 *
 * The two sides do not share a layout, and cannot: the pinned engine
 * uploads a scene block, a material block and a mesh block per draw,
 * while our generated renderer builds one flat struct per material kind.
 * So blocks are not paired by size or by offset. Values are: every float
 * tuple the browser uploaded is indexed, and each native field is looked
 * up in it. "Did Babylon Lite compute this number anywhere?" is the
 * question that survives the layout difference, and a native value that
 * appears nowhere on the browser side is the finding worth reading.
 *
 * The same pairing covers the capture's pinned material and mesh blocks
 * (rung 4b's two listings, diffed instead of read), and the shader half
 * gets its own comparison: the browser's composed modules hashed against
 * the generated arms, matched and one-sided sets named, and the closest
 * near miss opened at its first divergent line.
 */

export interface UniformField {
    /** `PbrUniforms.emissive_factor`, or `buffer#18 vEmissiveColor`. */
    name: string;
    values: number[];
}

/**
 * How a native field lines up with the browser's uploads.
 *
 * `vec3` is not a weaker `exact`: the two sides pack their spare lane
 * differently on purpose — our generated `camera_position` carries the
 * far plane in `w` where the pin's `vEyePosition` carries zero, and our
 * light slots carry range and type there. Three agreeing leading lanes
 * across two independently computed pipelines is the same evidence a
 * four-lane match is, so treating it as a difference would bury the real
 * ones under every light and camera field in the scene.
 */
export interface FieldCorrespondence {
    native: string;
    values: number[];
    match: "exact" | "vec3" | "divergent";
    browser?: string;
    browserValues?: number[];
    maxDelta?: number;
}

export interface DrawShapeReport {
    /** `indexCount x instanceCount`, present on both sides. */
    shared: string[];
    onlyInNative: string[];
    onlyInBrowser: string[];
    /** Non-indexed browser draws, which have no native counterpart to
     *  compare against (full-screen passes, blits). Context, not a diff. */
    browserNonIndexed: string[];
}

/** Per-block correspondence tally for one pinned block's vec4 rows. */
export interface PinnedBlockRowTally {
    exact: number;
    vec3: number;
    divergent: number;
}

/**
 * How the browser's composed shader modules line up with the generated
 * arms, by normalized content rather than by name — the two sides share
 * no file naming, and hashing is what the manual recipe did by hand.
 */
export interface ShaderArmReport {
    /** Same normalized content on both sides; each group names every
     *  file that carries it (a variant and its deployed twin share one). */
    matched: Array<{ browser: string[]; native: string[] }>;
    browserOnly: string[];
    nativeOnly: string[];
    /** The browser-only modules that are PBR fragments — the
     *  compose-class finding. Derived beside the near-miss preference
     *  that already needs it; `buildRenderDiff` ranks its findings by it
     *  and keeps it out of the serialized report. Optional so hand-built
     *  report fixtures stay expressible. */
    pbrOrphans?: string[];
    /** The closest one-sided pair by longest common line prefix, with
     *  the first divergent line — the line that names the arm. */
    nearMiss?: {
        browser: string;
        native: string;
        /** 1-based line where the pair stops agreeing. */
        line: number;
        browserLines: string[];
        nativeLines: string[];
    };
}

/** One native bone-palette matrix looked up among the browser's float
 *  texture uploads, mirror map applied. */
export interface PaletteCorrespondence {
    native: string;
    match: "exact" | "divergent";
    browser?: string;
    maxDelta?: number;
}

/**
 * The capture's `tex-uploads.json`, matched against the native side's
 * texture content expectations. Babylon Lite uploads each skin's bone
 * matrices as an Nx1 rgba32float texture — four texels per matrix — and
 * the instrumented capture keeps those texels' raw bytes; the native
 * capture carries the same matrices CPU-side in its `pinnedMeshBlocks`,
 * stored under the native mirror convention. Each native matrix is
 * pushed through the documented mirror map and looked up among the
 * uploaded ones, so the skinning comparison is a verdict rather than a
 * by-eye hexfloat diff with a sign-flip caveat.
 */
export interface TexturePaletteReport {
    floatUploads: Array<{
        tex: number;
        format: string;
        matrices: number;
        byteLength: number;
        /** Bytes above the capture's cap are recorded as size only. */
        truncated: boolean;
    }>;
    palettes: PaletteCorrespondence[];
    /** Census of the rest of the upload record, for context. */
    colorUploads: number;
    externalImages: number;
}

export interface RenderDiffReport {
    scene: string;
    backend: string;
    /** Differences that can explain everything below them, first. */
    findings: string[];
    summary: {
        nativeDraws: number;
        nativeMeshes: number;
        nativeMaterials: number;
        nativeLights: number;
        nativeFields: number;
        browserFields: number;
        exact: number;
        vec3: number;
        divergent: number;
    };
    draws: DrawShapeReport;
    /** Native fields no browser upload carries, worst first. */
    divergent: FieldCorrespondence[];
    /** Browser fields no native block carries. */
    browserOnly: UniformField[];
    /**
     * The capture's pinned material and mesh blocks, paired against the
     * browser's uploads through the same value matching as every other
     * native field (their rows are named `pinned ...` in the lists
     * above). A material block flagged `refused` belongs to no PBR draw
     * this frame — the draw gate refused the variant or nothing draws
     * the material at this pose — so its values never reached the GPU.
     */
    pinned?: {
        materialBlocks: Array<{
            materialIndex: number;
            variant: number;
            key: string;
            bytes: number;
            refused: boolean;
            rows: PinnedBlockRowTally;
        }>;
        meshBlocks: Array<{
            meshIndex: number;
            lightCount: number;
            boneCount: number;
            rows: PinnedBlockRowTally;
        }>;
    };
    /** Absent when the capture predates `tex-uploads.json`. */
    texturePalettes?: TexturePaletteReport;
    shaders: {
        browserModules: string[];
        nativeShaders: string[];
        arms: ShaderArmReport;
        browserSampleCalls: string[];
        nativeSampleCalls: string[];
    };
}

// ---------------------------------------------------------------------------
// Native side
// ---------------------------------------------------------------------------

export interface NativeUniformBlock {
    stage: string;
    slot: number;
    type: string;
    floats: number[];
}

export interface NativeDraw {
    stage: string;
    pipeline: string;
    materialKind: string;
    bucket: string;
    mesh: number | null;
    material: number | null;
    geometry: number | null;
    indexCount?: number;
    instanceCount?: number;
    uniforms: NativeUniformBlock[];
}

/**
 * One `pinnedMaterialBlocks` entry: the bytes `write_pbr_variant_material`
 * fills for a (material, variant) pair the selector table names, built
 * CPU-side by `pal_render_capture.hpp` whether or not a draw carries it.
 */
export interface PinnedMaterialBlock {
    materialIndex: number;
    variant: number;
    key: string;
    bytes: number;
    values: number[];
}

/** One `pinnedMeshBlocks` entry: the pin's per-draw mesh block plus the
 *  mesh's first bone palette entries, dumped per PBR draw. */
export interface PinnedMeshBlock {
    meshIndex: number;
    world?: number[];
    lightCount?: number;
    boneCount?: number;
    bone0?: number[];
    bone1?: number[];
}

export interface NativeCapture {
    backend: string;
    buildStamp: string;
    viewport: { width: number; height: number };
    draws: NativeDraw[];
    backgroundUniforms: NativeUniformBlock[];
    meshes?: unknown[];
    materials?: unknown[];
    lights?: unknown[];
    pinnedMaterialBlocks?: PinnedMaterialBlock[];
    pinnedMeshBlocks?: PinnedMeshBlock[];
}

export function readNativeCapture(path: string): NativeCapture {
    if (!existsSync(path)) {
        throw new Error(
            `No native capture at ${path}. Run 'scene -- capture <id> --native' first.`,
        );
    }
    return JSON.parse(readFileSync(path, "utf8")) as NativeCapture;
}

/**
 * Field names for a generated uniform struct, read from the scene's own
 * generated header.
 *
 * The native capture dumps a block's bytes as floats and names the
 * struct they came from, but not its fields: those are generated per
 * scene — a scene with four lights declares four light slots — so the
 * authority on them is the header that was compiled, not a table here
 * that would drift from it.
 *
 * Every member of these structs is four-byte lanes all the way down —
 * `std::array<float, N>`, arrays of those, and in the pinned uniform
 * mirrors (`standard_variants.hpp`, `pbr_variants.hpp`) brace-initialized
 * `float`/`std::uint32_t` scalars, `std::uint32_t` row vectors and
 * explicit byte padding — which is why a flat float view lines up with
 * the upload at all. A u32 lane holds its bits, and the flat float view
 * carries them bit-identically on both sides, so a matched u32 still
 * pairs. A member this does not recognize abandons the struct rather
 * than being skipped, because a skipped member shifts every field after
 * it and would rename values silently.
 */
export function parseCppUniformStructs(
    source: string,
): Map<string, Array<{ name: string; floats: number }>> {
    const structs = new Map<string, Array<{ name: string; floats: number }>>();
    const pattern = /struct\s+(\w+)\s*\{([\s\S]*?)\n\};/g;
    for (const match of source.matchAll(pattern)) {
        const fields: Array<{ name: string; floats: number }> = [];
        let usable = true;
        for (const line of match[2]!.split("\n")) {
            const text = line.trim();
            if (text === "" || text.startsWith("//")) continue;
            const nested =
                /^std::array<std::array<(?:float|std::uint32_t),\s*(\d+)>,\s*(\d+)>\s+(\w+)/.exec(
                    text,
                );
            if (nested) {
                // Reported as one field per row: an array of vec4 slots is
                // nine separate harmonics, and comparing them as one
                // thirty-six-float tuple would never match anything. The
                // pinned mesh block's `array<vec4<u32>>` light indexes ride
                // the same per-row reading.
                for (
                    let element = 0;
                    element < Number(nested[2]);
                    element += 1
                ) {
                    fields.push({
                        name: `${nested[3]!}[${element}]`,
                        floats: Number(nested[1]),
                    });
                }
                continue;
            }
            const array = /^std::array<float,\s*(\d+)>\s+(\w+)/.exec(text);
            if (array) {
                fields.push({ name: array[2]!, floats: Number(array[1]) });
                continue;
            }
            // The pinned mirrors spell WGSL alignment padding as explicit
            // byte arrays; four bytes make one lane, and a width that is
            // not whole lanes would shift every later field, so it
            // abandons the struct instead.
            const padding =
                /^std::array<std::uint8_t,\s*(\d+)>\s+(\w+)/.exec(text);
            if (padding) {
                const bytes = Number(padding[1]);
                if (bytes % 4 !== 0) {
                    usable = false;
                    break;
                }
                fields.push({ name: padding[2]!, floats: bytes / 4 });
                continue;
            }
            // Scalars: `float x = 0;`, `float x;`, and the pinned mirrors'
            // brace-initialized `float x{};` / `std::uint32_t x{};`.
            const scalar =
                /^(?:float|std::uint32_t)\s+(\w+)\s*[={;]/.exec(text);
            if (scalar) {
                fields.push({ name: scalar[1]!, floats: 1 });
                continue;
            }
            usable = false;
            break;
        }
        if (usable && fields.length > 0) structs.set(match[1]!, fields);
    }
    return structs;
}

export function nativeFields(
    block: NativeUniformBlock,
    layouts: Map<string, Array<{ name: string; floats: number }>>,
): UniformField[] {
    const layout = layouts.get(block.type);
    const fields: UniformField[] = [];
    if (!layout) {
        for (let index = 0; index < block.floats.length; index += 4) {
            fields.push({
                name: `${block.type}[${index}]`,
                values: block.floats.slice(index, index + 4),
            });
        }
        return fields;
    }
    let offset = 0;
    for (const field of layout) {
        fields.push({
            name: `${block.type}.${field.name}`,
            values: block.floats.slice(offset, offset + field.floats),
        });
        offset += field.floats;
    }
    // A layout that does not cover the block means the header and the
    // capture disagree; report the tail rather than dropping it.
    if (offset < block.floats.length) {
        fields.push({
            name: `${block.type}.<unmapped at ${offset}>`,
            values: block.floats.slice(offset),
        });
    }
    return fields;
}

/** `values` as the vec4 rows the uniform upload is made of, one field per
 *  row so `correspond` can pair each independently. */
function vec4Chunks(
    prefix: string,
    values: number[],
    suffix: string,
): UniformField[] {
    const fields: UniformField[] = [];
    for (let offset = 0; offset < values.length; offset += 4) {
        const end = Math.min(offset + 3, values.length - 1);
        fields.push({
            name: `${prefix}[${offset}..${end}]${suffix}`,
            values: values.slice(offset, offset + 4),
        });
    }
    return fields;
}

/**
 * The pinned material and mesh blocks, decoded into the same field shape
 * everything else pairs through.
 *
 * The capture builds these through the draw path's own writers
 * (`write_pbr_variant_material`, `pinned_mesh_block`) for every selector
 * row, CPU-side — variants the draw gate refuses included — and until now
 * rung 4b was a human diffing that listing against `scene -- uniforms` by
 * eye. Field names carry the block's identity plus a vec4 chunk range
 * rather than per-field names: `correspond` matches by value, so
 * `variant<n>:<key> values[i..j]` is sufficient and honest, and the
 * variant's own field layout stays where it lives, in the generated
 * `pbr-variants/variants.json`.
 *
 * A material block whose material no PBR draw in the capture carries is
 * flagged `(refused)`: the draw gate refused the variant or nothing draws
 * the material at this pose, so its values never reached the GPU and a
 * divergence there cannot explain a pixel.
 */
export function pinnedBlockFields(capture: NativeCapture): {
    material: Array<{
        block: PinnedMaterialBlock;
        refused: boolean;
        fields: UniformField[];
    }>;
    mesh: Array<{ block: PinnedMeshBlock; fields: UniformField[] }>;
} {
    const drawnPbrMaterials = new Set<number>();
    for (const draw of capture.draws ?? []) {
        if (draw.materialKind === "pbr" && typeof draw.material === "number") {
            drawnPbrMaterials.add(draw.material);
        }
    }
    const material = (capture.pinnedMaterialBlocks ?? []).map((block) => {
        const refused = !drawnPbrMaterials.has(block.materialIndex);
        const identity =
            `pinned material[${block.materialIndex}] variant${block.variant}` +
            (block.key ? `:${block.key}` : "");
        return {
            block,
            refused,
            fields: vec4Chunks(
                `${identity} values`,
                block.values ?? [],
                refused ? " (refused)" : "",
            ),
        };
    });
    const mesh: Array<{ block: PinnedMeshBlock; fields: UniformField[] }> = [];
    const seen = new Set<string>();
    for (const block of capture.pinnedMeshBlocks ?? []) {
        // The capture dumps one entry per PBR draw, so a mesh drawn in
        // several lists repeats byte-identically; one row per distinct
        // payload, like every other field here.
        const signature = JSON.stringify(block);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const prefix = `pinned mesh[${block.meshIndex}]`;
        mesh.push({
            block,
            fields: [
                ...vec4Chunks(`${prefix} world`, block.world ?? [], ""),
                ...(typeof block.lightCount === "number"
                    ? [
                          {
                              name: `${prefix} lightCount`,
                              values: [block.lightCount],
                          },
                      ]
                    : []),
                ...vec4Chunks(`${prefix} bone0`, block.bone0 ?? [], ""),
                ...vec4Chunks(`${prefix} bone1`, block.bone1 ?? [], ""),
            ],
        });
    }
    return { material, mesh };
}

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

interface CapturedBuffer {
    id?: number;
    label?: string;
    size?: number;
    usage?: number;
    writes?: Array<{ data?: string } | string>;
    mappedWrites?: Array<{ data?: string }>;
}

/** One buffers.json entry that passed admission, its last write decoded. */
export interface AdmittedBuffer {
    id: number | string;
    size: number;
    bytes: Buffer;
}

/**
 * The capture's buffers.json, parsed once and reduced to the buffers
 * whose values are worth reading — uniform blocks, plus storage buffers
 * small enough to be state rather than geometry — each with its newest
 * write decoded. Both projections below (the struct-decoded fields and
 * the raw vec4 rows) read this one result, so they cannot disagree about
 * which buffers even have bytes, and the multi-megabyte base64 payload
 * is parsed and decoded once per diff instead of once per projection.
 */
function admittedBuffers(captureDirectory: string): AdmittedBuffer[] {
    const buffersPath = captureBuffersPath(captureDirectory);
    if (!existsSync(buffersPath)) {
        throw new Error(
            `No browser capture at ${buffersPath}. Run 'scene -- capture <id>' first.`,
        );
    }
    const buffers = JSON.parse(
        readFileSync(buffersPath, "utf8"),
    ) as CapturedBuffer[];
    const admitted: AdmittedBuffer[] = [];
    for (const buffer of buffers) {
        const usage = buffer.usage ?? 0;
        const uniform = (usage & uniformUsage) !== 0;
        const storage =
            (usage & storageUsage) !== 0 &&
            (buffer.size ?? 0) <= storageValueCap;
        if (!uniform && !storage) continue;
        const bytes = lastWriteBytes(buffer);
        if (!bytes) continue;
        admitted.push({
            id: buffer.id ?? "?",
            size: buffer.size ?? bytes.length,
            bytes,
        });
    }
    return admitted;
}

/** A buffer's payload as bare `buffer#<id>[<lane>]` vec4 rows — upload
 *  granularity, shared by the no-struct fallback and the row projection
 *  so the two spell their names and lanes identically. */
function bufferVec4Rows(buffer: AdmittedBuffer): UniformField[] {
    const rows: UniformField[] = [];
    for (
        let offset = 0;
        offset + 16 <= buffer.bytes.length;
        offset += 16
    ) {
        rows.push({
            name: `buffer#${buffer.id}[${offset / 4}]`,
            values: [0, 1, 2, 3].map((lane) =>
                buffer.bytes.readFloatLE(offset + lane * 4),
            ),
        });
    }
    return rows;
}

/** The capture's composed shader modules by file name — read once, and
 *  served to the struct parse, the arm comparison and the sample-call
 *  listing alike. */
function readBrowserShaderTexts(
    captureDirectory: string,
): Map<string, string> {
    const texts = new Map<string, string>();
    const shaderDirectory = captureShadersDirectory(captureDirectory);
    if (!existsSync(shaderDirectory)) return texts;
    for (const name of readdirSync(shaderDirectory)) {
        if (!name.endsWith(".wgsl")) continue;
        texts.set(
            name,
            readFileSync(join(shaderDirectory, name), "utf8"),
        );
    }
    return texts;
}

/**
 * Every uniform field the browser uploaded, decoded through the struct
 * declarations in the browser's own composed shaders.
 *
 * A buffer whose size matches several declared structs is decoded under
 * each of them; duplicate names collapse when their values agree, which
 * they do for the scene block every fragment redeclares.
 */
export function browserUniformFields(
    buffers: readonly AdmittedBuffer[],
    structs: readonly WgslStruct[],
): UniformField[] {
    const fields: UniformField[] = [];
    const seen = new Set<string>();
    for (const buffer of buffers) {
        const matching = structs.filter(
            (struct) => struct.size === buffer.size,
        );
        if (matching.length === 0) {
            fields.push(...bufferVec4Rows(buffer));
            continue;
        }
        for (const struct of matching) {
            const layout = fieldOffsets(struct.fields);
            if (!layout) continue;
            struct.fields.forEach((field, index) => {
                const offset = layout.offsets[index]!;
                const width = layoutOf(field.type)?.size;
                if (width === undefined) return;
                const values: number[] = [];
                for (
                    let lane = 0;
                    lane * 4 < width &&
                    offset + lane * 4 + 4 <= buffer.bytes.length;
                    lane += 1
                ) {
                    values.push(
                        buffer.bytes.readFloatLE(offset + lane * 4),
                    );
                }
                const name = `buffer#${buffer.id} ${field.name}`;
                const signature = `${name}|${values.join(",")}`;
                if (seen.has(signature)) return;
                seen.add(signature);
                fields.push({ name, values });
            });
        }
    }
    return fields;
}

/**
 * Every admitted browser buffer as bare vec4 rows, for the value lookup.
 *
 * The struct-decoded fields above are the named half, but a composed
 * material struct declares scalars (`environmentIntensity: f32, ...`)
 * and `correspond` pairs equal widths — so a native vec4 chunk from a
 * pinned block would never meet the four scalars it was written from.
 * These rows carry the same bytes at upload granularity. They join the
 * candidate pool only: reporting them under "browser values with no
 * native counterpart" would duplicate every decoded field.
 */
export function browserBufferValueRows(
    buffers: readonly AdmittedBuffer[],
): UniformField[] {
    return buffers.flatMap((buffer) => bufferVec4Rows(buffer));
}

// ---------------------------------------------------------------------------
// Texture palettes
// ---------------------------------------------------------------------------

/** One `tex-uploads.json` entry, as the instrumented capture's page
 *  script records it: raw bytes for small `writeTexture` payloads
 *  (rgba32float rows get a higher cap because they carry bone
 *  palettes), a 4x4 sample for `copyExternalImageToTexture`. */
export interface TextureUpload {
    tex?: number;
    kind?: string;
    desc?: { format?: string } | null;
    mipLevel?: number;
    bytes?: number[] | null;
    byteLength?: number;
    sample?: unknown;
}

/**
 * The documented mirror similarity map: negate column-major indexes 1,
 * 2, 3, 4, 8 and 12 — the `diag(-1, 1, 1)` conjugation that relates
 * every native matrix to the browser's (docs/debugging.md). Applying it
 * is what turns the "a sign-flipped lane is not a finding" counsel into
 * a mechanical match.
 */
export function mirrorMatrixConvention(
    values: readonly number[],
): number[] {
    const mirrored = [...values];
    for (const index of [1, 2, 3, 4, 8, 12]) {
        if (index < mirrored.length) mirrored[index] = -mirrored[index]!;
    }
    return mirrored;
}

/** `undefined` when the capture predates `tex-uploads.json`; an
 *  unreadable file reads as an empty record rather than a crash. */
export function readTextureUploads(
    captureDirectory: string,
): TextureUpload[] | undefined {
    const path = captureTextureUploadsPath(captureDirectory);
    if (!existsSync(path)) return undefined;
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? (parsed as TextureUpload[]) : [];
    } catch {
        return [];
    }
}

export function texturePaletteReport(
    capture: NativeCapture,
    uploads: readonly TextureUpload[],
): TexturePaletteReport {
    const floatUploads: TexturePaletteReport["floatUploads"] = [];
    const candidates: UniformField[] = [];
    let colorUploads = 0;
    let externalImages = 0;
    uploads.forEach((upload, index) => {
        if (upload.kind === "copyExternalImage") {
            externalImages += 1;
            return;
        }
        const format = upload.desc?.format ?? "";
        if (!format.includes("32float")) {
            colorUploads += 1;
            return;
        }
        const bytes = upload.bytes;
        let matrices = 0;
        if (Array.isArray(bytes)) {
            const buffer = Buffer.from(bytes);
            const floats: number[] = [];
            for (
                let offset = 0;
                offset + 4 <= buffer.length;
                offset += 4
            ) {
                floats.push(buffer.readFloatLE(offset));
            }
            // Four rgba32float texels per matrix, matrices consecutive:
            // the pin's bone-texture layout.
            matrices = Math.floor(floats.length / 16);
            for (let matrix = 0; matrix < matrices; matrix += 1) {
                candidates.push({
                    name: `tex#${upload.tex ?? "?"} upload${index} matrix[${matrix}]`,
                    values: floats.slice(matrix * 16, matrix * 16 + 16),
                });
            }
        }
        floatUploads.push({
            tex: upload.tex ?? -1,
            format,
            matrices,
            byteLength:
                upload.byteLength ??
                (Array.isArray(bytes) ? bytes.length : 0),
            truncated: !Array.isArray(bytes),
        });
    });
    const palettes: PaletteCorrespondence[] = [];
    const seen = new Set<string>();
    for (const block of capture.pinnedMeshBlocks ?? []) {
        for (const [label, matrix] of [
            ["bone0", block.bone0],
            ["bone1", block.bone1],
        ] as const) {
            if (!matrix || matrix.length === 0) continue;
            // One entry per distinct payload, like every other pairing:
            // the capture dumps one mesh block per PBR draw.
            const signature = `${block.meshIndex} ${label} ${matrix.join(",")}`;
            if (seen.has(signature)) continue;
            seen.add(signature);
            const name = `pinned mesh[${block.meshIndex}] ${label}`;
            const mirrored = mirrorMatrixConvention(matrix);
            let matched: UniformField | undefined;
            let nearest: UniformField | undefined;
            let nearestDelta = Number.POSITIVE_INFINITY;
            for (const candidate of candidates) {
                if (candidate.values.length !== mirrored.length) continue;
                if (agrees(mirrored, candidate.values, mirrored.length)) {
                    matched = candidate;
                    break;
                }
                const delta = maxDelta(mirrored, candidate.values);
                if (delta < nearestDelta) {
                    nearestDelta = delta;
                    nearest = candidate;
                }
            }
            palettes.push(
                matched
                    ? {
                          native: name,
                          match: "exact",
                          browser: matched.name,
                          maxDelta: maxDelta(mirrored, matched.values),
                      }
                    : {
                          native: name,
                          match: "divergent",
                          ...(nearest
                              ? {
                                    browser: nearest.name,
                                    maxDelta: nearestDelta,
                                }
                              : {}),
                      },
            );
        }
    }
    return { floatUploads, palettes, colorUploads, externalImages };
}

// ---------------------------------------------------------------------------
// Correspondence
// ---------------------------------------------------------------------------

/**
 * Whether a tuple says anything.
 *
 * Zeros, ones and identity rows appear in dozens of unrelated fields on
 * both sides, so matching one proves nothing and reporting one as a
 * finding is noise. They are carried through as `exact` when they match
 * and excluded from the divergence list when they do not.
 */
function trivial(values: number[]): boolean {
    return values.every((value) => value === 0) ||
        values.every((value) => value === 1);
}

function maxDelta(left: number[], right: number[]): number {
    const lanes = Math.min(left.length, right.length);
    let worst = 0;
    for (let lane = 0; lane < lanes; lane += 1) {
        worst = Math.max(worst, Math.abs(left[lane]! - right[lane]!));
    }
    return worst;
}

/**
 * The tolerance at which two independently computed pipelines count as
 * having computed the same number.
 *
 * Relative, not absolute: the two sides differ in the last bits or two
 * for anything that went through a different order of operations — a
 * camera position that agreed to eight digits was being reported as a
 * mismatch by exact comparison, which is precisely the false finding
 * that makes a tool stop being read. Anything a shader can see is orders
 * of magnitude wider than this.
 */
const agreementTolerance = 1e-5;

function agrees(left: number[], right: number[], lanes: number): boolean {
    for (let lane = 0; lane < lanes; lane += 1) {
        const a = left[lane]!;
        const b = right[lane]!;
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            if (a !== b) return false;
            continue;
        }
        const scale = Math.max(1, Math.abs(a), Math.abs(b));
        if (Math.abs(a - b) > agreementTolerance * scale) return false;
    }
    return true;
}

/**
 * Every browser value a native field could correspond to.
 *
 * A field wider than four lanes is also offered as its `vec4` chunks,
 * because the pin uploads a matrix as one `mat4x4` while our generated
 * struct declares it as four rows — the same sixteen floats described at
 * different granularity, and only the chunked form can line them up.
 */
function browserCandidates(browser: UniformField[]): UniformField[] {
    const candidates: UniformField[] = [];
    for (const field of browser) {
        candidates.push(field);
        if (field.values.length > 4) {
            for (
                let offset = 0;
                offset + 4 <= field.values.length;
                offset += 4
            ) {
                candidates.push({
                    name: `${field.name}[${offset / 4}]`,
                    values: field.values.slice(offset, offset + 4),
                });
            }
        }
    }
    return candidates;
}

/**
 * Look every native field up in the browser's uploaded values.
 *
 * Full-width agreement first, then agreement on the leading three lanes,
 * and only when neither holds is the closest browser field of the same
 * width reported with its delta. A near miss names the value that
 * drifted, which is the shape of nearly every real finding here.
 */
export function correspond(
    native: UniformField[],
    browser: UniformField[],
): FieldCorrespondence[] {
    const candidates = browserCandidates(browser);
    return native.map((field) => {
        let nearest: UniformField | undefined;
        let nearestDelta = Number.POSITIVE_INFINITY;
        let prefixMatch: UniformField | undefined;
        for (const candidate of candidates) {
            if (candidate.values.length !== field.values.length) {
                if (
                    !prefixMatch &&
                    field.values.length >= 3 &&
                    candidate.values.length >= 3 &&
                    agrees(field.values, candidate.values, 3)
                ) {
                    prefixMatch = candidate;
                }
                continue;
            }
            if (agrees(field.values, candidate.values, field.values.length)) {
                return {
                    native: field.name,
                    values: field.values,
                    match: "exact" as const,
                    browser: candidate.name,
                    browserValues: candidate.values,
                    maxDelta: maxDelta(field.values, candidate.values),
                };
            }
            if (
                !prefixMatch &&
                field.values.length >= 3 &&
                agrees(field.values, candidate.values, 3)
            ) {
                prefixMatch = candidate;
            }
            const delta = maxDelta(field.values, candidate.values);
            if (delta < nearestDelta) {
                nearestDelta = delta;
                nearest = candidate;
            }
        }
        if (prefixMatch) {
            return {
                native: field.name,
                values: field.values,
                match: "vec3" as const,
                browser: prefixMatch.name,
                browserValues: prefixMatch.values,
                maxDelta: maxDelta(
                    field.values.slice(0, 3),
                    prefixMatch.values.slice(0, 3),
                ),
            };
        }
        return {
            native: field.name,
            values: field.values,
            match: "divergent" as const,
            ...(nearest
                ? {
                      browser: nearest.name,
                      browserValues: nearest.values,
                      maxDelta: nearestDelta,
                  }
                : {}),
        };
    });
}

/** The inverse direction, under the same rules. */
function carriedNatively(
    field: UniformField,
    nativeCandidates: UniformField[],
): boolean {
    for (const candidate of nativeCandidates) {
        if (
            candidate.values.length === field.values.length &&
            agrees(field.values, candidate.values, field.values.length)
        ) {
            return true;
        }
        if (
            field.values.length >= 3 &&
            candidate.values.length >= 3 &&
            agrees(field.values, candidate.values, 3)
        ) {
            return true;
        }
    }
    return false;
}

/** Indexed draw shapes, which is the part both sides can be compared on. */
function browserDrawShapes(captureDirectory: string): {
    indexed: Set<string>;
    nonIndexed: string[];
} {
    const path = captureDrawsPath(captureDirectory);
    const indexed = new Set<string>();
    const nonIndexed: string[] = [];
    if (!existsSync(path)) return { indexed, nonIndexed };
    const draws = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        number
    >;
    for (const key of Object.keys(draws)) {
        const drawIndexed = /drawIndexed\((\d+),(\d+)/.exec(key);
        if (drawIndexed) {
            indexed.add(`${drawIndexed[1]}x${drawIndexed[2]}`);
            continue;
        }
        nonIndexed.push(`${key} x${draws[key]}`);
    }
    return { indexed, nonIndexed };
}

/**
 * The browser's counts are not comparable to ours and are deliberately
 * not compared. A render bundle is recorded once and replayed every
 * frame, an un-bundled draw is recorded per frame, and the native
 * capture describes exactly one frame — so `bundle.drawIndexed(N)` count
 * 1 and `pass.drawIndexed(M)` count 704 describe the same single frame.
 * The *set* of shapes is frame-count independent, and that is what a
 * missing or extra draw actually moves.
 */
function nativeDrawShapes(capture: NativeCapture): Set<string> {
    const shapes = new Set<string>();
    for (const draw of capture.draws ?? []) {
        shapes.add(
            `${draw.indexCount ?? 0}x${Math.max(draw.instanceCount ?? 1, 1)}`,
        );
    }
    return shapes;
}

/**
 * Per-line trailing whitespace stripped, trailing blank lines dropped.
 *
 * `scene -- compose` is the byte gate and collapses all whitespace before
 * comparing; this normalization is deliberately tighter, because a
 * matched arm here is meant to be the same shader, not merely the same
 * tokens — measured against the corpus, the generated variants that have
 * a browser counterpart match it byte-for-byte already, so all this
 * forgives is line endings and trailing space.
 */
export function normalizeShaderText(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n+$/, "");
}

/**
 * Where two texts stop agreeing: `scene -- compose`'s
 * longest-common-prefix idiom, shared by the compose report and the
 * shader-arm near miss so the two cannot count lines differently.
 * `line` is the number of agreeing lines (0-based index of the first
 * divergent one — the reports print `line + 1`), and each context is
 * the two-line slice from that point.
 */
export function divergence(
    mineText: string,
    theirsText: string,
): { line: number; mineContext: string[]; theirsContext: string[] } {
    const mine = mineText.split("\n");
    const theirs = theirsText.split("\n");
    let line = 0;
    while (
        line < mine.length &&
        line < theirs.length &&
        mine[line] === theirs[line]
    ) {
        line += 1;
    }
    return {
        line,
        mineContext: mine.slice(line, line + 2),
        theirsContext: theirs.slice(line, line + 2),
    };
}

/** The compose report's own test for a PBR fragment: an entry point that
 *  shades a base F0. A captured module that passes it and matches no
 *  generated arm is the compose-class finding. */
function looksLikePbrFragment(text: string): boolean {
    return /@fragment/.test(text) && /colorF0/.test(text);
}

/**
 * Hash the browser's composed modules against the generated arms and
 * report matched groups, both one-sided sets, and the closest one-sided
 * pair's first divergent line — the manual hash/diff recipe as a report.
 *
 * The near miss borrows `scene -- compose`'s longest-common-prefix idiom:
 * the line where the closest pair stops agreeing names the arm. PBR
 * fragments are preferred as the browser half of that pair, because a
 * mismatched blit helper diverges at line one and names nothing.
 */
export function shaderArmReport(
    browserModules: ReadonlyMap<string, string>,
    nativeArms: ReadonlyMap<string, string>,
): ShaderArmReport {
    const groups = new Map<string, { browser: string[]; native: string[] }>();
    const groupFor = (text: string): { browser: string[]; native: string[] } => {
        const digest = createHash("sha256")
            .update(normalizeShaderText(text))
            .digest("hex");
        let group = groups.get(digest);
        if (!group) {
            group = { browser: [], native: [] };
            groups.set(digest, group);
        }
        return group;
    };
    for (const [name, text] of browserModules) groupFor(text).browser.push(name);
    for (const [name, text] of nativeArms) groupFor(text).native.push(name);
    const everyGroup = [...groups.values()];
    for (const group of everyGroup) {
        group.browser.sort();
        group.native.sort();
    }
    const matched = everyGroup
        .filter((group) => group.browser.length > 0 && group.native.length > 0)
        .sort((left, right) =>
            (left.browser[0] ?? "").localeCompare(right.browser[0] ?? ""));
    const browserOnly = everyGroup
        .filter((group) => group.native.length === 0)
        .flatMap((group) => group.browser)
        .sort();
    const nativeOnly = everyGroup
        .filter((group) => group.browser.length === 0)
        .flatMap((group) => group.native)
        .sort();

    const pbrOrphans = browserOnly.filter((name) =>
        looksLikePbrFragment(browserModules.get(name) ?? ""));
    const nearMissCandidates = pbrOrphans.length > 0 ? pbrOrphans : browserOnly;
    let nearMiss: ShaderArmReport["nearMiss"];
    let agreed = 0;
    for (const browserName of nearMissCandidates) {
        const mine = normalizeShaderText(
            browserModules.get(browserName) ?? "",
        );
        for (const nativeName of nativeOnly) {
            const { line, mineContext, theirsContext } = divergence(
                mine,
                normalizeShaderText(nativeArms.get(nativeName) ?? ""),
            );
            // Strictly better only: a pair that shares no line at all is
            // not a near miss, it is two different shaders.
            if (line > agreed) {
                agreed = line;
                nearMiss = {
                    browser: browserName,
                    native: nativeName,
                    line: line + 1,
                    browserLines: mineContext,
                    nativeLines: theirsContext,
                };
            }
        }
    }
    return {
        matched,
        browserOnly,
        nativeOnly,
        pbrOrphans,
        ...(nearMiss ? { nearMiss } : {}),
    };
}

/** `textureSample(tex, sampler, uv)` calls: where a UV-transform or a
 *  texture-slot mistake shows up as text rather than as a number. */
export function sampleCalls(source: string): string[] {
    return [
        ...new Set(
            [...source.matchAll(/textureSample\w*\([^;)]*\)/g)].map((match) =>
                match[0]!.replace(/\s+/g, ""),
            ),
        ),
    ].sort();
}

export function buildRenderDiff(
    sceneId: string,
    captureDirectory: string,
    nativeCapturePath: string,
    generatedDirectory: string,
): RenderDiffReport {
    const capture = readNativeCapture(nativeCapturePath);
    // The browser capture is parsed once: the admitted buffers serve both
    // value projections, and the shader texts serve the struct parse, the
    // arm comparison and the sample-call listing.
    const captureBuffers = admittedBuffers(captureDirectory);
    const browserShaderTexts = readBrowserShaderTexts(captureDirectory);
    const structs: WgslStruct[] = [];
    for (const [name, text] of browserShaderTexts) {
        structs.push(...parseWgslStructs(text, name));
    }
    const browser = browserUniformFields(captureBuffers, structs);
    // The struct authorities, in precedence order: the renderer plan's own
    // header, then the generated pinned-variant headers whose uniform
    // mirrors the capture's standard and PBR blocks are written through
    // (StandardMaterialUniforms, SceneUniforms, LightEntry, MeshUniforms).
    // Without those two, a standard scene's material block decoded as bare
    // `StandardMaterialUniforms[n]` rows — the scene9 hunt's 38-field
    // native side. First parse wins a name, so the plan header's reading
    // cannot move.
    const layouts = new Map<string, Array<{ name: string; floats: number }>>();
    for (const header of [
        "renderer_plan.hpp",
        "standard_variants.hpp",
        "pbr_variants.hpp",
    ]) {
        const headerPath = join(
            generatedDirectory,
            "upstream",
            "include",
            "bblite",
            "upstream",
            header,
        );
        if (!existsSync(headerPath)) continue;
        for (const [name, fields] of parseCppUniformStructs(
            readFileSync(headerPath, "utf8"),
        )) {
            if (!layouts.has(name)) layouts.set(name, fields);
        }
    }

    const blocks: NativeUniformBlock[] = [
        ...(capture.draws ?? []).flatMap((draw) => draw.uniforms ?? []),
        ...(capture.backgroundUniforms ?? []),
    ];
    const native: UniformField[] = [];
    const seenField = new Set<string>();
    const admit = (field: UniformField): void => {
        // One row per distinct payload: a scene draws the same
        // material many times, and repeating an identical field
        // buries the one that differs.
        const signature = `${field.name}|${field.values.join(",")}`;
        if (seenField.has(signature)) return;
        seenField.add(signature);
        native.push(field);
    };
    for (const block of blocks) {
        for (const field of nativeFields(block, layouts)) admit(field);
    }
    // The pinned material and mesh blocks ride the same pairing as every
    // other native field — rung 4b's two listings, diffed here instead of
    // by hand.
    const pinned = pinnedBlockFields(capture);
    const pinnedBlockList = [...pinned.material, ...pinned.mesh];
    for (const entry of pinnedBlockList) {
        for (const field of entry.fields) admit(field);
    }

    // Raw vec4 rows join the candidate pool after the decoded fields, so
    // every match that resolved against a named field still does and the
    // rows only catch what scalar decoding cannot pair (a pinned vec4
    // chunk against a struct of four f32 scalars).
    const candidates = [...browser];
    const candidateSignatures = new Set(
        browser.map((field) => `${field.name}|${field.values.join(",")}`),
    );
    for (const row of browserBufferValueRows(captureBuffers)) {
        const signature = `${row.name}|${row.values.join(",")}`;
        if (candidateSignatures.has(signature)) continue;
        candidateSignatures.add(signature);
        candidates.push(row);
    }
    const correspondences = correspond(native, candidates);

    // Each row's outcome by signature, for the per-block tallies. Rows
    // that share a signature share an outcome, which is right: they are
    // the same bytes.
    const outcomeBySignature = new Map<string, FieldCorrespondence>();
    for (const entry of correspondences) {
        outcomeBySignature.set(
            `${entry.native}|${entry.values.join(",")}`,
            entry,
        );
    }
    const tally = (fields: UniformField[]): PinnedBlockRowTally => {
        const rows: PinnedBlockRowTally = { exact: 0, vec3: 0, divergent: 0 };
        for (const field of fields) {
            const outcome = outcomeBySignature.get(
                `${field.name}|${field.values.join(",")}`,
            );
            if (outcome) rows[outcome.match] += 1;
        }
        return rows;
    };
    const materialBlockReports = pinned.material.map(
        ({ block, refused, fields }) => ({
            materialIndex: block.materialIndex,
            variant: block.variant,
            key: block.key ?? "",
            bytes: block.bytes ?? (block.values ?? []).length * 4,
            refused,
            rows: tally(fields),
        }),
    );
    const meshBlockReports = pinned.mesh.map(({ block, fields }) => ({
        meshIndex: block.meshIndex,
        lightCount: block.lightCount ?? 0,
        boneCount: block.boneCount ?? 0,
        rows: tally(fields),
    }));
    const divergent = correspondences
        .filter(
            (entry) =>
                entry.match === "divergent" && !trivial(entry.values),
        )
        .sort(
            (left, right) =>
                (right.maxDelta ?? Number.POSITIVE_INFINITY) -
                (left.maxDelta ?? Number.POSITIVE_INFINITY),
        );
    // The inverse question: a value the pin computed that we never did.
    // Matched under the same rules, so a vec3 the pin pads differently is
    // not reported as missing from our side either.
    const nativeCandidates = browserCandidates(native);
    const browserOnly = browser.filter(
        (field) =>
            !trivial(field.values) &&
            !carriedNatively(field, nativeCandidates),
    );

    const browserShapes = browserDrawShapes(captureDirectory);
    const nativeShapes = nativeDrawShapes(capture);
    const draws: DrawShapeReport = {
        shared: [...nativeShapes].filter((shape) =>
            browserShapes.indexed.has(shape),
        ),
        onlyInNative: [...nativeShapes].filter(
            (shape) => !browserShapes.indexed.has(shape),
        ),
        onlyInBrowser: [...browserShapes.indexed].filter(
            (shape) => !nativeShapes.has(shape),
        ),
        browserNonIndexed: browserShapes.nonIndexed,
    };

    const browserModules = [...browserShaderTexts.keys()];
    const nativeShaderDirectory = join(
        generatedDirectory,
        "upstream",
        "shaders",
    );
    const nativeShaderFiles = existsSync(nativeShaderDirectory)
        ? readdirSync(nativeShaderDirectory).filter((name) =>
              name.endsWith(".wgsl"),
          )
        : [];
    // The arm comparison set: the composed pinned variants, which are what
    // the browser's own modules should be byte-for-byte, plus the deployed
    // .native.wgsl payload so a deployment that drifted from its source
    // shows up as a split group instead of staying invisible.
    const nativeArmTexts = new Map<string, string>();
    const variantDirectory = join(
        generatedDirectory,
        "upstream",
        "pbr-variants",
    );
    if (existsSync(variantDirectory)) {
        for (const name of readdirSync(variantDirectory)) {
            if (!name.endsWith(".wgsl")) continue;
            nativeArmTexts.set(
                `pbr-variants/${name}`,
                readFileSync(join(variantDirectory, name), "utf8"),
            );
        }
    }
    for (const name of nativeShaderFiles) {
        if (!name.endsWith(".native.wgsl")) continue;
        nativeArmTexts.set(
            `shaders/${name}`,
            readFileSync(join(nativeShaderDirectory, name), "utf8"),
        );
    }
    // `pbrOrphans` rides beside the serialized arm sets, not inside them:
    // the findings rank by it, while the written report keeps exactly the
    // fields it has always had.
    const { pbrOrphans = [], ...arms } = shaderArmReport(
        browserShaderTexts,
        nativeArmTexts,
    );

    // The palette matching: absent (not empty) when the browser capture
    // predates tex-uploads.json, so the report can say "recapture" rather
    // than "no palettes".
    const textureUploads = readTextureUploads(captureDirectory);
    const texturePalettes =
        textureUploads !== undefined
            ? texturePaletteReport(capture, textureUploads)
            : undefined;

    const findings: string[] = [];
    if (draws.onlyInNative.length > 0 || draws.onlyInBrowser.length > 0) {
        findings.push(
            `Draw shapes differ: ${draws.onlyInNative.length} native-only, ${draws.onlyInBrowser.length} browser-only ` +
                `(index x instance counts). A different set of draws explains every uniform and pixel difference below it — settle this first.`,
        );
    }
    // A composed fragment we never emitted explains uniform differences
    // too — the two sides would not even share struct layouts — so it
    // outranks every value below it.
    if (pbrOrphans.length > 0) {
        findings.push(
            `${pbrOrphans.length} captured PBR fragment(s) match no generated shader arm: ${pbrOrphans.join(", ")}` +
                (arms.nearMiss
                    ? ` — nearest ${arms.nearMiss.native} diverges at line ${arms.nearMiss.line} (shader arms below)`
                    : "") +
                `. A missing arm renders as a plausible bias, never as an error; 'scene -- compose ${sceneId}' names the feature that composes it.`,
        );
    }
    if (divergent.length > 0) {
        const worst = divergent[0]!;
        findings.push(
            `${divergent.length} of ${native.length} native uniform field(s) carry a value no browser upload carries. ` +
                `Read the list rather than the count: the two sides do not share a layout, so a slot our generated ` +
                `struct always declares and the pinned fragment never does (unused light slots, the reverse-Z depth ` +
                `row) appears here on a byte-exact scene too. What is worth chasing is a field that *should* have a ` +
                `counterpart and is close but not equal. Widest: ${worst.native} = [${format(worst.values)}]` +
                (worst.browser
                    ? `, nearest browser ${worst.browser} = [${format(worst.browserValues ?? [])}], delta ${worst.maxDelta?.toExponential(3)}`
                    : ", with no browser field of the same width"),
        );
    }
    const pinnedDivergentRows = materialBlockReports
        .filter((block) => !block.refused)
        .reduce((count, block) => count + block.rows.divergent, 0);
    const refusedBlocks = materialBlockReports.filter(
        (block) => block.refused,
    ).length;
    if (pinnedDivergentRows > 0) {
        findings.push(
            `${pinnedDivergentRows} pinned material-block row(s) carry a value no browser upload carries ` +
                `('pinned material[...]' in the list below) — the rung-4b two-listing diff, automated. With the ` +
                `shader arms matched, a pinned-path residual is an input to the writers, never the shader.` +
                (refusedBlocks > 0
                    ? ` ${refusedBlocks} block(s) are flagged (refused): no PBR draw this frame carries their material, so their values never reached the GPU.`
                    : ""),
        );
    }
    const unmatchedPalettes =
        texturePalettes?.palettes.filter(
            (entry) => entry.match === "divergent",
        ) ?? [];
    if (unmatchedPalettes.length > 0) {
        findings.push(
            `${unmatchedPalettes.length} native bone-palette matrix(es) appear in no browser float-texture upload ` +
                `(mirror map applied): ${unmatchedPalettes.map((entry) => entry.native).join(", ")}. ` +
                "The two sides disagree on skinning state at this pose — BBLITE_DEFORMATION_DUMP prints the native palettes in full.",
        );
    }
    if (findings.length === 0) {
        findings.push(
            "Every native uniform value appears in the browser's uploads and the draw shapes agree. " +
                "A residual that survives this is in the shading, the rasterization, or a texture payload — " +
                "the shader arms below settle the shading half against the browser's own compiled modules.",
        );
    }

    return {
        scene: sceneId,
        backend: capture.backend,
        findings,
        summary: {
            nativeDraws: (capture.draws ?? []).length,
            nativeMeshes: (capture.meshes ?? []).length,
            nativeMaterials: (capture.materials ?? []).length,
            nativeLights: (capture.lights ?? []).length,
            nativeFields: native.length,
            browserFields: browser.length,
            exact: correspondences.filter((entry) => entry.match === "exact")
                .length,
            vec3: correspondences.filter((entry) => entry.match === "vec3")
                .length,
            divergent: correspondences.filter(
                (entry) => entry.match === "divergent",
            ).length,
        },
        draws,
        divergent,
        browserOnly,
        ...(pinnedBlockList.length > 0
            ? {
                  pinned: {
                      materialBlocks: materialBlockReports,
                      meshBlocks: meshBlockReports,
                  },
              }
            : {}),
        ...(texturePalettes !== undefined ? { texturePalettes } : {}),
        shaders: {
            browserModules,
            nativeShaders: nativeShaderFiles,
            arms,
            browserSampleCalls: [
                ...new Set(
                    [...browserShaderTexts.values()].flatMap((text) =>
                        sampleCalls(text),
                    ),
                ),
            ].sort(),
            nativeSampleCalls: [
                ...new Set(
                    nativeShaderFiles.flatMap((name) =>
                        sampleCalls(
                            readFileSync(
                                join(nativeShaderDirectory, name),
                                "utf8",
                            ),
                        ),
                    ),
                ),
            ].sort(),
        },
    };
}

export function formatRenderDiff(
    report: RenderDiffReport,
    limit = 30,
): string {
    const lines: string[] = [];
    lines.push(
        `Render diff: ${report.scene} (native backend ${report.backend})`,
    );
    lines.push("");
    for (const finding of report.findings) lines.push(`  * ${finding}`);
    lines.push("");
    lines.push(
        `Native frame: ${report.summary.nativeDraws} draws, ` +
            `${report.summary.nativeMeshes} meshes, ${report.summary.nativeMaterials} materials, ` +
            `${report.summary.nativeLights} lights`,
    );
    lines.push(
        `Uniform fields: ${report.summary.nativeFields} native against ${report.summary.browserFields} browser — ` +
            `${report.summary.exact} agree exactly, ${report.summary.vec3} agree on their first three lanes, ` +
            `${report.summary.divergent} diverge`,
    );
    lines.push("");
    lines.push(
        `Indexed draw shapes: ${report.draws.shared.length} shared` +
            (report.draws.onlyInNative.length
                ? `, native only ${report.draws.onlyInNative.join(", ")}`
                : "") +
            (report.draws.onlyInBrowser.length
                ? `, browser only ${report.draws.onlyInBrowser.join(", ")}`
                : ""),
    );
    if (report.divergent.length > 0) {
        lines.push("");
        lines.push("Native values the browser never uploaded:");
        for (const entry of report.divergent.slice(0, limit)) {
            lines.push(`  ${entry.native}`);
            lines.push(`    native  [${format(entry.values)}]`);
            if (entry.browser) {
                lines.push(
                    `    nearest [${format(entry.browserValues ?? [])}]  ${entry.browser}  (delta ${entry.maxDelta?.toExponential(3)})`,
                );
            } else {
                lines.push("    nearest none of this width");
            }
        }
        if (report.divergent.length > limit) {
            lines.push(`  ... ${report.divergent.length - limit} more`);
        }
    }
    if (report.browserOnly.length > 0) {
        lines.push("");
        lines.push(
            `Browser values with no native counterpart (${report.browserOnly.length}); first ${Math.min(limit, report.browserOnly.length)}:`,
        );
        for (const field of report.browserOnly.slice(0, limit)) {
            lines.push(`  ${field.name.padEnd(40)} [${format(field.values)}]`);
        }
    }
    if (report.pinned) {
        lines.push("");
        lines.push(
            "Pinned variant blocks (built CPU-side by the draw path's own " +
                "writers; their rows are the 'pinned ...' entries above):",
        );
        const tallyText = (rows: PinnedBlockRowTally): string =>
            `${rows.exact} exact, ${rows.vec3} vec3, ${rows.divergent} divergent`;
        for (const block of report.pinned.materialBlocks.slice(0, limit)) {
            lines.push(
                `  material[${block.materialIndex}] variant ${block.variant}` +
                    ` (${block.key ? `${block.key}, ` : ""}${block.bytes} B)` +
                    `  rows: ${tallyText(block.rows)}` +
                    (block.refused
                        ? "  REFUSED — no PBR draw this frame carries this material; these values never reached the GPU"
                        : ""),
            );
        }
        if (report.pinned.materialBlocks.length > limit) {
            lines.push(
                `  ... ${report.pinned.materialBlocks.length - limit} more material block(s)`,
            );
        }
        for (const block of report.pinned.meshBlocks.slice(0, limit)) {
            lines.push(
                `  mesh[${block.meshIndex}] lightCount ${block.lightCount}, ` +
                    `bones ${block.boneCount}  rows: ${tallyText(block.rows)}`,
            );
        }
        if (report.pinned.meshBlocks.length > limit) {
            lines.push(
                `  ... ${report.pinned.meshBlocks.length - limit} more mesh block(s)`,
            );
        }
        if (report.pinned.meshBlocks.length > 0) {
            lines.push(
                "  Mesh worlds ride the native mirror convention (negate " +
                    "column-major 1, 2, 3, 4, 8 and 12 — docs/debugging.md): " +
                    "a sign-flipped lane against the browser's is that " +
                    "documented difference, not a finding." +
                    (report.texturePalettes
                        ? " Bone palettes are matched with that map applied, under 'Texture palettes' below."
                        : ""),
            );
        }
    }
    const palettes = report.texturePalettes;
    const nativeHasBones =
        report.pinned?.meshBlocks.some((block) => block.boneCount > 0) ??
        false;
    if (palettes) {
        lines.push("");
        lines.push(
            "Texture palettes (browser skins upload bone matrices as rgba32float " +
                "texels; each native palette matrix is looked up with the mirror " +
                `map applied): ${palettes.floatUploads.length} float upload(s), ` +
                `${palettes.colorUploads} color texel upload(s), ` +
                `${palettes.externalImages} external image(s) beside them`,
        );
        for (const upload of palettes.floatUploads.slice(0, limit)) {
            lines.push(
                `  tex#${upload.tex} ${upload.format}: ${upload.matrices} matrix(es), ${upload.byteLength} B` +
                    (upload.truncated
                        ? "  (bytes not recorded — above the capture's cap)"
                        : ""),
            );
        }
        for (const entry of palettes.palettes.slice(0, limit)) {
            lines.push(
                entry.match === "exact"
                    ? `  ${entry.native} == ${entry.browser}  (mirror applied, delta ${entry.maxDelta?.toExponential(3) ?? "0"})`
                    : `  ${entry.native} matches NO uploaded matrix` +
                          (entry.browser
                              ? `  (nearest ${entry.browser}, delta ${entry.maxDelta?.toExponential(3)})`
                              : ""),
            );
        }
        if (palettes.palettes.length === 0) {
            lines.push(
                "  (no bone palettes in the native capture — nothing to match)",
            );
        } else if (palettes.palettes.length > limit) {
            lines.push(
                `  ... ${palettes.palettes.length - limit} more palette matrix(es)`,
            );
        }
    } else if (nativeHasBones) {
        lines.push("");
        lines.push(
            "Texture palettes: this browser capture predates tex-uploads.json; " +
                "recapture with 'scene -- capture <id>' to match the native bone " +
                "palettes against the uploaded ones.",
        );
    }
    lines.push("");
    const arms = report.shaders.arms;
    lines.push(
        `Shader arms (matched by content, per-line trailing whitespace ` +
            `ignored): ${arms.matched.length} matched, ` +
            `${arms.browserOnly.length} browser-only, ` +
            `${arms.nativeOnly.length} native-only`,
    );
    for (const match of arms.matched) {
        const native = match.native[0] ?? "";
        lines.push(
            `  ${match.browser.join(", ")} == ${native}` +
                (match.native.length > 1
                    ? ` (+${match.native.length - 1} deployed twin(s))`
                    : ""),
        );
    }
    if (arms.browserOnly.length > 0) {
        lines.push(`  browser-only: ${arms.browserOnly.join(", ")}`);
    }
    if (arms.nativeOnly.length > 0) {
        lines.push(
            `  native-only:  ${arms.nativeOnly.join(", ")}` +
                "  (arms the browser did not compose at this pose are expected here)",
        );
    }
    if (arms.nearMiss) {
        lines.push(
            `  closest near-miss: ${arms.nearMiss.browser} vs ${arms.nearMiss.native}, ` +
                `diverges at line ${arms.nearMiss.line}:`,
        );
        lines.push(`    browser ${JSON.stringify(arms.nearMiss.browserLines)}`);
        lines.push(`    native  ${JSON.stringify(arms.nearMiss.nativeLines)}`);
    }
    lines.push("");
    lines.push(
        "Texture sample expressions (compare by eye — the two sides name their " +
            "variables differently, so this is a listing, not a diff):",
    );
    for (const call of report.shaders.browserSampleCalls) {
        lines.push(`  browser  ${call}`);
    }
    for (const call of report.shaders.nativeSampleCalls) {
        lines.push(`  native   ${call}`);
    }
    return lines.join("\n");
}

function format(values: number[]): string {
    return values
        .map((value) =>
            Number.isFinite(value) ? Number(value.toPrecision(9)) : String(value),
        )
        .join(", ");
}
