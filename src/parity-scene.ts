#!/usr/bin/env node

import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fixedCaptureEnvironment } from "./capture-timing.js";
import {
    captureSuiteReference,
    captureUiEnabled,
} from "./capture-suite-reference.js";
import { readNativeHostUi } from "./native-host-ui.js";
import type { RenderItemSpecialization } from "./asset-specializer.js";
import {
    applicationScenes,
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
import { type FlagSpec, flagNumber, parseFlags } from "./tooling/flags.js";
import {
    applyGpuBackendEnvironment,
    backendFileToken,
    optionalBackend,
    parityCanvasReportPath,
    parityNativeImagePath,
    parityReportPath,
    resolveBackend,
} from "./tooling/artifacts.js";
import { readReport, writeReport } from "./tooling/reports.js";
import {
    enableGpuDebug,
    resolveNativeExecutable,
    runMeasured,
    spawnNativeMeasured,
    verifyBuildIdentity,
    verifyDeployedPayload,
    withEnvironment,
} from "./tooling/native-run.js";

/**
 * The generated manifest records the deterministic-seeded-random adaptation
 * whenever the compiled scene reached Math.random; the browser reference
 * must then install the pinned seeded generator before module load. Every
 * browser capture of a compiled scene reads this — the parity reference,
 * the instrumented capture and the geometry diagnostics — so a seeded
 * scene renders the same particle set on all of them.
 */
interface CompiledSceneManifest {
    adaptations?: Array<{ id?: string }>;
    features?: unknown;
}

function readCompiledSceneManifest(
    scene: SceneDefinition,
): CompiledSceneManifest | undefined {
    const manifestPath = resolve(
        scene.output,
        "manifest.json",
    );
    if (!existsSync(manifestPath)) {
        return undefined;
    }
    try {
        const manifest: unknown = JSON.parse(
            readFileSync(manifestPath, "utf8"),
        );
        if (
            typeof manifest !== "object" ||
            manifest === null
        ) {
            return undefined;
        }
        return manifest as CompiledSceneManifest;
    } catch {
        return undefined;
    }
}

function manifestUsesSeededRandom(
    manifest: CompiledSceneManifest | undefined,
): boolean {
    return (
        Array.isArray(manifest?.adaptations) &&
        manifest.adaptations.some(
            (adaptation) =>
                adaptation.id === "deterministic-seeded-random",
        )
    );
}

export function usesSeededRandom(scene: SceneDefinition): boolean {
    return manifestUsesSeededRandom(readCompiledSceneManifest(scene));
}

/** Whether the compiled scene actually carries the retained native UI.
 *  The instrumented capture reads this to compose the same page the
 *  golden capture composed (`runParity` derives the same predicate from
 *  its already-read manifest at its `retainedUiCapture` binding). */
export function usesRetainedUi(scene: SceneDefinition): boolean {
    const features = readCompiledSceneManifest(scene)?.features;
    return Array.isArray(features) && features.includes("ui:rml");
}

/**
 * The fixed browser frame the golden convention pins for a scene: the
 * parity spec's own `referenceFrame`, else — for a full-page capture of a
 * retained-UI scene — the positive `BBLITE_SCREENSHOT_FRAME` the registry
 * derives the native pose from, so the golden and every capture freeze the
 * page on the same deterministic frame. A canvas-only capture takes no
 * derived frame. This is the one home for that rule; the golden capture
 * and the instrumented capture both read it.
 */
export function goldenFixedFrame(
    scene: SceneDefinition,
    retainedUiCapture: boolean,
): number | undefined {
    if (scene.parity?.referenceFrame !== undefined) {
        return scene.parity.referenceFrame;
    }
    if (!retainedUiCapture) return undefined;
    const configuredNativeFrame = Number.parseInt(
        scene.parity?.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME ?? "",
        10,
    );
    return Number.isInteger(configuredNativeFrame) &&
        configuredNativeFrame > 0
        ? configuredNativeFrame
        : undefined;
}

interface GltfSpecialization {
    renderItems: RenderItemSpecialization[];
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
/** The parity flags, shared with the dispatcher's usage text. */
export const PARITY_FLAGS: FlagSpec = {
    value: ["--exe", "--actual", "--backend", "--seek", "--without"],
    boolean: [
        "--recapture-reference",
        "--no-fail",
        "--differential",
        "--gpu-debug",
    ],
    positionals: 1,
};

export function parseParityArguments(rest: string[]): ParityArguments {
    const parsed = parseFlags(rest, PARITY_FLAGS, "parity");
    const backend = optionalBackend(parsed, "parity");
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

/** The frame loops print one `[mem][frame]` line every this many frames. */
const memoryProfileFrames = 30;

/** The memory flags, shared with the dispatcher's usage text. */
export const MEMORY_FLAGS: FlagSpec = {
    value: [
        "--frames",
        "--backend",
        "--replay",
        "--replay-file",
        "--max-growth-mb",
    ],
};

export interface MemoryArguments {
    /** Frames to run; at least three samples, so the warm-up third has one. */
    frames: number;
    /** Working-set growth after warm-up that fails the run. */
    maxGrowthMb: number;
    backend?: string;
    /** A BBLITE_INPUT_REPLAY tape, so a demo streams instead of idling. */
    replay?: string;
}

export function parseMemoryArguments(
    rest: readonly string[],
): MemoryArguments {
    const parsed = parseFlags(rest, MEMORY_FLAGS, "memory");
    const frames = flagNumber(parsed, "--frames", "memory") ?? 6000;
    const minimumFrames = 3 * memoryProfileFrames;
    if (!Number.isInteger(frames) || frames < minimumFrames) {
        throw new Error(
            `memory: --frames must be an integer >= ${minimumFrames} (three samples at one every ${memoryProfileFrames} frames; got '${parsed.values.get("--frames")}').`,
        );
    }
    const maxGrowthMb = flagNumber(parsed, "--max-growth-mb", "memory") ?? 32;
    if (maxGrowthMb < 0) {
        throw new Error("memory: --max-growth-mb must be nonnegative.");
    }
    const backend = optionalBackend(parsed, "memory");
    const replayFile = parsed.values.get("--replay-file");
    if (replayFile !== undefined && parsed.values.has("--replay")) {
        throw new Error("memory: use only one of --replay and --replay-file.");
    }
    // A streaming tape runs to thousands of entries, past what a shell
    // passes as one argument; a file carries it whole.
    const replay =
        replayFile !== undefined
            ? readFileSync(replayFile, "utf8").trim()
            : parsed.values.get("--replay");
    return {
        frames,
        maxGrowthMb,
        ...(backend !== undefined ? { backend } : {}),
        ...(replay !== undefined ? { replay } : {}),
    };
}

/** One `[mem][frame]` line, with the fields the verdict reads. */
export interface MemorySample {
    frame: number;
    workingSetMb: number;
    meshRecords: number;
    sceneMeshes: number;
    geometryMb: number;
}

/**
 * The `[mem][frame]` lines of a run, in order. A line missing one of the
 * fields the verdict reads is dropped rather than defaulted, so nothing
 * unmeasured can pass.
 */
export function parseMemoryProfile(stderr: string): MemorySample[] {
    const samples: MemorySample[] = [];
    for (const match of stderr.matchAll(/^\[mem\]\[frame\] (.*)$/gm)) {
        const values = new Map<string, number>();
        for (const field of match[1]!.trim().split(" ")) {
            const [name, text] = field.split("=");
            if (name && text !== undefined) values.set(name, Number(text));
        }
        const read = (name: string): number | undefined => {
            const value = values.get(name);
            return value === undefined || !Number.isFinite(value) || value < 0
                ? undefined : value;
        };
        const frame = read("frame");
        const workingSetMb = read("working_set_mb");
        const meshRecords = read("mesh_records");
        const sceneMeshes = read("scene_meshes");
        const geometryMb = read("geometry_mb");
        if (
            frame === undefined || !Number.isInteger(frame) ||
            workingSetMb === undefined || workingSetMb === 0 ||
            meshRecords === undefined ||
            sceneMeshes === undefined ||
            geometryMb === undefined
        ) {
            continue;
        }
        samples.push({ frame, workingSetMb, meshRecords, sceneMeshes, geometryMb });
    }
    return samples;
}

export interface MemorySummary {
    /** The sample that ends warm-up: a third of the way through the run. */
    settled: MemorySample;
    last: MemorySample;
    /** `last.workingSetMb - settled.workingSetMb`. */
    growthMb: number;
    maxGrowthMb: number;
    passed: boolean;
}

/**
 * The verdict of one run: after the warm-up third, does the working set
 * settle? A streaming scene retires mesh records by design (the slots
 * stay allocated, a few hundred bytes each), so that count is reported
 * rather than judged; the growth threshold is what fails the run.
 * Undefined when the run printed too few lines to judge (a loop without
 * the line, or a run shorter than three samples).
 */
export function summarizeMemoryProfile(
    samples: readonly MemorySample[],
    maxGrowthMb: number,
    requestedFrames?: number,
): MemorySummary | undefined {
    if (samples.length < 3) return undefined;
    const settled = samples[Math.ceil((samples.length - 1) / 3)]!;
    const last = samples[samples.length - 1]!;
    if (
        (requestedFrames !== undefined && last.frame < requestedFrames - memoryProfileFrames) ||
        samples.some((sample, index) => index > 0 && sample.frame <= samples[index - 1]!.frame)
    ) return undefined;
    const growthMb = last.workingSetMb - settled.workingSetMb;
    return {
        settled,
        last,
        growthMb,
        maxGrowthMb,
        passed: growthMb <= maxGrowthMb,
    };
}

export function formatMemorySummary(
    id: string,
    summary: MemorySummary | undefined,
): string {
    if (!summary) {
        return `${id}: unmeasured (missing, unordered or incomplete [mem][frame] samples)`;
    }
    const { settled, last, growthMb, maxGrowthMb } = summary;
    const verdict = summary.passed ? "ok" : `FAILED (> ${maxGrowthMb} MB)`;
    const sign = growthMb >= 0 ? "+" : "";
    return (
        `${id}: ${verdict} -- working set ${sign}${growthMb.toFixed(1)} MB after warm-up ` +
        `(${settled.workingSetMb.toFixed(1)} -> ${last.workingSetMb.toFixed(1)} MB, ` +
        `frames ${settled.frame}..${last.frame}), geometry ${last.geometryMb.toFixed(1)} MB, ` +
        `${last.meshRecords - last.sceneMeshes} retired mesh record(s)`
    );
}

/**
 * `scene -- memory <id|all>`: run a scene for many frames at the fixed
 * capture delta with BBLITE_MEM_PROFILE=1 and judge whether its working
 * set settles after the warm-up third. `all` runs the registered
 * application demos, the sources closest to a real program's lifetime.
 * Idle by default; `--replay`/`--replay-file` hand the run an input
 * tape, which is how a streaming world keeps streaming.
 */
export function runMemoryReport(
    idOrSource: string,
    memoryArguments: MemoryArguments,
): void {
    const selected =
        idOrSource === "all" ? applicationScenes : [resolveScene(idOrSource)];
    const backend = resolveBackend(memoryArguments.backend, "memory");
    applyGpuBackendEnvironment(backend);
    let failures = 0;
    let unmeasured = 0;
    for (const scene of selected) {
        const executable = resolveNativeExecutable(
            undefined,
            scene.buildDirectory,
        );
        const generatedDirectory = resolve(scene.output);
        verifyDeployedPayload(executable, generatedDirectory);
        const stampPath = resolve(
            "artifacts",
            "memory",
            `${scene.id}-${backendFileToken(backend)}.build-stamp`,
        );
        mkdirSync(resolve(stampPath, ".."), { recursive: true });
        rmSync(stampPath, { force: true });
        const stderr = spawnNativeMeasured(
            executable,
            {
                ...fixedCaptureEnvironment(),
                BBLITE_BENCHMARK_FRAMES: String(memoryArguments.frames),
                BBLITE_MEM_PROFILE: "1",
                BBLITE_BUILD_STAMP_OUT: stampPath,
                ...(memoryArguments.replay !== undefined
                    ? { BBLITE_INPUT_REPLAY: memoryArguments.replay }
                    : {}),
            },
            [],
            true,
        );
        verifyBuildIdentity(executable, generatedDirectory, stampPath);
        const samples = parseMemoryProfile(stderr);
        const summary = summarizeMemoryProfile(
            samples,
            memoryArguments.maxGrowthMb,
            memoryArguments.frames,
        );
        const reportStem = stampPath.slice(0, -".build-stamp".length);
        writeFileSync(`${reportStem}.log`, stderr);
        writeReport(`${reportStem}.json`, {
            tool: "memory", backend, generatedDirectory,
        }, {
            scene: scene.id,
            requestedFrames: memoryArguments.frames,
            maxGrowthMb: memoryArguments.maxGrowthMb,
            ...(memoryArguments.replay !== undefined ? { replay: memoryArguments.replay } : {}),
            status: summary === undefined ? "unmeasured" : summary.passed ? "passed" : "failed",
            samples,
            ...(summary !== undefined ? { summary } : {}),
        });
        if (!summary) unmeasured += 1;
        if (summary && !summary.passed) failures += 1;
        console.log(formatMemorySummary(scene.id, summary));
    }
    if (failures > 0 || unmeasured > 0) {
        throw new Error(
            `memory: ${failures} run(s) grew past ${memoryArguments.maxGrowthMb} MB after warm-up; ${unmeasured} unmeasured run(s). See artifacts/memory/.`,
        );
    }
}

export function runNative(
    executable: string,
    screenshot: string,
    nativeEnvironment?: Record<string, string>,
    idBufferPath?: string,
    clusterBufferPath?: string,
    generatedDirectory?: string,
): void {
    runMeasured(executable, {
        ...(generatedDirectory !== undefined ? { generatedDirectory } : {}),
        ...(nativeEnvironment !== undefined
            ? { environment: nativeEnvironment }
            : {}),
        screenshot,
        ...(idBufferPath !== undefined ? { idBuffer: idBufferPath } : {}),
        ...(clusterBufferPath !== undefined
            ? { clusterBuffer: clusterBufferPath }
            : {}),
    });
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
    const captureUi = captureUiEnabled();
    const canvasOnly = !captureUi;
    const outputDirectory = canvasOnly
        ? resolve("artifacts", "parity-canvas", scene.id)
        : resolve(config.outputDirectory);
    const compiledManifest = readCompiledSceneManifest(scene);
    const retainedUiCapture =
        captureUi &&
        Array.isArray(compiledManifest?.features) &&
        compiledManifest.features.includes("ui:rml");
    const reference = canvasOnly
        ? resolve(outputDirectory, "browser-canvas.png")
        : resolve(config.reference.path);
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
    // thresholds would fail the attribution run for working.
    const thresholds =
        canvasOnly || without !== undefined
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

    const recaptureReference =
        arguments_.recaptureReference ||
        (canvasOnly && !existsSync(reference));
    const browserReferenceFrame = goldenFixedFrame(scene, retainedUiCapture);
    validateReferenceCapture(
        scene,
        reference,
        recaptureReference,
    );
    // What both browser captures share: the seeded-random stub, the
    // companion DOM and the registry's pose search. The DOM is present in
    // a canvas-only capture too -- the harness hides it from the canvas
    // screenshot, and a page script that binds to it (the screen-space
    // toggles) would otherwise throw before the scene starts.
    const sharedCaptureOptions = {
        seededRandom: manifestUsesSeededRandom(compiledManifest),
        ...(config.independentEngines === undefined ? {} : { independentEngines: config.independentEngines }),
        ...(config.referenceHostPage === undefined ? {} : { hostPage: config.referenceHostPage }),
        ...(scene.nativeHostUi
            ? { hostUi: readNativeHostUi(scene.nativeHostUi) }
            : {}),
        ...(config.referenceSearch !== undefined
            ? { search: config.referenceSearch }
            : {}),
    };
    await captureSuiteReference(
        scene.source,
        reference,
        recaptureReference,
        undefined,
        seek ?? config.referenceTimeSeconds,
        config.referenceAnimationGroups,
        {
            ...sharedCaptureOptions,
            ...(browserReferenceFrame !== undefined
                ? { fixedAnimationFrame: browserReferenceFrame }
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

    // The canvas-only lane: a UI-dominated application gates the full
    // page at the platform font-rasterization floor (docs/ui.md), which
    // is loose enough for a genuine 3D regression of a few tenths MAD to
    // hide under. A scene declaring `canvasThresholds` therefore also
    // measures the `BBLITE_CAPTURE_UI=0` pair — the same references and
    // artifacts the manual attribution run writes under
    // `artifacts/parity-canvas/` — and gates it beside the composite
    // gate. Only the canonical run measures it: a seek, a suppression, a
    // supplied actual, or a canvas-only invocation is already a
    // diagnostic, and only declaring scenes pay the extra native run and
    // reference capture.
    const canvasThresholds =
        captureUi &&
        without === undefined &&
        seek === undefined &&
        arguments_.actual === undefined
            ? config.canvasThresholds
            : undefined;
    let canvas:
        | {
              full: ReturnType<typeof compareImages>;
              region: ReturnType<typeof compareRegion>;
              thresholds: {
                  maxMad: number;
                  maxRegionMad: number;
                  gate: "enforced";
              };
              files: { actual: string; reference: string };
          }
        | undefined;
    if (canvasThresholds) {
        const canvasDirectory = resolve(
            "artifacts",
            "parity-canvas",
            scene.id,
        );
        mkdirSync(canvasDirectory, { recursive: true });
        // The reference reproduces the attribution run exactly — the
        // companion DOM present but hidden, the canvas screenshot
        // excluding the page, at the pose that run derives
        // (`referenceFrame` when the registry declares one; tetris
        // settles onto its ad-hoc native frame) — and follows the
        // committed golden's lifecycle: captured when missing,
        // recaptured only with --recapture-reference.
        const canvasReference = resolve(
            canvasDirectory,
            "browser-canvas.png",
        );
        await withEnvironment("BBLITE_CAPTURE_UI", "0", () =>
            captureSuiteReference(
                scene.source,
                canvasReference,
                arguments_.recaptureReference,
                undefined,
                config.referenceTimeSeconds,
                config.referenceAnimationGroups,
                {
                    ...sharedCaptureOptions,
                    ...(config.referenceFrame !== undefined
                        ? { fixedAnimationFrame: config.referenceFrame }
                        : {}),
                },
            ),
        );
        const canvasActual = parityNativeImagePath(canvasDirectory, token);
        runNative(
            resolveNativeExecutable(
                arguments_.executable,
                scene.buildDirectory,
            ),
            canvasActual,
            { ...config.nativeEnvironment, BBLITE_CAPTURE_UI: "0" },
            undefined,
            undefined,
            resolve(scene.output),
        );
        canvas = {
            full: compareImages(canvasActual, canvasReference),
            region: compareRegion(
                canvasActual,
                canvasReference,
                config.backgroundColor,
                config.backgroundThreshold,
            ),
            thresholds: {
                maxMad: canvasThresholds.maxFullMad,
                maxRegionMad: canvasThresholds.maxForegroundMad,
                gate: "enforced",
            },
            files: { actual: canvasActual, reference: canvasReference },
        };
        // The canvas lane's own report, beside its PNGs, one file for
        // both backends: `verify-status` checks the published
        // "canvas-only MAD" numbers against it, so those cells are data
        // the pipeline checks rather than prose it trusts.
        const canvasReportPath = parityCanvasReportPath(canvasDirectory);
        const previous = readReport<{
            backends?: Record<string, unknown>;
        }>(canvasReportPath);
        writeReport(
            canvasReportPath,
            {
                tool: "parity-canvas",
                generatedDirectory: resolve(scene.output),
            },
            {
                scene: scene.name,
                backends: {
                    ...(previous?.backends ?? {}),
                    [backend]: {
                        fullMad: canvas.full.mad,
                        foregroundMad: canvas.region.mad,
                        buildStamp: readFileSync(
                            `${canvasActual}.build-stamp`,
                            "utf8",
                        ).trim(),
                        writtenAt: new Date().toISOString(),
                        files: canvas.files,
                    },
                },
            },
        );
    }

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
        ...(canvas ? { canvas } : {}),
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
    if (canvas) {
        console.log(
            `${scene.name} canvas-only (no UI): MAD=${canvas.full.mad.toFixed(3)}, ` +
                `region=${canvas.region.mad.toFixed(3)} ` +
                `(gates ${canvas.thresholds.maxMad}/${canvas.thresholds.maxRegionMad})`,
        );
    }
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
    if (canvas) {
        if (canvas.full.mad > canvas.thresholds.maxMad) {
            failures.push(
                `canvas-only full MAD ${canvas.full.mad.toFixed(3)} > ${canvas.thresholds.maxMad}`,
            );
        }
        if (canvas.region.mad > canvas.thresholds.maxRegionMad) {
            failures.push(
                `canvas-only region MAD ${canvas.region.mad.toFixed(3)} > ${canvas.thresholds.maxRegionMad}`,
            );
        }
    }
    if (failures.length > 0) {
        const message = `Parity regression: ${failures.join(", ")}`;
        if (arguments_.noFail) console.warn(message);
        else throw new Error(message);
    }
}

/**
 * The reader slices of the two report families this module writes: the
 * per-backend parity report (`runSceneParity`) and the differential
 * merge (`runSceneParityDifferential`). The writers are single; these
 * are the fields every reader consumes — the differential merge itself,
 * diagnose's verdict line, `verify-status`'s published-table check — so
 * a renamed field breaks one declaration instead of a scattered cast.
 */
export interface ParityReportSummary {
    full: { mad: number };
    region: { mad: number };
}

export interface DifferentialReportSummary {
    goldenVersusSdlGpu: { fullMad: number; foregroundMad: number };
    goldenVersusDawn: { fullMad: number; foregroundMad: number };
    sdlGpuVersusDawn: { mad: number };
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
    const outputDirectory = captureUiEnabled()
        ? resolve(config.outputDirectory)
        : resolve("artifacts", "parity-canvas", scene.id);
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
    const readBackendReport = (suffix: string): ParityReportSummary =>
        JSON.parse(
            readFileSync(
                parityReportPath(outputDirectory, suffix),
                "utf8",
            ),
        ) as ParityReportSummary;
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
// Some scenes render differently from one run to the next with no code
// change at all (`scene-neutrality.ts` lists the measured ones, per
// backend). This command is that check on demand, with its one trap
// built in: comparing runs only against each other hides a
// stable-but-wrong image, so every run is also compared against the
// golden and both columns always print.
// ---------------------------------------------------------------------------

/** The stability flags, shared with the dispatcher's usage text. */
export const STABILITY_FLAGS: FlagSpec = {
    value: ["--runs", "--backend", "--seek"],
    boolean: ["--single-sample", "--gpu-debug"],
};

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
    const parsed = parseFlags(rest, STABILITY_FLAGS, "stability");
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
    const backend = optionalBackend(parsed, "stability");
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
