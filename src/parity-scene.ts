#!/usr/bin/env node

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { captureSuiteReference } from "./capture-suite-reference.js";
import type { RenderItemSpecialization } from "./asset-specializer.js";
import {
    comparePayload,
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
 * must then install the pinned seeded generator before module load.
 */
function usesSeededRandom(scene: SceneDefinition): boolean {
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
 * A `--backend` value in canonical spelling. Values are `sdl_gpu|dawn`
 * (plus `cpu` where a CPU gate exists); `gpu` is accepted as an input
 * alias for `sdl_gpu` because that is the token the parity artifacts have
 * always used.
 */
export function canonicalBackend(
    value: string,
    allowed: readonly string[],
    command: string,
): string {
    const canonical = value === "gpu" ? "sdl_gpu" : value;
    if (!allowed.includes(canonical)) {
        throw new Error(
            `${command}: --backend must be ${allowed.join("|")} (got '${value}').`,
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
    allowed: readonly string[],
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
    const canonical = canonicalBackend(explicit, allowed, command);
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
 * backend (`report-gpu.json`, `diff-map-gpu.png`); `dawn` and `cpu` are
 * themselves. `--backend` values stay the unambiguous `sdl_gpu|dawn`.
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
    /** Canonical explicit selection, `sdl_gpu|dawn|cpu`; ambient fallback
     *  is applied later by `resolveBackend`. */
    backend?: string;
    seekSeconds?: number;
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
            value: ["--exe", "--actual", "--backend", "--seek"],
            boolean: [
                "--recapture-reference",
                "--no-fail",
                "--cpu",
                "--differential",
                "--gpu-debug",
            ],
            positionals: 1,
        },
        "parity",
    );
    const explicit = parsed.values.get("--backend");
    let backend =
        explicit === undefined
            ? undefined
            : canonicalBackend(
                  explicit,
                  ["sdl_gpu", "dawn", "cpu"],
                  "parity",
              );
    if (parsed.flags.has("--cpu")) {
        if (backend !== undefined && backend !== "cpu") {
            throw new Error(
                "parity: --cpu means --backend cpu; drop one of them.",
            );
        }
        backend = "cpu";
    }
    const sceneId = parsed.positionals[0];
    const executable = parsed.values.get("--exe");
    const actual = parsed.values.get("--actual");
    const seekSeconds = flagNumber(parsed, "--seek", "parity");
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
            ...(result.backend !== undefined
                ? [backend === "cpu" ? "--cpu" : "--backend"]
                : []),
            ...(result.seekSeconds !== undefined ? ["--seek"] : []),
        ];
        if (dropped.length > 0) {
            throw new Error(
                `parity: --differential measures both GPU backends and accepts only --gpu-debug beside it; drop ${dropped.join(", ")} or run a plain parity for them.`,
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
    const payloads: Array<[string, string, string]> = [];
    if (!process.env.BBLITE_GPU_SHADER_DIR) {
        payloads.push([
            "shaders",
            resolve(generatedDirectory, "upstream/shaders"),
            resolve(executableDirectory, "shaders"),
        ]);
    }
    if (!process.env.BBLITE_ASSET_DIR) {
        payloads.push([
            "assets",
            resolve(generatedDirectory, "assets"),
            resolve(executableDirectory, "assets"),
        ]);
    }
    for (const [label, source, deployed] of payloads) {
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

export function runNative(
    executable: string,
    screenshot: string,
    gpu: boolean,
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
    const screenshotFrame = Number.parseInt(
        nativeEnvironment?.BBLITE_SCREENSHOT_FRAME ?? "0",
        10,
    );
    const maxFrames = Number.isFinite(screenshotFrame) && screenshotFrame >= 0
        ? screenshotFrame + 1
        : 1;
    spawnNativeMeasured(executable, {
        ...nativeEnvironment,
            ...(gpu
                ? {
                      BBLITE_GPU: "1",
                      BBLITE_GPU_REQUIRED: "1",
                      ...(idBufferPath ? { BBLITE_ID_BUFFER: resolve(idBufferPath) } : {}),
                      ...(clusterBufferPath
                          ? { BBLITE_CLUSTER_BUFFER: resolve(clusterBufferPath) }
                          : {}),
                  }
                : {
                      BBLITE_GPU: "0",
                      SDL_VIDEODRIVER: "dummy",
                      SDL_RENDER_DRIVER: "software",
                  }),
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

export function resolveParityThresholds(
    config: SceneParityDefinition,
    gpu: boolean,
): {
    maxMad: number | undefined;
    maxRegionMad: number | undefined;
    gate: "enforced" | "diagnostic-only";
} {
    if (gpu) {
        if (
            process.env.BBLITE_GPU_BACKEND === "dawn" &&
            config.dawnThresholds
        ) {
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
    if (!config.cpuThresholds) {
        throw new Error(
            "CPU parity thresholds are not configured for this scene.",
        );
    }
    return {
        maxMad: config.cpuThresholds.maxFullMad,
        maxRegionMad: config.cpuThresholds.maxForegroundMad,
        gate: "enforced",
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
    const backend = resolveBackend(
        arguments_.backend,
        ["sdl_gpu", "dawn", "cpu"],
        "parity",
    );
    const gpu = backend !== "cpu";
    // The thresholds, the report labels and the native child all read the
    // backend from the environment, so the resolved selection is applied
    // there once rather than threaded to each.
    if (gpu) applyGpuBackendEnvironment(backend);
    const reference = resolve(config.reference.path);
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    // Backend-suffixed artifacts keep every backend's outputs side by
    // side in the scene's parity directory ("gpu" stays the SDL_GPU
    // suffix for continuity).
    const artifactSuffix = backendFileToken(backend);
    const actual = resolve(
        arguments_.actual ??
            resolve(outputDirectory, `native-${artifactSuffix}.png`),
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
    const thresholds = resolveParityThresholds(config, gpu);
    const renderer = gpu
        ? {
              mode: "gpu",
              implementation: backend === "dawn" ? "Dawn" : "SDL_GPU",
              driverSelection: process.env.SDL_GPU_DRIVER ?? "auto",
          }
        : {
              mode: "cpu-fallback",
              implementation: "SDL_Renderer",
              driverSelection: process.env.SDL_RENDER_DRIVER ?? "software",
          };
    const idBufferPath = gpu && config.attribution?.drawIds
        ? resolve(outputDirectory, "draw-ids-gpu.png")
        : undefined;
    const idVisualizationPath = idBufferPath
        ? resolve(outputDirectory, "draw-ids-visual-gpu.png")
        : undefined;
    const clusterBufferPath =
        gpu && config.attribution?.triangleClusters
        ? resolve(outputDirectory, "triangle-clusters-gpu.png")
        : undefined;
    const clusterVisualizationPath = clusterBufferPath
        ? resolve(outputDirectory, "triangle-clusters-visual-gpu.png")
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
        config.referenceFrameRate,
        config.referenceAnimationGroups,
        { seededRandom: usesSeededRandom(scene) },
    );
    if (!arguments_.actual) {
        runNative(
            resolve(
                arguments_.executable ??
                    process.env.BBLITE_NATIVE_EXE ??
                    defaultExecutable(scene.buildDirectory),
            ),
            actual,
            gpu,
            {
                ...config.nativeEnvironment,
                // The same pose on both sides: the browser capture above
                // seeks through the harness, the native run through its
                // deterministic clock.
                ...(seek !== undefined
                    ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
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
    const reportPath = resolve(
        outputDirectory,
        `report-${artifactSuffix}.json`,
    );
    writeReport(
        reportPath,
        {
            tool: "parity",
            backend,
            generatedDirectory: resolve(scene.output),
        },
        report,
    );

    console.log(`Renderer: ${renderer.implementation} (${renderer.mode}, ${renderer.driverSelection})`);
    if (thresholds.gate === "diagnostic-only") {
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
    sceneId: string,
): Promise<void> {
    const scene = resolveScene(sceneId);
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const outputDirectory = resolve(config.outputDirectory);
    mkdirSync(outputDirectory, { recursive: true });
    // Each backend run writes its own suffixed actual, so the two images
    // sit side by side without a copy step and neither run can overwrite
    // the other's.
    const sdlImage = resolve(outputDirectory, "native-gpu.png");
    const dawnImage = resolve(outputDirectory, "native-dawn.png");
    const previousBackend = process.env.BBLITE_GPU_BACKEND;
    try {
        delete process.env.BBLITE_GPU_BACKEND;
        await runSceneParity([sceneId]);
        process.env.BBLITE_GPU_BACKEND = "dawn";
        await runSceneParity([sceneId]);
    } finally {
        if (previousBackend === undefined) {
            delete process.env.BBLITE_GPU_BACKEND;
        } else {
            process.env.BBLITE_GPU_BACKEND = previousBackend;
        }
    }
    const backendDelta = compareImages(sdlImage, dawnImage);
    const readBackendReport = (suffix: string): {
        full: { mad: number };
        region: { mad: number };
    } =>
        JSON.parse(
            readFileSync(
                resolve(outputDirectory, `report-${suffix}.json`),
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
    const reportPath = resolve(
        outputDirectory,
        "report-differential.json",
    );
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
