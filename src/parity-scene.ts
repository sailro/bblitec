#!/usr/bin/env node

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { captureSuiteReference } from "./capture-suite-reference.js";
import type { RenderItemSpecialization } from "./asset-specializer.js";
import {
    comparePayload,
    deployedPayloads,
    computeBuildStamp,
} from "./build-stamp.js";
import {
    isRegisteredScene,
    resolveScene,
    type SceneDefinition,
    type SceneParityDefinition,
} from "./scene-registry.js";
import {
    analyzeDifference,
    analyzeIdBuffer,
    compareImages,
    compareRegion,
    generateDiffMap,
    generateHotspotMap,
    generateIdVisualization,
    imageDimensions,
} from "./parity.js";

/**
 * The generated manifest records the deterministic-seeded-random adaptation
 * whenever the compiled scene reached Math.random; the browser reference
 * must then install the pinned seeded generator before module load. Every
 * browser capture of a compiled scene reads this — the parity reference,
 * the instrumented capture and the geometry diagnostics — so a seeded
 * scene renders the same particle set on all of them.
 */
export function usesSeededRandom(scene: SceneDefinition): boolean {
    const manifestPath = resolve(
        scene.output,
        "manifest.json",
    );
    if (!existsSync(manifestPath)) {
        return false;
    }
    try {
        const manifest: unknown = JSON.parse(
            readFileSync(manifestPath, "utf8"),
        );
        if (
            typeof manifest !== "object" ||
            manifest === null
        ) {
            return false;
        }
        const adaptations = (
            manifest as {
                adaptations?: Array<{ id?: string }>;
            }
        ).adaptations;
        return (
            Array.isArray(adaptations) &&
            adaptations.some(
                (adaptation) =>
                    adaptation.id ===
                    "deterministic-seeded-random",
            )
        );
    } catch {
        return false;
    }
}


interface GltfSpecialization {
    renderItems: RenderItemSpecialization[];
}

// ---------------------------------------------------------------------------
// Shared command-line and artifact conventions
//
// Every scene subcommand parses its arguments through `parseFlags`, selects
// its backend through `resolveBackend`, names its per-backend artifacts
// through `backendFileToken`, and writes its JSON reports through
// `writeReport`. These live here rather than per command because each of
// them drifted when copied: four hand-rolled parsers disagreed on whether
// an unknown flag was an error, and the same backend was spelled `gpu` in
// parity artifacts and `sdl_gpu` in capture artifacts.
// ---------------------------------------------------------------------------

export interface FlagSpec {
    /** Flags that take a value, e.g. `--backend dawn`. */
    value?: readonly string[];
    /** Flags that stand alone, e.g. `--recapture`. */
    boolean?: readonly string[];
    /** Alternate spellings, alias -> canonical flag. */
    alias?: Readonly<Record<string, string>>;
    /** How many bare (non `--`) arguments are accepted. Default none. */
    positionals?: number;
}

export interface ParsedFlags {
    values: Map<string, string>;
    flags: Set<string>;
    positionals: string[];
}

/**
 * The one strict argument parser every scene subcommand shares.
 *
 * Strict because the lenient alternative was measured in afternoons: a
 * mistyped flag that is silently dropped runs the tool with defaults and
 * produces a plausible answer to a question nobody asked
 * (`diff --recapture-reference` was a silent no-op). An unknown argument
 * is an error that names the valid set.
 */
export function parseFlags(
    rest: readonly string[],
    spec: FlagSpec,
    command: string,
): ParsedFlags {
    const parsed: ParsedFlags = {
        values: new Map(),
        flags: new Set(),
        positionals: [],
    };
    const known = [
        ...(spec.value ?? []),
        ...(spec.boolean ?? []),
        ...Object.keys(spec.alias ?? {}),
    ];
    for (let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if (argument === undefined || argument === "") continue;
        if (!argument.startsWith("--")) {
            if (parsed.positionals.length >= (spec.positionals ?? 0)) {
                throw new Error(
                    `Unexpected ${command} argument '${argument}'.`,
                );
            }
            parsed.positionals.push(argument);
            continue;
        }
        const name = spec.alias?.[argument] ?? argument;
        if (spec.value?.includes(name)) {
            const value = rest[index + 1];
            if (value === undefined) {
                throw new Error(
                    `${command}: ${argument} requires a value.`,
                );
            }
            index += 1;
            parsed.values.set(name, value);
            continue;
        }
        if (spec.boolean?.includes(name)) {
            parsed.flags.add(name);
            continue;
        }
        throw new Error(
            known.length > 0
                ? `Unknown ${command} argument '${argument}'. Valid flags: ${known.join(", ")}.`
                : `Unknown ${command} argument '${argument}'; ${command} takes no flags.`,
        );
    }
    return parsed;
}

/** A numeric flag value, rejected loudly when it does not parse. */
export function flagNumber(
    parsed: ParsedFlags,
    name: string,
    command: string,
): number | undefined {
    const value = parsed.values.get(name);
    if (value === undefined) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(
            `${command}: ${name} must be a number (got '${value}').`,
        );
    }
    return numeric;
}

/**
 * Every backend a measured run can select. One list, because a command
 * that accepted a different set would be measuring something the others
 * cannot -- which is how `--backend cpu` outlived the renderer behind it.
 */
export const NATIVE_BACKENDS = ["sdl_gpu", "dawn"] as const;

/**
 * A `--backend` value in canonical spelling. Values are `sdl_gpu|dawn`;
 * `gpu` is accepted as an input alias for `sdl_gpu` because that is the
 * token the parity artifacts have always used.
 */
export function canonicalBackend(value: string, command: string): string {
    const canonical = value === "gpu" ? "sdl_gpu" : value;
    if (!(NATIVE_BACKENDS as readonly string[]).includes(canonical)) {
        throw new Error(
            `${command}: --backend must be ${NATIVE_BACKENDS.join("|")} (got '${value}').`,
        );
    }
    return canonical;
}

/**
 * The backend a run measures: an explicit `--backend` wins, the ambient
 * `BBLITE_GPU_BACKEND` variable is the fallback, SDL_GPU is the default.
 * An explicit flag that disagrees with the ambient variable says so,
 * because a run that silently ignored either one is how the wrong backend
 * used to get measured with full confidence
 * (`BBLITE_GPU_BACKEND=dawn scene -- diff` measured sdl_gpu).
 */
export function resolveBackend(
    explicit: string | undefined,
    command: string,
): string {
    const ambient = process.env.BBLITE_GPU_BACKEND;
    const ambientBackend =
        ambient === undefined
            ? undefined
            : ambient === "dawn"
              ? "dawn"
              : "sdl_gpu";
    if (explicit === undefined) {
        return ambientBackend ?? "sdl_gpu";
    }
    const canonical = canonicalBackend(explicit, command);
    if (ambientBackend !== undefined && ambientBackend !== canonical) {
        console.warn(
            `--backend ${canonical} overrides ambient BBLITE_GPU_BACKEND=${ambient} for this run.`,
        );
    }
    return canonical;
}

/**
 * The token a backend spells in artifact *filenames*: `gpu` for SDL_GPU,
 * for continuity with the parity artifacts that predate the second
 * backend (`report-gpu.json`, `diff-map-gpu.png`); `dawn` is itself.
 * `--backend` values stay the unambiguous `sdl_gpu|dawn`.
 */
