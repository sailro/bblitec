/**
 * Shared backend, pose and artifact conventions.
 *
 * Every scene subcommand selects its backend through `resolveBackend`,
 * resolves its pose through `resolvePose`, names its per-backend artifacts
 * through `backendFileToken`, and writes below one of the `ARTIFACT_ROOTS`.
 * They live in one module because each drifted when copied: the same
 * backend was spelled `gpu` in parity artifacts and `sdl_gpu` in capture
 * artifacts, seek rules differed per command, and `clean --artifacts`
 * deleted directories its own list forgot.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { selectedCompiledBackend } from "../build-options.js";
import type { ParsedFlags } from "./flags.js";

/**
 * Every top-level entry under `artifacts/` a tool of this repository (or
 * the audit tooling beside it) writes or reads, with its writer. The one
 * list: writers name their directory through `artifactDirectory`, and
 * `clean --artifacts` deletes only entries this table does not name. A
 * name ending in `-` is a prefix family (`ios-vcpkg-min-<codecs>`).
 * `test/artifact-roots.test.ts` greps the sources for `artifacts/<name>`
 * and fails on a name missing here.
 */
export const ARTIFACT_ROOTS = [
    { name: ".scene-command.lock", owner: "dist lock (src/dist-lock.ts)" },
    { name: "android", owner: "tools/android.ps1, android:sweep" },
    { name: "android-vcpkg", owner: "tools/android.ps1 dependency install" },
    { name: "api-coverage", owner: "npm run api -- report" },
    { name: "bake-cache", owner: "generation bakes (src/bake-cache.ts)" },
    { name: "capture", owner: "scene -- capture/diff" },
    { name: "check", owner: "scene -- check" },
    { name: "code-quality", owner: "npm run lint:cpp" },
    { name: "generation-stamps", owner: "scene -- compile" },
    { name: "ios", owner: "tools/ios.ps1" },
    { name: "ios-vcpkg", owner: "tools/ios.ps1 dependency install" },
    { name: "ios-vcpkg-min-", owner: "tools/ios.ps1 trimmed installs" },
    { name: "memory", owner: "scene -- memory" },
    {
        name: "native-cache",
        owner: "native ccache (native/compiler-cache.cmake)",
    },
    { name: "neutrality", owner: "generated-tree neutrality runs" },
    { name: "parity", owner: "scene -- parity" },
    { name: "parity-attribution", owner: "scene -- parity --attribute" },
    { name: "parity-canvas", owner: "canvas-only parity lane" },
    { name: "physics-constructor-inputs", owner: "physics-viewer generation" },
    { name: "releases", owner: "demos:release, package:demo" },
    { name: "scene149-reference", owner: "input of check scene149-transport" },
    { name: "shader-cache", owner: "offline shader compilation" },
    { name: "shipping", owner: "demos:release plans and logs" },
    { name: "status", owner: "scene -- status --run" },
    { name: "survey", owner: "scene -- survey" },
    { name: "tools", owner: "pinned dependency builds" },
    { name: "vcpkg-installed", owner: "shared vcpkg installs" },
] as const;

type ArtifactRootName = (typeof ARTIFACT_ROOTS)[number]["name"];

/** Whether an `artifacts/` entry belongs to a tool (exact or prefix family). */
export function isOwnedArtifact(entry: string): boolean {
    return ARTIFACT_ROOTS.some((root) =>
        root.name.endsWith("-")
            ? entry.startsWith(root.name)
            : entry === root.name,
    );
}

/** `artifacts/<root>/<parts...>`, relative to the repository root. */
export function artifactDirectory(
    root: Exclude<ArtifactRootName, `${string}-`>,
    ...parts: string[]
): string {
    return join("artifacts", root, ...parts);
}

/**
 * Every backend a measured run can select. One list, because a command
 * that accepted a different set would be measuring something the others
 * cannot.
 */
export const NATIVE_BACKENDS = ["sdl_gpu", "dawn"] as const;

export type NativeBackend = (typeof NATIVE_BACKENDS)[number];

/** A native backend, or both of them. */
export type BackendSelection = NativeBackend | "both";

/**
 * The one backend-name parser. Case-insensitive, `-` and `_` alike, and
 * `gpu` accepted for `sdl_gpu` because that is the token the artifact
 * filenames carry; `both` only where the caller measures or builds both.
 * `source` names the flag or variable in the refusal.
 */
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: true,
): BackendSelection;
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: false,
): NativeBackend;
export function parseBackendName(
    value: string,
    source: string,
    allowBoth: boolean,
): BackendSelection {
    const normalized = value.toLowerCase().replaceAll("-", "_");
    const canonical = normalized === "gpu" ? "sdl_gpu" : normalized;
    if (canonical === "sdl_gpu" || canonical === "dawn") return canonical;
    if (allowBoth && canonical === "both") return canonical;
    throw new Error(
        `${source} must be sdl_gpu|dawn${allowBoth ? "|both" : ""} (got '${value}').`,
    );
}

/** A `--backend` value selecting one backend, in canonical spelling. */
export function canonicalBackend(
    value: string,
    command: string,
): NativeBackend {
    return parseBackendName(value, `${command}: --backend`, false);
}

/**
 * The ambient runtime selection. The native executable reads the variable
 * itself and accepts exactly `sdl_gpu` or `dawn`, so any other value is
 * refused here rather than coerced into a backend the run then measures
 * with full confidence. Empty means unset, as it does natively.
 */
