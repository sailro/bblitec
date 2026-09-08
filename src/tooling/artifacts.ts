/**
 * Shared backend and artifact conventions.
 *
 * Every scene subcommand selects its backend through `resolveBackend`,
 * names its per-backend artifacts through `backendFileToken`, and pairs
 * its capture files through the path helpers here. They live in one
 * module because each drifted when copied: the same backend was spelled
 * `gpu` in parity artifacts and `sdl_gpu` in capture artifacts, and a
 * reader and a writer disagreeing on one filename fails as "no capture".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedFlags } from "./flags.js";

/**
 * Every backend a measured run can select. One list, because a command
 * that accepted a different set would be measuring something the others
 * cannot.
 */
export const NATIVE_BACKENDS = ["sdl_gpu", "dawn"] as const;

export type NativeBackend = (typeof NATIVE_BACKENDS)[number];

/**
 * A `--backend` value in canonical spelling. Values are `sdl_gpu|dawn`;
 * `gpu` is accepted as an input alias for `sdl_gpu` because that is the
 * token the parity artifacts carry.
 */
export function canonicalBackend(value: string, command: string): NativeBackend {
    const canonical = value === "gpu" ? "sdl_gpu" : value;
    if (!(NATIVE_BACKENDS as readonly string[]).includes(canonical)) {
        throw new Error(
            `${command}: --backend must be ${NATIVE_BACKENDS.join("|")} (got '${value}').`,
        );
    }
    return canonical as NativeBackend;
}

/**
 * The backend a run measures: an explicit `--backend` wins, the ambient
 * `BBLITE_GPU_BACKEND` variable is the fallback, SDL_GPU is the default.
 * An explicit flag that disagrees with the ambient variable says so,
 * because a run that silently ignored either one measures the wrong
 * backend with full confidence.
 */
export function resolveBackend(
    explicit: string | undefined,
    command: string,
): NativeBackend {
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

/** The optional `--backend` of a measuring command, canonicalized. */
export function optionalBackend(
    parsed: ParsedFlags,
    command: string,
): NativeBackend | undefined {
    const explicit = parsed.values.get("--backend");
    return explicit === undefined
        ? undefined
        : canonicalBackend(explicit, command);
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
 * Where `scene -- capture <id>` lands unless `--capture` (or an
 * `outputDirectory` option) points elsewhere. The browser half, the
 * native half, `scene -- diff`, `scene -- uniforms` and
 * `scene -- compose` all pair through this one directory.
 */
export function defaultCaptureDirectory(sceneId: string): string {
    return join("artifacts", "capture", sceneId);
}

/** Where `scene -- check <id>` and `scene -- observe <id>` land. */
export function defaultCheckDirectory(sceneId: string): string {
    return join("artifacts", "check", sceneId);
}

/**
 * The fixed names inside a capture directory that the instrumented
 * browser capture writes and the diff/uniforms readers pair on.
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
    /**
     * The pinned package the browser rendered through, as
     * `<version>@<sourceVersion>`.
     *
     * `moduleSha256` covers the module the HARNESS serves, not the
     * package behind it, so it does not move when only the pin does —
     * except for the scenes whose asset URLs embed the commit. A capture
     * taken through a previous pin would otherwise read as current while
     * holding that package's shader text. Absent on a pre-pin capture,
     * which reads as unknown and forces a recapture.
     */
    pin?: string;
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
 * the `scene -- diff` reader.
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

/** The canvas-only lane's report, beside its PNGs under
 *  `artifacts/parity-canvas/<id>/`; one file holds both backends. */
export function parityCanvasReportPath(canvasDirectory: string): string {
    return resolve(canvasDirectory, "report-canvas.json");
}
