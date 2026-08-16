import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWgslStructs, type WgslStruct } from "./capture-uniforms.js";

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
    shaders: {
        browserModules: string[];
        nativeShaders: string[];
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

export interface NativeCapture {
    backend: string;
    buildStamp: string;
    viewport: { width: number; height: number };
    draws: NativeDraw[];
    backgroundUniforms: NativeUniformBlock[];
    meshes?: unknown[];
    materials?: unknown[];
    lights?: unknown[];
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
 * Every member of these structs is `std::array<float, 4>` or an array of
 * them, which is why a flat float view lines up with the upload at all.
 * A member this does not recognize abandons the struct rather than being
 * skipped, because a skipped member shifts every field after it and
 * would rename values silently.
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
                /^std::array<std::array<float,\s*(\d+)>,\s*(\d+)>\s+(\w+)/.exec(
                    text,
                );
            if (nested) {
                // Reported as one field per row: an array of vec4 slots is
                // nine separate harmonics, and comparing them as one
                // thirty-six-float tuple would never match anything.
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
            const scalar = /^float\s+(\w+)\s*(=|;)/.exec(text);
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

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

/** GPUBufferUsage.UNIFORM and .STORAGE. */
const uniformUsage = 0x40;
const storageUsage = 0x80;

/**
 * How large a non-uniform buffer may be and still be read for values.
 *
 * Babylon Lite keeps some per-frame state the fragments read — light
 * lists, for one — in storage buffers rather than uniform blocks, and
 * leaving those out means a native light slot has nothing to correspond
 * to and is reported as divergent on a scene that renders correctly.
 * Vertex and index buffers are storage-sized too and hold nothing worth
 * matching, so the cap admits the state and excludes the geometry.
 */
const storageValueCap = 4096;

interface CapturedBuffer {
    id?: number;
    label?: string;
    size?: number;
    usage?: number;
    writes?: Array<{ data?: string } | string>;
    mappedWrites?: Array<{ data?: string }>;
}

function lastWrite(buffer: CapturedBuffer): Buffer | undefined {
    const writes = buffer.writes ?? [];
    for (let index = writes.length - 1; index >= 0; index -= 1) {
        const write = writes[index];
        const base64 = typeof write === "string" ? write : write?.data;
        if (base64) return Buffer.from(base64, "base64");
    }
    // A buffer filled through `mappedAtCreation` never reaches
    // `writeBuffer`, so its only bytes are the mapped range.
    for (const write of buffer.mappedWrites ?? []) {
        if (write.data) return Buffer.from(write.data, "base64");
    }
    return undefined;
}

function wgslSize(type: string): number | undefined {
    if (/^(f32|i32|u32)$/.test(type)) return 4;
    const vector = /^vec([234])</.exec(type);
    if (vector) return Number(vector[1]) * 4;
    const matrix = /^mat([234])x([234])</.exec(type);
    if (matrix) {
        const rows = Number(matrix[2]);
        return Number(matrix[1]) * (rows === 3 ? 16 : rows * 4);
    }
    const array = /^array<(.+),\s*(\d+)u?>$/.exec(type);
    if (array) {
        const element = wgslSize(array[1]!.trim());
        if (element === undefined) return undefined;
        return Math.ceil(element / 16) * 16 * Number(array[2]);
    }
    return undefined;
}

function wgslAlign(type: string): number | undefined {
    if (/^(f32|i32|u32)$/.test(type)) return 4;
    const vector = /^vec([234])</.exec(type);
    if (vector) return Number(vector[1]) === 3 ? 16 : Number(vector[1]) * 4;
    if (/^mat/.test(type) || /^array</.test(type)) return 16;
    return undefined;
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
    captureDirectory: string,
): UniformField[] {
    const buffersPath = join(captureDirectory, "buffers.json");
    if (!existsSync(buffersPath)) {
        throw new Error(
            `No browser capture at ${buffersPath}. Run 'scene -- capture <id>' first.`,
        );
    }
    const structs: WgslStruct[] = [];
    const shaderDirectory = join(captureDirectory, "shaders");
    if (existsSync(shaderDirectory)) {
        for (const name of readdirSync(shaderDirectory)) {
            if (!name.endsWith(".wgsl")) continue;
            structs.push(
                ...parseWgslStructs(
                    readFileSync(join(shaderDirectory, name), "utf8"),
                    name,
                ),
            );
        }
    }
    const buffers = JSON.parse(
        readFileSync(buffersPath, "utf8"),
    ) as CapturedBuffer[];
    const fields: UniformField[] = [];
    const seen = new Set<string>();
    for (const buffer of buffers) {
        const usage = buffer.usage ?? 0;
        const uniform = (usage & uniformUsage) !== 0;
        const storage =
            (usage & storageUsage) !== 0 &&
            (buffer.size ?? 0) <= storageValueCap;
        if (!uniform && !storage) continue;
        const bytes = lastWrite(buffer);
        if (!bytes) continue;
        const size = buffer.size ?? bytes.length;
        const matching = structs.filter((struct) => struct.size === size);
        if (matching.length === 0) {
            for (let offset = 0; offset + 16 <= bytes.length; offset += 16) {
                fields.push({
                    name: `buffer#${buffer.id ?? "?"}[${offset / 4}]`,
                    values: [0, 1, 2, 3].map((lane) =>
                        bytes.readFloatLE(offset + lane * 4),
                    ),
                });
            }
            continue;
        }
        for (const struct of matching) {
            let offset = 0;
            for (const field of struct.fields) {
                const width = wgslSize(field.type);
                const align = wgslAlign(field.type);
                if (width === undefined || align === undefined) break;
                offset = Math.ceil(offset / align) * align;
                const values: number[] = [];
                for (
                    let lane = 0;
                    lane * 4 < width && offset + lane * 4 + 4 <= bytes.length;
                    lane += 1
                ) {
                    values.push(bytes.readFloatLE(offset + lane * 4));
                }
                offset += width;
                const name = `buffer#${buffer.id ?? "?"} ${field.name}`;
                const signature = `${name}|${values.join(",")}`;
                if (seen.has(signature)) continue;
                seen.add(signature);
                fields.push({ name, values });
            }
        }
    }
    return fields;
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
    const path = join(captureDirectory, "draws.json");
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
    const browser = browserUniformFields(captureDirectory);
    const headerPath = join(
        generatedDirectory,
        "upstream",
        "include",
        "bblite",
        "upstream",
        "renderer_plan.hpp",
    );
    const layouts = existsSync(headerPath)
        ? parseCppUniformStructs(readFileSync(headerPath, "utf8"))
        : new Map<string, Array<{ name: string; floats: number }>>();

    const blocks: NativeUniformBlock[] = [
        ...(capture.draws ?? []).flatMap((draw) => draw.uniforms ?? []),
        ...(capture.backgroundUniforms ?? []),
    ];
    const native: UniformField[] = [];
    const seenField = new Set<string>();
    for (const block of blocks) {
        for (const field of nativeFields(block, layouts)) {
            // One row per distinct payload: a scene draws the same
            // material many times, and repeating an identical field
            // buries the one that differs.
            const signature = `${field.name}|${field.values.join(",")}`;
            if (seenField.has(signature)) continue;
            seenField.add(signature);
            native.push(field);
        }
    }

    const correspondences = correspond(native, browser);
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

    const shaderDirectory = join(captureDirectory, "shaders");
    const browserModules = existsSync(shaderDirectory)
        ? readdirSync(shaderDirectory).filter((name) => name.endsWith(".wgsl"))
        : [];
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

    const findings: string[] = [];
    if (draws.onlyInNative.length > 0 || draws.onlyInBrowser.length > 0) {
        findings.push(
            `Draw shapes differ: ${draws.onlyInNative.length} native-only, ${draws.onlyInBrowser.length} browser-only ` +
                `(index x instance counts). A different set of draws explains every uniform and pixel difference below it — settle this first.`,
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
    if (findings.length === 0) {
        findings.push(
            "Every native uniform value appears in the browser's uploads and the draw shapes agree. " +
                "A residual that survives this is in the shading, the rasterization, or a texture payload — " +
                "compare the composed shaders under artifacts/capture/<id>/shaders next.",
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
        shaders: {
            browserModules,
            nativeShaders: nativeShaderFiles,
            browserSampleCalls: [
                ...new Set(
                    browserModules.flatMap((name) =>
                        sampleCalls(
                            readFileSync(join(shaderDirectory, name), "utf8"),
                        ),
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