function ambientGpuBackend(): NativeBackend | undefined {
    const ambient = process.env.BBLITE_GPU_BACKEND;
    if (ambient === undefined || ambient === "") return undefined;
    if (ambient === "sdl_gpu" || ambient === "dawn") return ambient;
    throw new Error(
        `BBLITE_GPU_BACKEND must be sdl_gpu or dawn (got '${ambient}').`,
    );
}

/**
 * The backend a single-backend run measures: an explicit `--backend` wins,
 * the ambient `BBLITE_GPU_BACKEND` variable is the fallback, SDL_GPU is the
 * default. An explicit flag that disagrees with the ambient variable says
 * so, because a run that silently ignored either one measures the wrong
 * backend with full confidence.
 */
export function resolveBackend(
    explicit: string | undefined,
    command: string,
): NativeBackend {
    const ambientBackend = ambientGpuBackend();
    if (explicit === undefined) {
        return ambientBackend ?? "sdl_gpu";
    }
    const canonical = canonicalBackend(explicit, command);
    if (ambientBackend !== undefined && ambientBackend !== canonical) {
        console.warn(
            `--backend ${canonical} overrides ambient BBLITE_GPU_BACKEND=${ambientBackend} for this run.`,
        );
    }
    return canonical;
}

/**
 * The backends a measuring command runs when it can run both: an explicit
 * `--backend` (`both` included), else the ambient `BBLITE_GPU_BACKEND`,
 * else every backend the development build compiles (`BBLITE_BACKEND`,
 * both by default).
 */
export function measuredBackends(
    explicit: string | undefined,
    command: string,
): NativeBackend[] {
    const selection =
        explicit !== undefined
            ? parseBackendName(explicit, `${command}: --backend`, true)
            : (ambientGpuBackend() ??
              ({ SDL_GPU: "sdl_gpu", DAWN: "dawn", BOTH: "both" } as const)[
                  selectedCompiledBackend()
              ]);
    return selection === "both" ? [...NATIVE_BACKENDS] : [selection];
}

/** The optional `--backend` of a single-backend command, canonicalized. */
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
 * The pose a scene tool renders and captures at: the explicit `--seek`,
 * else the registry's `referenceTimeSeconds`, else none. `golden` says
 * whether the committed golden holds that pose — an explicit seek equal to
 * the registry's is the standard measurement written out — so every tool
 * decides "comparable to the golden" by the same rule.
 */
export interface ScenePose {
    seekSeconds: number | undefined;
    golden: boolean;
}

export function resolvePose(
    scene: { parity?: { referenceTimeSeconds?: number } | undefined },
    explicitSeek: number | undefined,
): ScenePose {
    const registry = scene.parity?.referenceTimeSeconds;
    return {
        seekSeconds: explicitSeek ?? registry,
        golden: explicitSeek === undefined || explicitSeek === registry,
    };
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
 * native half and every `scene -- diff` reading (the pairing,
 * `--uniforms`, `--compose`) pair through this one directory.
 */
export function defaultCaptureDirectory(sceneId: string): string {
    return artifactDirectory("capture", sceneId);
}

/** Where `scene -- check <id>` and its `--observe` half land. */
export function defaultCheckDirectory(sceneId: string): string {
    return artifactDirectory("check", sceneId);
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
 * Why a browser capture's provenance sidecar does NOT describe the
 * evidence a reuse path wants, or `undefined` when it does. The one rule
 * every browser-evidence reuse path applies (`diff`, `diff --compose`,
 * `diff --uniforms`, `parity --geometry`), in the order the classes are
 * cheapest to check:
 *   - no sidecar (a pre-meta capture);
 *   - a draw filter (`--skip-draw`): a filtered capture is an experiment,
 *     not evidence;
 *   - a different pose than requested (`seekSeconds`, `null` = no seek;
 *     omit it to accept the capture's own pose);
 *   - no module or pin provenance, another pin, or a scene module that has
 *     since moved — `moduleSha256` recomputes the served module's digest at
 *     the capture's own pose, so a scene-source or pinned-package change
 *     refuses even when the pixels still look plausible.
 */
export function captureMetaStaleness(
    meta: CaptureMeta | undefined,
    want: {
        seekSeconds?: number | null;
        pin: string;
        moduleSha256: (seekSeconds: number | undefined) => string;
    },
): string | undefined {
    if (meta === undefined) {
        return "carries no provenance sidecar";
    }
    if (meta.drawFilter !== undefined) {
        return `was captured with a draw filter (--skip-draw ${meta.drawFilter})`;
    }
    if (
        "seekSeconds" in want &&
        meta.seekSeconds !== (want.seekSeconds ?? null)
    ) {
        return "was captured at a different seek";
    }
    if (meta.moduleSha256 === undefined) {
        return "carries no scene-module provenance";
    }
    // Checked separately from the module digest because it moves
    // separately; `CaptureMeta.pin` carries the reason.
    if (meta.pin === undefined) {
        return "carries no pinned-package provenance";
    }
    if (meta.pin !== want.pin) {
        return `was captured through ${meta.pin}, not the current pin`;
    }
    if (
        meta.moduleSha256 !== want.moduleSha256(meta.seekSeconds ?? undefined)
    ) {
        return "was captured from a different scene module (the scene source, pose, or pinned package moved)";
    }
    return undefined;
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
export function captureTextureUploadsPath(captureDirectory: string): string {
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
 * scale of one frame of motion instead of against intuition. Refuses a
 * plan it cannot mean: a scene
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