export function backendFileToken(backend: string): string {
    return backend === "sdl_gpu" ? "gpu" : backend;
}

/**
 * Where `scene -- capture <id>` lands unless `--capture` (or an
 * `outputDirectory` option) points elsewhere. The browser half, the
 * native half, `scene -- diff`, `scene -- uniforms` and
 * `scene -- compose` all pair through this one directory, so its
 * spelling lives here rather than at each of them.
 */
export function defaultCaptureDirectory(sceneId: string): string {
    return join("artifacts", "capture", sceneId);
}

/**
 * The fixed names inside a capture directory that the instrumented
 * browser capture writes and the diff/uniforms readers pair on. A reader
 * and the writer disagreeing on one of these fails as "no capture", so
 * each name is spelled once.
 */
export function captureBuffersPath(captureDirectory: string): string {
    return join(captureDirectory, "buffers.json");
}

export function captureDrawsPath(captureDirectory: string): string {
    return join(captureDirectory, "draws.json");
}

export function captureShadersDirectory(captureDirectory: string): string {
    return join(captureDirectory, "shaders");
}

/** Seek provenance for the browser capture's reuse path (`null` means
 *  captured with no seek; a missing file reads as unknown). */
export function captureMetaPath(captureDirectory: string): string {
    return join(captureDirectory, "capture-meta.json");
}

/**
 * The browser capture's provenance sidecar, beyond the seek: which scene
 * module was served (`suiteBrowserModuleDigest`), whether the hooked
 * render stayed byte-identical to the committed golden, and whether a
 * draw filter perturbed the capture. The instrumented capture writes it;
 * the reuse paths (`diff`, `compose`, `uniforms`) read it and refuse
 * evidence that no longer describes the current scene.
 */
export interface CaptureMeta {
    /** `null` = captured with no seek. */
    seekSeconds: number | null;
    /** sha256 of the served browser module; absent on pre-digest
     *  captures, which reads as unknown and forces a recapture. */
    moduleSha256?: string;
    /** The byte-identity verdict against the committed golden.
     *  `"not-checked"` = no golden on disk, or a filtered capture. */
    goldenIdentity?: "identical" | "differs" | "not-checked";
    /** The `--skip-draw` filter the capture ran under, when any: a
     *  filtered capture is an experiment, not reusable evidence. */
    drawFilter?: number;
}

/**
 * Writes a capture's provenance sidecar, so a reuse path can tell
 * whether the directory describes the pose — and, for the browser half,
 * the scene module — it is about to be read as evidence. `undefined`
 * seek is recorded as `null` — captured with no seek. One writer for
 * both capture halves (the native half records the seek alone), one
 * reader family below, so the JSON shape cannot drift between them.
 */
export function writeSeekMeta(
    path: string,
    seekSeconds: number | undefined,
    extras?: Omit<CaptureMeta, "seekSeconds">,
): void {
    writeFileSync(
        path,
        `${JSON.stringify({
            seekSeconds: seekSeconds ?? null,
            ...extras,
        })}\n`,
    );
}

/**
 * Reads the full provenance sidecar back. `undefined` = no sidecar or an
 * unreadable one, which reads as unknown and forces a recapture.
 */
export function readCaptureMeta(path: string): CaptureMeta | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as CaptureMeta;
        return { ...meta, seekSeconds: meta.seekSeconds ?? null };
    } catch {
        return undefined;
    }
}

/**
 * Reads a seek-provenance sidecar back. `null` = captured with no seek;
 * `undefined` = no provenance (a pre-meta or unreadable capture), which
 * reads as unknown and forces a recapture.
 */
export function readSeekMeta(path: string): number | null | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as {
            seekSeconds?: number | null;
        };
        return meta.seekSeconds ?? null;
    } catch {
        return undefined;
    }
}

/** The browser capture's texture-upload record: raw texels for small
 *  uploads (bone palettes ride rgba32float rows), 4x4 samples for image
 *  copies. The writer is the instrumented capture's page script; the
 *  palette matching in `scene -- diff` is the reader. */
export function captureTextureUploadsPath(
    captureDirectory: string,
): string {
    return join(captureDirectory, "tex-uploads.json");
}

/**
 * The three files `scene -- capture <id> --native` writes for one
 * backend filename token — the render capture, the screenshot beside
 * it, and the seek-provenance sidecar — spelled once for the writer and
 * the `scene -- diff` reader, which used to keep matching
 * `native-<token>.*` literals apiece.
 */
export function captureNativePaths(
    captureDirectory: string,
    token: string,
): { capture: string; screenshot: string; meta: string } {
    return {
        capture: join(captureDirectory, `native-${token}.json`),
        screenshot: join(captureDirectory, `native-${token}.png`),
        meta: join(captureDirectory, `native-${token}.meta.json`),
    };
}

/** Where `capture --seek-bracket` lands a ±1-frame capture, beside the
 *  exact-seek capture it brackets. */
export function captureSeekBracketDirectory(
    captureDirectory: string,
    offsetFrames: -1 | 1,
): string {
    return join(
        captureDirectory,
        offsetFrames < 0 ? "seek-minus1" : "seek-plus1",
    );
}

/**
 * The three poses `capture --seek-bracket` renders: the exact seek and
 * one frame to either side, so a residual can be judged against the
 * scale of one frame of motion instead of against intuition
 * (docs/debugging.md rung 6). Refuses a plan it cannot mean: a scene
 * with no seek has no motion to bracket, and a seek within one frame of
 * zero would clamp the minus arm to a different step than the plus arm.
 */
export function seekBracketPlan(
    seekSeconds: number | undefined,
    frameRate: number,
): {
    seekSeconds: number;
    frameStep: number;
    minus: number;
    plus: number;
} {
    if (seekSeconds === undefined) {
        throw new Error(
            "capture: --seek-bracket needs a pose to bracket — pass --seek <t> or use a scene whose registry entry pins referenceTimeSeconds.",
        );
    }
    if (!Number.isFinite(frameRate) || frameRate <= 0) {
        throw new Error(
            `capture: --seek-bracket needs a positive frame rate (got ${frameRate}).`,
        );
    }
    const frameStep = 1 / frameRate;
    const minus = seekSeconds - frameStep;
    if (minus < 0) {
        throw new Error(
            `capture: --seek-bracket at ${seekSeconds}s cannot step one frame (${frameStep.toFixed(6)}s) back past zero.`,
        );
    }
    return {
        seekSeconds,
        frameStep,
        minus,
        plus: seekSeconds + frameStep,
    };
}

/**
 * The parity artifacts a backend's run leaves in its scene's parity
 * directory, by filename token (`backendFileToken`, plus
 * `differential` for the combined report). The differential run reads
 * the per-backend reports and native images back, so writer and reader
 * spell these names through one place.
 */
export function parityReportPath(
    outputDirectory: string,
    suffix: string,
): string {
    return resolve(outputDirectory, `report-${suffix}.json`);
}

export function parityNativeImagePath(
    outputDirectory: string,
    suffix: string,
): string {
    return resolve(outputDirectory, `native-${suffix}.png`);
}

/**
 * Point `BBLITE_GPU_BACKEND` at the resolved backend, for this process
 * and every native child it spawns. Deleting it for SDL_GPU matters as
 * much as setting it for Dawn: an ambient `dawn` would otherwise survive
 * into a run whose `--backend sdl_gpu` chose the other one.
 */
export function applyGpuBackendEnvironment(backend: string): void {
    if (backend === "dawn") {
        process.env.BBLITE_GPU_BACKEND = "dawn";
    } else {
        delete process.env.BBLITE_GPU_BACKEND;
    }
}

/**
 * Runs `body` with one environment variable set (or, for `undefined`,
 * deleted — deleting matters as much as setting: an ambient value would
 * otherwise survive into a run that chose otherwise), restoring the
 * previous state however the body ends. The body is awaited before the
 * restore, because restoring while spawned work is still running would
 * change the variable under it. The one copy of the save/set/restore
 * ceremony the scene tools kept re-spelling per variable.
 */
export async function withEnvironment<T>(
    name: string,
    value: string | undefined,
    body: () => Promise<T>,
): Promise<T> {
    const previous = process.env[name];
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
    try {
        return await body();
    } finally {
        if (previous === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = previous;
        }
    }
}

/**
 * `--gpu-debug`: the backend's own validation layer, plus the SDL
 * assertion-handler defusal without which a failed render pass hangs the
 * harness waiting on a prompt instead of naming itself. Scene 116's
 * "Failed to close command list" became "Store op is RESOLVE ... but
 * texture is not multisample" in one run once it could print.
 */
export function enableGpuDebug(): void {
    process.env.BBLITE_GPU_DEBUG = "1";
    process.env.SDL_ASSERT = "always_ignore";
}

/** A `--background r,g,b` value: three 0-255 integers, rejected loudly. */
export function parseRgbTriple(
    value: string,
    flag: string,
    command: string,
): [number, number, number] {
    const parts = value.split(",").map((part) => Number(part.trim()));
    if (
        parts.length !== 3 ||
        parts.some(
            (part) => !Number.isInteger(part) || part < 0 || part > 255,
        )
    ) {
        throw new Error(
            `${command}: ${flag} must be three 0-255 integers 'r,g,b' (got '${value}').`,
        );
    }
    return [parts[0]!, parts[1]!, parts[2]!];
}

export interface PngMeasurement {
    width: number;
    height: number;
    background: [number, number, number];
    backgroundSource: "explicit" | "top-left";
    /** Pixels whose RGB differs from the background, exactly. */
    pixels: number;
    /** Inclusive corners; absent when every pixel is background. */
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
    /** Per-channel means over the non-background pixels. */
    mean?: { red: number; green: number; blue: number };
}

/**
 * The non-background bounding box, pixel count and per-channel means of
 * one PNG — `scene -- measure`.
 *
 * The measure-the-PNG rule as a command: the twenty-line pngjs script
 * that turned "the sprites are in the wrong place" into "exactly 7200 px
 * at (640,180)-(719,269)", coordinates that invert through a vertex
 * shader where an eyeballing never does. Background matching is exact,
 * because "exactly" is the point — native renders clear to one solid
 * color. Browser goldens dither their background by design, so measure
 * the native PNG, or expect the dithered pixels to count as content.
 */
export function measurePng(
    path: string,
    background?: [number, number, number],
): PngMeasurement {
    const png = PNG.sync.read(readFileSync(path));
    const data = png.data;
    const resolved: [number, number, number] = background ?? [
        data[0]!,
        data[1]!,
        data[2]!,
    ];
    let pixels = 0;
    let minX = png.width;
    let minY = png.height;
    let maxX = -1;
    let maxY = -1;
    const sum = [0, 0, 0];
    for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
            const index = (y * png.width + x) * 4;
            if (
                data[index] === resolved[0] &&
                data[index + 1] === resolved[1] &&
                data[index + 2] === resolved[2]
            ) {
                continue;
            }
            pixels += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            sum[0]! += data[index]!;
            sum[1]! += data[index + 1]!;
            sum[2]! += data[index + 2]!;
        }
    }
    return {
        width: png.width,
        height: png.height,
        background: resolved,
        backgroundSource: background ? "explicit" : "top-left",
        pixels,
        ...(pixels > 0
            ? {
                  bounds: { minX, minY, maxX, maxY },
                  mean: {
                      red: sum[0]! / pixels,
                      green: sum[1]! / pixels,
                      blue: sum[2]! / pixels,
                  },
              }
            : {}),
    };
}

export function formatPngMeasurement(
    path: string,
    measurement: PngMeasurement,
): string {
    const lines = [
        `${path}: ${measurement.width}x${measurement.height}, ` +
            `background ${measurement.background.join(",")}` +
            (measurement.backgroundSource === "top-left"
                ? " (top-left pixel)"
                : ""),
    ];
    if (!measurement.bounds || !measurement.mean) {
        lines.push("Every pixel is the background color.");
        return lines.join("\n");
    }
    const { minX, minY, maxX, maxY } = measurement.bounds;
    lines.push(
        `${measurement.pixels} non-background px in ` +
            `(${minX},${minY})-(${maxX},${maxY}) ` +
            `(${maxX - minX + 1}x${maxY - minY + 1} box)`,
    );
    lines.push(
        `mean RGB over those pixels: ${measurement.mean.red.toFixed(2)}, ` +
            `${measurement.mean.green.toFixed(2)}, ` +
            `${measurement.mean.blue.toFixed(2)}`,
    );
    return lines.join("\n");
}

/**
 * Every JSON report the scene tools write goes through here, so each one
 * carries the same provenance: which tool wrote it, for which backend,
 * from which generated tree, and when. Fields are added, never renamed —
 * existing readers parse by key — and every added field is a string,
 * because `scene -- neutrality` flattens the numeric leaves of these
 * reports and a numeric timestamp would register as a moved cell.
 * Payload keys win a collision so a report's own fields never change.
 */
export function writeReport(
    path: string,
    meta: {
        tool: string;
        backend?: string;
        generatedDirectory?: string;
    },
    payload: object,
    indent = 2,
): void {
    const generatedStamp = ((): string | undefined => {
        if (!meta.generatedDirectory) return undefined;
        try {
            return computeBuildStamp(meta.generatedDirectory).stamp;
        } catch {
            return undefined;
        }
    })();
    writeFileSync(
        path,
        `${JSON.stringify(
            {
                tool: meta.tool,
                ...(meta.backend !== undefined
                    ? { backend: meta.backend }
                    : {}),
                ...(generatedStamp !== undefined
                    ? { generatedStamp }
                    : {}),
                writtenAt: new Date().toISOString(),
                ...payload,
            },
            null,
            indent,
        )}\n`,
    );
}

export interface ParityArguments {
    sceneId?: string;
    executable?: string;
    actual?: string;
    recaptureReference: boolean;
    noFail: boolean;
    differential: boolean;
    gpuDebug: boolean;
    /** Canonical explicit selection, `sdl_gpu|dawn`; ambient fallback
     *  is applied later by `resolveBackend`. */
    backend?: string;
    seekSeconds?: number;
    /** `--without ground|background`: re-run the native side with that
     *  element suppressed, against the unchanged golden — the bisection
     *  ordering experiment from docs/debugging.md, as a flag. */
    without?: "ground" | "background";
}

/** The native switch `--without` drives for each suppressible element. */
export function withoutVariable(
    without: "ground" | "background",
): "BBLITE_GROUND" | "BBLITE_BACKGROUND" {
    return without === "ground" ? "BBLITE_GROUND" : "BBLITE_BACKGROUND";
}

/**
 * The strict parity argument parser, shared by `scene -- parity` and
 * `runSceneParity` so validation happens once, up front, before any child
 * process or build-stamp check spends time on a flag combination that
 * cannot mean anything.
 */
export function parseParityArguments(rest: string[]): ParityArguments {
    const parsed = parseFlags(
        rest,
        {
            value: ["--exe", "--actual", "--backend", "--seek", "--without"],
            boolean: [
                "--recapture-reference",
                "--no-fail",
                "--differential",
                "--gpu-debug",
            ],
            positionals: 1,
        },
        "parity",
    );
    const explicit = parsed.values.get("--backend");
    const backend =
        explicit === undefined
            ? undefined
            : canonicalBackend(explicit, "parity");
    const sceneId = parsed.positionals[0];
    const executable = parsed.values.get("--exe");
    const actual = parsed.values.get("--actual");
    const seekSeconds = flagNumber(parsed, "--seek", "parity");
    const withoutValue = parsed.values.get("--without");
    if (
        withoutValue !== undefined &&
        withoutValue !== "ground" &&
        withoutValue !== "background"
    ) {
        throw new Error(
            `parity: --without must be ground|background (got '${withoutValue}').`,
        );
    }
    const without = withoutValue as "ground" | "background" | undefined;
    const result: ParityArguments = {
        ...(sceneId !== undefined ? { sceneId } : {}),
        ...(executable !== undefined ? { executable } : {}),
        ...(actual !== undefined ? { actual } : {}),
        recaptureReference: parsed.flags.has("--recapture-reference"),
        noFail: parsed.flags.has("--no-fail"),
        differential: parsed.flags.has("--differential"),
        gpuDebug: parsed.flags.has("--gpu-debug"),
        ...(backend !== undefined ? { backend } : {}),
        ...(seekSeconds !== undefined ? { seekSeconds } : {}),
        ...(without !== undefined ? { without } : {}),
    };
    if (result.differential) {
        // A differential run spawns one process per backend and forwards
        // only the differential flag, so every companion except
        // --gpu-debug would be silently dropped — refuse instead.
        if (result.recaptureReference) {
            throw new Error(
                "parity: --differential does not carry --recapture-reference. " +
                    "Capture the new golden first with 'scene -- parity <id> --recapture-reference', " +
                    "then run 'scene -- parity <id> --differential'.",
            );
        }
        const dropped = [
            ...(result.executable !== undefined ? ["--exe"] : []),
            ...(result.actual !== undefined ? ["--actual"] : []),
            ...(result.noFail ? ["--no-fail"] : []),
            ...(result.backend !== undefined ? ["--backend"] : []),
            ...(result.seekSeconds !== undefined ? ["--seek"] : []),
            ...(result.without !== undefined ? ["--without"] : []),
        ];
        if (dropped.length > 0) {
            throw new Error(
                `parity: --differential measures both GPU backends and accepts only --gpu-debug beside it; drop ${dropped.join(", ")} or run a plain parity for them.`,
            );
        }
    }
    if (result.without !== undefined) {
        // The suppression flags are read by the native GPU frame options,
        // and the experiment is native-versus-unchanged-golden; each of
        // these companions would quietly measure something else.
        if (result.actual !== undefined) {
            throw new Error(
                "parity: --actual supplies a pre-rendered image, so there is no native run for --without to suppress anything in.",
            );
        }
        if (result.recaptureReference) {
            throw new Error(
                "parity: --without suppresses the element natively only; the golden keeps it. " +
                    "Recapture a stale golden in a separate plain run first.",
            );
        }
    }
    return result;
}

export function defaultExecutable(buildDirectory: string): string {
    const name = process.platform === "win32"
        ? "bblite_native.exe"
        : "bblite_native";
    const candidates = [
        resolve(buildDirectory, name),
        resolve(buildDirectory, "Release", name),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * The native executable a measured run spawns: an explicit `--exe` wins,
 * the ambient `BBLITE_NATIVE_EXE` override is the fallback, then the
 * scene's own Release build. One resolver, because `geometry` ignored
 * both overrides for as long as each command spelled its own chain.
 */
export function resolveNativeExecutable(
    explicit: string | undefined,
    buildDirectory: string,
): string {
    return resolve(
        explicit ??
            process.env.BBLITE_NATIVE_EXE ??
            defaultExecutable(buildDirectory),
    );
}

/**
 * Refuse a measurement taken from a stale build.
 *
 * The executable reports the digest of the sources it was compiled from,
 * and its shader and asset payload is copied beside it after every
 * successful build. Comparing both against the generated tree catches the
 * three ways a run can measure something other than the current inputs: a
 * build that never ran, a shader step that failed without stopping the
 * build, and a deployment that never happened.
 */
export function verifyDeployedPayload(
    executable: string,
    generatedDirectory: string,
): void {
    // BBLITE_ASSET_DIR and BBLITE_GPU_SHADER_DIR redirect the runtime
    // lookup, so the deployment beside the executable is only the payload
    // when neither override is active.
    const executableDirectory = resolve(executable, "..");
    const overridden: Readonly<Record<string, string | undefined>> = {
        shaders: process.env.BBLITE_GPU_SHADER_DIR,
        assets: process.env.BBLITE_ASSET_DIR,
    };
    const payloads = deployedPayloads(
        executableDirectory,
        generatedDirectory,
    ).filter((payload) => !overridden[payload.label]);
    for (const { label, source, deployed } of payloads) {
        const mismatches = comparePayload(source, deployed);
        if (mismatches.length > 0) {
            const detail = mismatches
                .slice(0, 5)
                .map(
                    (mismatch) =>
                        `${mismatch.path} (${mismatch.reason})`,
                )
                .join(", ");
            throw new Error(
                `Stale ${label} beside ${executable}: ${mismatches.length} file(s) differ from ${source} ` +
                    `[${detail}]. Run 'scene -- process' before measuring.`,
            );
        }
    }
}

export function verifyBuildIdentity(
    executable: string,
    generatedDirectory: string,
    reportedStampPath: string,
): void {
    const expected = computeBuildStamp(generatedDirectory).stamp;
    if (!existsSync(reportedStampPath)) {
        throw new Error(
            `The native executable did not report a build stamp. Rebuild it with 'scene -- process' so it carries one: ${executable}`,
        );
    }
    const reported = readFileSync(
        reportedStampPath,
        "utf8",
    ).trim();
    if (reported !== expected) {
        throw new Error(
            `Stale native build: ${executable} was built from different sources ` +
                `(reports ${reported.slice(0, 12)}, generated tree is ${expected.slice(0, 12)}). ` +
                `Run 'scene -- process' before measuring.`,
        );
    }
}

/**
 * The one measured-run spawn: npm_* environment hygiene, the synchronous
 * child, and the exit contract, shared by the parity runner and the native
 * capture so the ceremony cannot drift between them. `dropVariables` scrubs
 * ambient variables a caller sets explicitly (the capture drops
 * `BBLITE_GPU_BACKEND` so an ambient one cannot silently pick the other
 * backend).
 */
export function spawnNativeMeasured(
    executable: string,
    overrides: Record<string, string>,
    dropVariables: readonly string[] = [],
): void {
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (name.toLowerCase().startsWith("npm_")) continue;
        if (dropVariables.includes(name)) continue;
        inherited[name] = value;
    }
    const result = spawnSync(resolve(executable), [], {
        stdio: "inherit",
        windowsHide: true,
        env: { ...inherited, ...overrides },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Native renderer exited with status ${result.status}.`);
    }
}

/**
 * A measured capture must run through the requested screenshot frame. The
 * frame number is zero-based, so frame 10 needs an eleven-frame budget.
 */
export function nativeCaptureFrameBudget(
    nativeEnvironment?: Record<string, string>,
): number {
    const screenshotFrame = Number.parseInt(
        nativeEnvironment?.BBLITE_SCREENSHOT_FRAME ?? "0",
        10,
    );
    return Number.isFinite(screenshotFrame) && screenshotFrame >= 0
        ? screenshotFrame + 1
        : 1;
}

export function runNative(
    executable: string,
    screenshot: string,
    nativeEnvironment?: Record<string, string>,
    idBufferPath?: string,
    clusterBufferPath?: string,
    generatedDirectory?: string,
): void {
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Build the scene Release target first.`,
        );
    }
    if (generatedDirectory) {
        // Before spending a run: a payload that never deployed would
        // otherwise surface as a driver error from the previous binaries.
        verifyDeployedPayload(executable, generatedDirectory);
    }
    mkdirSync(resolve(screenshot, ".."), { recursive: true });
    const maxFrames = nativeCaptureFrameBudget(nativeEnvironment);
    spawnNativeMeasured(executable, {
        ...nativeEnvironment,
        ...(idBufferPath
            ? { BBLITE_ID_BUFFER: resolve(idBufferPath) }
            : {}),
        ...(clusterBufferPath
            ? { BBLITE_CLUSTER_BUFFER: resolve(clusterBufferPath) }
            : {}),
        BBLITE_MAX_FRAMES: String(maxFrames),
        BBLITE_SCREENSHOT: resolve(screenshot),
        BBLITE_TEST_PASS: "1",
        ...(generatedDirectory
            ? {
                  BBLITE_BUILD_STAMP_OUT: resolve(
                      `${screenshot}.build-stamp`,
                  ),
              }
            : {}),
    });
    if (generatedDirectory) {
        verifyBuildIdentity(
            executable,
            generatedDirectory,
            resolve(`${screenshot}.build-stamp`),
        );
    }
}

export function validateReferenceCapture(
    scene: SceneDefinition,
    reference: string,
    recaptureReference: boolean,
): void {
    if (
        isRegisteredScene(scene) &&
        !existsSync(reference) &&
        !recaptureReference
    ) {
        throw new Error(
            `Curated reference is missing: ${reference}. Use --recapture-reference only for an intentional reference update.`,
        );
    }
}

/** Preserve an ad-hoc scene's source path when a parity operation fans out.
 * Its derived id is an output name, not a registry key that can resolve the
 * scene in the child operation. */
export function paritySceneTarget(scene: SceneDefinition): string {
    return isRegisteredScene(scene) ? scene.id : scene.source;
}

export function resolveParityThresholds(
    config: SceneParityDefinition,
    backend: string,
): {
    maxMad: number | undefined;
    maxRegionMad: number | undefined;
    gate: "enforced" | "diagnostic-only";
} {
    if (backend === "dawn" && config.dawnThresholds) {
        return {
            maxMad: config.dawnThresholds.maxFullMad,
            maxRegionMad: config.dawnThresholds.maxForegroundMad,
            gate: "enforced",
        };
    }
    const enforced =
        config.maxFullMad !== undefined &&
        config.maxForegroundMad !== undefined;
    return {
        maxMad: config.maxFullMad,
        maxRegionMad: config.maxForegroundMad,
        gate: enforced ? "enforced" : "diagnostic-only",
    };
}

function percentage(count: number, total: number): number {
    return total > 0 ? count / total : 0;
}

export async function runSceneParity(
    inputArguments: string[],
): Promise<void> {
    const arguments_ = parseParityArguments(inputArguments);
    if (arguments_.differential) {
        throw new Error(
            "Run the differential through 'scene -- parity <id> --differential'.",
        );
    }
    if (arguments_.gpuDebug) enableGpuDebug();
    if (arguments_.sceneId === undefined) {
        throw new Error("parity requires a scene id or source path.");
    }
    const scene = resolveScene(arguments_.sceneId);
    const config = scene.parity;
    if (!config) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    const backend = resolveBackend(arguments_.backend, "parity");
    // The native child reads the backend from the environment, so the
    // resolved selection is applied there once; the thresholds and the
    // report labels take the value directly.
    applyGpuBackendEnvironment(backend);
    const reference = resolve(config.reference.path);
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    const without = arguments_.without;
    // Backend-suffixed artifacts keep every backend's outputs side by
    // side in the scene's parity directory ("gpu" stays the SDL_GPU
    // suffix for continuity). A suppression run appends its element so
    // the standard run's artifacts stay untouched beside it.
    const artifactSuffix =
        backendFileToken(backend) +
        (without !== undefined ? `-without-${without}` : "");
    const actual = resolve(
        arguments_.actual ??
            parityNativeImagePath(outputDirectory, artifactSuffix),
    );
    const seek = arguments_.seekSeconds;
    if (
        seek !== undefined &&
        existsSync(reference) &&
        !arguments_.recaptureReference
    ) {
        throw new Error(
            `parity: --seek ${seek} against the existing golden compares two different poses, which measures nothing. ` +
                "Add --recapture-reference to recapture the golden at this seek, or drop --seek to measure the registry pose.",
        );
    }
    // A run with an element suppressed is an attribution measurement:
    // its numbers are meant to move, so gating them against the registry
    // thresholds would fail the experiment for working.
    const thresholds =
        without !== undefined
            ? {
                  maxMad: undefined,
                  maxRegionMad: undefined,
                  gate: "diagnostic-only" as const,
              }
            : resolveParityThresholds(config, backend);
    const renderer = {
        implementation: backend === "dawn" ? "Dawn" : "SDL_GPU",
        driverSelection: process.env.SDL_GPU_DRIVER ?? "auto",
    };
    // A suppression run skips the attribution buffers: with the draw set
    // changed the ids would not line up with the specialization anyway.
    // The buffers carry the backend token like every other artifact —
    // they are documented byte-identical across backends, but a filename
    // must not claim a provenance the run did not have.
    const token = backendFileToken(backend);
    const idBufferPath = !without && config.attribution?.drawIds
        ? resolve(outputDirectory, `draw-ids-${token}.png`)
        : undefined;
    const idVisualizationPath = idBufferPath
        ? resolve(outputDirectory, `draw-ids-visual-${token}.png`)
        : undefined;
    const clusterBufferPath =
        !without && config.attribution?.triangleClusters
        ? resolve(outputDirectory, `triangle-clusters-${token}.png`)
        : undefined;
    const clusterVisualizationPath = clusterBufferPath
        ? resolve(outputDirectory, `triangle-clusters-visual-${token}.png`)
        : undefined;

    validateReferenceCapture(
        scene,
        reference,
        arguments_.recaptureReference,
    );
    await captureSuiteReference(
        scene.source,
        reference,
        arguments_.recaptureReference,
        undefined,
        seek ?? config.referenceTimeSeconds,
        config.referenceAnimationGroups,
        {
            seededRandom: usesSeededRandom(scene),
            ...(config.referenceFrame !== undefined
                ? { fixedAnimationFrame: config.referenceFrame }
                : {}),
            ...(config.referenceSearch !== undefined
                ? { search: config.referenceSearch }
                : {}),
        },
    );
    if (!arguments_.actual) {
        runNative(
            resolveNativeExecutable(
                arguments_.executable,
                scene.buildDirectory,
            ),
            actual,
            {
                ...config.nativeEnvironment,
                // The same pose on both sides: the browser capture above
                // seeks through the harness, the native run through its
                // deterministic clock.
                ...(seek !== undefined
                    ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
                    : {}),
                ...(without !== undefined
                    ? { [withoutVariable(without)]: "0" }
                    : {}),
            },
            idBufferPath,
            clusterBufferPath,
            resolve(scene.output),
        );
    }

    const actualDimensions = imageDimensions(actual);
    const referenceDimensions = imageDimensions(reference);
    if (
        actualDimensions.width !== referenceDimensions.width ||
        actualDimensions.height !== referenceDimensions.height
    ) {
        throw new Error(
            `Image dimensions differ: actual ${actualDimensions.width}x${actualDimensions.height}, ` +
                `reference ${referenceDimensions.width}x${referenceDimensions.height}.`,
        );
    }

    const full = compareImages(actual, reference);
    const region = compareRegion(actual, reference, config.backgroundColor, config.backgroundThreshold);
    const breakdown = analyzeDifference(
        actual,
        reference,
        config.backgroundColor,
        config.backgroundThreshold,
    );
    const idBreakdown =
        idBufferPath && existsSync(idBufferPath)
            ? analyzeIdBuffer(actual, reference, idBufferPath, breakdown.hotspots)
            : undefined;
    if (idBufferPath && idVisualizationPath && existsSync(idBufferPath)) {
        generateIdVisualization(idBufferPath, idVisualizationPath);
    }
    const specialization = config.attribution?.specialization;
    const specializations = specialization && existsSync(resolve(specialization))
        ? JSON.parse(readFileSync(resolve(specialization), "utf8")) as GltfSpecialization[]
        : [];
    const renderItems = new Map(
        specializations.flatMap((specialization) => specialization.renderItems)
            .map((item) => [item.drawId, item] as const),
    );
    const renderItemForCluster = (clusterId: number): RenderItemSpecialization | undefined =>
        specializations.flatMap((specialization) => specialization.renderItems)
            .find(
                (item) =>
                    item.clusterCount > 0 &&
                    clusterId >= item.clusterIdStart &&
                    clusterId < item.clusterIdStart + item.clusterCount,
            );
    const drawAttribution = idBreakdown?.draws.map((draw) => ({
        ...draw,
        renderItem: renderItems.get(draw.drawId),
    }));
    const hotspotAttribution = idBreakdown?.hotspots.map((hotspot) => ({
        ...hotspot,
        drawIds: hotspot.drawIds.map((draw) => ({
            ...draw,
            renderItem: renderItems.get(draw.drawId),
        })),
    }));
    const clusterBreakdown =
        clusterBufferPath && existsSync(clusterBufferPath)
            ? analyzeIdBuffer(actual, reference, clusterBufferPath, breakdown.hotspots)
            : undefined;
    if (
        clusterBufferPath &&
        clusterVisualizationPath &&
        existsSync(clusterBufferPath)
    ) {
        generateIdVisualization(clusterBufferPath, clusterVisualizationPath);
    }
    const clusterAttribution = clusterBreakdown?.draws.map((cluster) => {
        const renderItem = renderItemForCluster(cluster.drawId);
        return {
            clusterId: cluster.drawId,
            clusterIndex: renderItem
                ? cluster.drawId - renderItem.clusterIdStart
                : undefined,
            triangles: renderItem
                ? {
                      start:
                          (cluster.drawId - renderItem.clusterIdStart) *
                          renderItem.trianglesPerCluster,
                      count: Math.min(
                          renderItem.trianglesPerCluster,
                          renderItem.triangleCount -
                              (cluster.drawId - renderItem.clusterIdStart) *
                                  renderItem.trianglesPerCluster,
                      ),
                  }
                : undefined,
            pixels: cluster.pixels,
            mad: cluster.mad,
            maxDiff: cluster.maxDiff,
            bounds: cluster.bounds,
            renderItem,
        };
    });
    const hotspotClusterAttribution = clusterBreakdown?.hotspots.map((hotspot) => {
        const { drawIds, ...region } = hotspot;
        return {
            ...region,
            clusterIds: drawIds.map(({ drawId, pixels }) => ({
                clusterId: drawId,
                pixels,
                renderItem: renderItemForCluster(drawId),
            })),
        };
    });
    const diffPath = resolve(outputDirectory, `diff-map-${artifactSuffix}.png`);
    const hotspotPath = resolve(outputDirectory, `hotspots-${artifactSuffix}.png`);
    generateDiffMap(actual, reference, diffPath);
    generateHotspotMap(actual, breakdown.hotspots, hotspotPath);

    const report = {
        scene: scene.name,
        sourceOrigin:
            scene.sourceOrigin ?? "babylon-lite",
        renderer,
        ...(without !== undefined
            ? {
                  suppressed: {
                      feature: without,
                      variable: withoutVariable(without),
                  },
              }
            : {}),
        dimensions: actualDimensions,
        full,
        region,
        breakdown,
        ...(drawAttribution ? { drawAttribution } : {}),
        ...(hotspotAttribution ? { hotspotAttribution } : {}),
        ...(clusterAttribution ? { clusterAttribution } : {}),
        ...(hotspotClusterAttribution ? { hotspotClusterAttribution } : {}),
        ratios: {
            exact: percentage(region.exactMatch, region.regionPixels),
            within1: percentage(region.within1, region.regionPixels),
            within3: percentage(region.within3, region.regionPixels),
            within5: percentage(region.within5, region.regionPixels),
        },
        thresholds,
        files: {
            actual,
            reference,
            diff: diffPath,
            hotspots: hotspotPath,
            ...(idBufferPath && existsSync(idBufferPath) ? { drawIds: idBufferPath } : {}),
            ...(idVisualizationPath && existsSync(idVisualizationPath)
                ? { drawIdsVisual: idVisualizationPath }
                : {}),
            ...(clusterBufferPath && existsSync(clusterBufferPath)
                ? { triangleClusters: clusterBufferPath }
                : {}),
            ...(clusterVisualizationPath && existsSync(clusterVisualizationPath)
                ? { triangleClustersVisual: clusterVisualizationPath }
                : {}),
        },
    };
    const reportPath = parityReportPath(outputDirectory, artifactSuffix);
    writeReport(
        reportPath,
        {
            tool: "parity",
            backend,
            generatedDirectory: resolve(scene.output),
        },
        report,
    );

    console.log(
        `Renderer: ${renderer.implementation} (${renderer.driverSelection})`,
    );
    if (without !== undefined) {
        console.log(
            `Suppressed natively: ${without} (${withoutVariable(without)}=0), measured against the unchanged golden. ` +
                "This is the bisection ordering experiment, not a parity gate: compare its MAD to the full run's, " +
                "and the element whose removal makes the number worse is not the culprit (docs/debugging.md).",
        );
    } else if (thresholds.gate === "diagnostic-only") {
        console.warn(
            "Parity result is diagnostic-only because no thresholds are configured.",
        );
    }
    console.log(`${scene.name} full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, max=${full.maxDiff}`);
    console.log(
        `${scene.name} region (${region.regionPixels} px): MAD=${region.mad.toFixed(3)}, ` +
            `exact=${(report.ratios.exact * 100).toFixed(2)}%, ` +
            `within1=${(report.ratios.within1 * 100).toFixed(2)}%, ` +
            `within5=${(report.ratios.within5 * 100).toFixed(2)}%`,
    );
    if (drawAttribution?.length) {
        const worst = drawAttribution[0]!;
        const label =
            worst.renderItem?.materialName ??
            worst.renderItem?.meshName ??
            worst.renderItem?.nodeName ??
            `draw ${worst.drawId}`;
        console.log(
            `Worst draw: ${label} (id=${worst.drawId}, MAD=${worst.mad.toFixed(3)}, ` +
                `pixels=${worst.pixels})`,
        );
    }
    if (clusterAttribution?.length) {
        const worst = clusterAttribution[0]!;
        console.log(
            `Worst triangle cluster: id=${worst.clusterId}, ` +
                `triangles=${worst.triangles?.start ?? "?"}..` +
                `${
                    worst.triangles
                        ? worst.triangles.start + worst.triangles.count - 1
                        : "?"
                }, MAD=${worst.mad.toFixed(3)}`,
        );
    }
    console.log(
        `Diff attribution: background=${breakdown.regions.background.mad.toFixed(3)}, ` +
            `edges=${breakdown.regions.foregroundEdge.mad.toFixed(3)}, ` +
            `interior=${breakdown.regions.foregroundInterior.mad.toFixed(3)}`,
    );
    console.log(`Diff: ${diffPath}`);
    console.log(`Hotspots: ${hotspotPath}`);
    console.log(`Report: ${reportPath}`);

    const failures: string[] = [];
    if (thresholds.maxMad !== undefined && full.mad > thresholds.maxMad) {
        failures.push(`full MAD ${full.mad.toFixed(3)} > ${thresholds.maxMad}`);
    }
    if (
        thresholds.maxRegionMad !== undefined &&
        region.mad > thresholds.maxRegionMad
    ) {
        failures.push(`region MAD ${region.mad.toFixed(3)} > ${thresholds.maxRegionMad}`);
    }
    if (failures.length > 0) {
        const message = `Parity regression: ${failures.join(", ")}`;
        if (arguments_.noFail) console.warn(message);
        else throw new Error(message);
    }
}

// Renders both GPU backends through the standard gates, then diffs
// the two native images against each other — the project's decisive
// diagnostic (backend agreement to one LSB puts a divergence on the
// CPU side; disagreement puts it on the GPU side) — and writes the
// combined report beside the per-backend ones.
export async function runSceneParityDifferential(
    sceneIdOrSource: string,
): Promise<void> {
    const scene = resolveScene(sceneIdOrSource);
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    // Each backend run writes its own suffixed actual, so the two images
    // sit side by side without a copy step and neither run can overwrite
    // the other's.
    const sdlImage = parityNativeImagePath(outputDirectory, "gpu");
    const dawnImage = parityNativeImagePath(outputDirectory, "dawn");
    const sceneTarget = paritySceneTarget(scene);
    await withEnvironment("BBLITE_GPU_BACKEND", undefined, () =>
        runSceneParity([sceneTarget]),
    );
    await withEnvironment("BBLITE_GPU_BACKEND", "dawn", () =>
        runSceneParity([sceneTarget]),
    );
    const backendDelta = compareImages(sdlImage, dawnImage);
    const readBackendReport = (suffix: string): {
        full: { mad: number };
        region: { mad: number };
    } =>
        JSON.parse(
            readFileSync(
                parityReportPath(outputDirectory, suffix),
                "utf8",
            ),
        ) as { full: { mad: number }; region: { mad: number } };
    const sdlReport = readBackendReport("gpu");
    const dawnReport = readBackendReport("dawn");
    const report = {
        scene: scene.name,
        goldenVersusSdlGpu: {
            fullMad: sdlReport.full.mad,
            foregroundMad: sdlReport.region.mad,
        },
        goldenVersusDawn: {
            fullMad: dawnReport.full.mad,
            foregroundMad: dawnReport.region.mad,
        },
        sdlGpuVersusDawn: backendDelta,
    };
    const reportPath = parityReportPath(outputDirectory, "differential");
    writeReport(
        reportPath,
        {
            tool: "parity",
            backend: "both",
            generatedDirectory: resolve(scene.output),
        },
        report,
    );
    console.log(
        `Backend differential (${scene.name}): ` +
            `SDL_GPU ${sdlReport.full.mad.toFixed(3)}/${sdlReport.region.mad.toFixed(3)}, ` +
            `Dawn ${dawnReport.full.mad.toFixed(3)}/${dawnReport.region.mad.toFixed(3)}, ` +
            `SDL_GPU-vs-Dawn MAD=${backendDelta.mad.toFixed(3)} ` +
            `max=${backendDelta.maxDiff} ` +
            `within1=${(
                (backendDelta.within1 / backendDelta.totalPixels) *
                100
            ).toFixed(2)}%`,
    );
    console.log(`Report: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// `scene -- stability` — the run-to-run wobble check
//
// Scenes 9 and 37 render differently on Dawn from one run to the next
// with no code change at all, and that was found by re-running the same
// native render and comparing. This command is that check on demand,
// with its one trap built in: comparing runs only against each other
// hides a stable-but-wrong image, so every run is also compared against
// the golden and both columns always print.
// ---------------------------------------------------------------------------

export interface StabilityArguments {
    runs: number;
    singleSample: boolean;
    gpuDebug: boolean;
    backend?: string;
    /** Render every run at this pose instead of the registry's. At a
     *  pose other than the registry's the golden columns are suppressed:
     *  the golden holds the registry pose, so a cross-pose comparison
     *  measures nothing (the same refusal `parity --seek` makes). */
    seekSeconds?: number;
}

export function parseStabilityArguments(
    rest: readonly string[],
): StabilityArguments {
    const parsed = parseFlags(
        rest,
        {
            value: ["--runs", "--backend", "--seek"],
            boolean: ["--single-sample", "--gpu-debug"],
        },
        "stability",
    );
    const seekSeconds = flagNumber(parsed, "--seek", "stability");
    const runsValue = parsed.values.get("--runs");
    let runs = 5;
    if (runsValue !== undefined) {
        runs = Number(runsValue);
        if (!Number.isInteger(runs) || runs < 2) {
            throw new Error(
                `stability: --runs must be an integer >= 2 (got '${runsValue}').`,
            );
        }
    }
    const explicit = parsed.values.get("--backend");
    const backend =
        explicit === undefined
            ? undefined
            : canonicalBackend(explicit, "stability");
    return {
        runs,
        singleSample: parsed.flags.has("--single-sample"),
        gpuDebug: parsed.flags.has("--gpu-debug"),
        ...(backend !== undefined ? { backend } : {}),
        ...(seekSeconds !== undefined ? { seekSeconds } : {}),
    };
}

export interface StabilityRunComparison {
    /** 1-based run number; run 1 is the baseline the others compare to. */
    run: number;
    /** Absent for run 1. */
    vsFirst?: { mad: number; maxDiff: number };
    /** Absent at a seeked (non-registry) pose, where the golden is not
     *  comparable. */
    vsGolden?: { mad: number; maxDiff: number };
}

/**
 * The stability verdict as text. Both columns are always present —
 * run-to-run answers "is this the scenes 9/37 wobble class?", and the
 * golden column is printed beside it because runs that agree with each
 * other can still all be wrong, and only the golden catches a
 * stable-but-wrong image. Under `--single-sample` the golden column is
 * context only: the goldens are multisampled, so every scene reads worse
 * against them at one sample and that number means nothing on its own.
 */
export function formatStabilityReport(
    sceneName: string,
    backend: string,
    singleSample: boolean,
    runs: readonly StabilityRunComparison[],
    seekedPoseSeconds?: number,
): string {
    const lines: string[] = [];
    lines.push(
        `Stability: ${sceneName} (${backend}, ` +
            `${singleSample ? "single-sampled" : "multisampled"}` +
            (seekedPoseSeconds !== undefined
                ? `, seeked to ${seekedPoseSeconds}s`
                : "") +
            `), ${runs.length} runs`,
    );
    for (const entry of runs) {
        const golden = entry.vsGolden
            ? `vs golden MAD=${entry.vsGolden.mad.toFixed(3)} ` +
              `max=${entry.vsGolden.maxDiff}`
            : "";
        lines.push(
            entry.vsFirst === undefined
                ? `  run ${entry.run}: ${golden}${
                      golden ? "  " : ""
                  }(baseline for the run-to-run column)`
                : `  run ${entry.run}: vs run 1 MAD=${entry.vsFirst.mad.toFixed(3)} ` +
                      `max=${entry.vsFirst.maxDiff}${
                          golden ? `  |  ${golden}` : ""
                      }`,
        );
    }
    const wobbling = runs.filter(
        (entry) => entry.vsFirst !== undefined && entry.vsFirst.maxDiff > 0,
    );
    if (wobbling.length === 0) {
        lines.push(
            `Bit-stable: every run is byte-identical to run 1 across ${runs.length} runs.`,
        );
    } else {
        const worst = wobbling.reduce((left, right) =>
            (right.vsFirst?.mad ?? 0) > (left.vsFirst?.mad ?? 0)
                ? right
                : left,
        );
        lines.push(
            `Wobble: ${wobbling.length} of ${runs.length - 1} re-runs differ from run 1 ` +
                `(worst MAD ${worst.vsFirst?.mad.toFixed(6) ?? "?"}, max ${worst.vsFirst?.maxDiff ?? "?"}) — ` +
                "the scenes 9/37 class. Re-run with --single-sample to test whether multisampling is the mover.",
        );
    }
    const first = runs[0];
    if (seekedPoseSeconds !== undefined) {
        lines.push(
            `Seeked pose (${seekedPoseSeconds}s): golden columns suppressed — ` +
                "the golden holds the registry pose, so a cross-pose comparison " +
                "measures nothing. Only the run-to-run columns answer here.",
        );
    } else if (first?.vsGolden !== undefined) {
        if (singleSample) {
            lines.push(
                "Golden column is context only under --single-sample: the goldens are multisampled, " +
                    "so every scene reads worse against them at one sample (docs/debugging.md).",
            );
        } else if (
            wobbling.length === 0 &&
            first.vsGolden.maxDiff > 0
        ) {
            lines.push(
                `Stable but not golden: the runs agree with each other and differ from the golden ` +
                    `(MAD ${first.vsGolden.mad.toFixed(3)}) — run-to-run agreement alone would have hidden that; ` +
                    "the image is reproducibly wrong, not noisy.",
            );
        }
    }
    return lines.join("\n");
}

/**
 * Render the scene's native side `runs` times through the same gates as
 * a measured parity run, and compare every run against the first and
 * against the golden.
 */
export function runStabilityReport(
    idOrSource: string,
    stabilityArguments: StabilityArguments,
): void {
    if (stabilityArguments.gpuDebug) enableGpuDebug();
    const scene = resolveScene(idOrSource);
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const backend = resolveBackend(stabilityArguments.backend, "stability");
    applyGpuBackendEnvironment(backend);
    const reference = resolve(config.reference.path);
    // `--seek` at the registry pose is the standard measurement with the
    // pose written explicitly; any other pose suppresses the golden
    // columns — the golden holds the registry pose, so a cross-pose
    // comparison measures nothing (parity refuses the same pair).
    const seek = stabilityArguments.seekSeconds;
    const goldenComparable =
        seek === undefined || seek === config.referenceTimeSeconds;
    if (goldenComparable && !existsSync(reference)) {
        throw new Error(
            `Stability compares every run against the golden, and ${reference} does not exist. ` +
                "Capture it first ('scene -- parity <id> --recapture-reference' for an intentional update).",
        );
    }
    const outputDirectory = resolve(config.outputDirectory);
    const stabilityDirectory = resolve(outputDirectory, "stability");
    mkdirSync(stabilityDirectory, { recursive: true });
    const token = backendFileToken(backend);
    // Single-sample runs are a different measurement (BBLITE_MSAA=1), so
    // they keep their own filenames beside the multisampled ones; a
    // seeked pose likewise, so an experiment cannot overwrite the
    // registry-pose evidence.
    const modeSuffix =
        (stabilityArguments.singleSample ? "-single-sample" : "") +
        (!goldenComparable ? `-seek${seek}` : "");
    const executable = resolveNativeExecutable(
        undefined,
        scene.buildDirectory,
    );
    const comparisons: StabilityRunComparison[] = [];
    const images: string[] = [];
    const summarize = (result: {
        mad: number;
        maxDiff: number;
    }): { mad: number; maxDiff: number } => ({
        mad: result.mad,
        maxDiff: result.maxDiff,
    });
    for (let run = 1; run <= stabilityArguments.runs; run += 1) {
        const image = resolve(
            stabilityDirectory,
            `run${run}-${token}${modeSuffix}.png`,
        );
        // The same invocation as a measured parity run — environment,
        // build-identity and payload gates included — so a wobble found
        // here is a wobble the matrix would see.
        runNative(
            executable,
            image,
            {
                ...config.nativeEnvironment,
                // The explicit pose wins over the registry-derived one,
                // through the same variable the native clock reads.
                ...(seek !== undefined
                    ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
                    : {}),
                ...(stabilityArguments.singleSample
                    ? { BBLITE_MSAA: "1" }
                    : {}),
            },
            undefined,
            undefined,
            resolve(scene.output),
        );
        images.push(image);
        comparisons.push({
            run,
            ...(run > 1
                ? { vsFirst: summarize(compareImages(image, images[0]!)) }
                : {}),
            ...(goldenComparable
                ? { vsGolden: summarize(compareImages(image, reference)) }
                : {}),
        });
    }
    const reportPath = resolve(
        outputDirectory,
        `stability-${token}${modeSuffix}.json`,
    );
    writeReport(
        reportPath,
        {
            tool: "stability",
            backend,
            generatedDirectory: resolve(scene.output),
        },
        {
            scene: scene.name,
            runs: stabilityArguments.runs,
            singleSample: stabilityArguments.singleSample,
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            comparisons,
            files: {
                ...(goldenComparable ? { reference } : {}),
                runs: images,
            },
        },
    );
    console.log(
        formatStabilityReport(
            scene.name,
            backend,
            stabilityArguments.singleSample,
            comparisons,
            goldenComparable ? undefined : seek,
        ),
    );
    console.log(`Report: ${reportPath}`);
}
