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
import {
    type FlagSpec,
    type ParsedFlags,
    MEASURE_FLAGS,
    flagNumber,
    parseFlags,
} from "./tooling/flags.js";
import {
    artifactDirectory,
    backendFileToken,
    optionalBackend,
    parityCanvasReportPath,
    parityNativeImagePath,
    parityReportPath,
    resolveBackend,
    resolvePose,
    type ScenePose,
} from "./tooling/artifacts.js";
import {
    parseBackendName,
    type BackendSelection,
    type NativeBackend,
} from "./tooling/backends.js";
import { readMemoryTape } from "./tooling/check-spec.js";
import { readReport, writeReport } from "./tooling/reports.js";
import {
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
    const manifestPath = resolve(scene.output, "manifest.json");
    if (!existsSync(manifestPath)) {
        return undefined;
    }
    try {
        const manifest: unknown = JSON.parse(
            readFileSync(manifestPath, "utf8"),
        );
        if (typeof manifest !== "object" || manifest === null) {
            return undefined;
        }
        return manifest;
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
            (adaptation) => adaptation.id === "deterministic-seeded-random",
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
    return Number.isInteger(configuredNativeFrame) && configuredNativeFrame > 0
        ? configuredNativeFrame
        : undefined;
}

interface GltfSpecialization {
    renderItems: RenderItemSpecialization[];
}

/** The two elements `--without` can suppress natively. */
export type SuppressibleElement = "ground" | "background";

/**
 * The parity invocation, parsed and validated once, up front, before any
 * child process or build-stamp check spends time on a flag combination
 * that cannot mean anything. One command, four modes:
 *   - the gate (default): golden against every measured backend, plus the
 *     backend-against-backend differential when both run;
 *   - `--runs N`: N native re-renders against run 1 and the golden;
 *   - `--geometry`: each impostor copy task, browser against native;
 *   - `--attribute`: the gate over the instrumented draw-id twin.
 */
export interface ParityArguments {
    /** Explicit `--backend` (`both` accepted); absent, `measuredBackends`
     *  decides (ambient `BBLITE_GPU_BACKEND`, else the compiled set). */
    backend?: BackendSelection;
    seekSeconds?: number;
    /** `--without ground|background`: the native side re-rendered with
     *  that element suppressed, against the unchanged golden. The element
     *  whose removal makes the number worse is not the culprit. */
    without?: SuppressibleElement;
    /** A pre-rendered native image measured in place of a native run. */
    actual?: string;
    attribute: boolean;
    geometry: boolean;
    /** `--runs N`: the run-to-run stability mode. */
    runs?: number;
    singleSample: boolean;
    recaptureReference: boolean;
    noFail: boolean;
    gpuDebug: boolean;
}

/** The native switch `--without` drives for each suppressible element. */
export function withoutVariable(
    without: SuppressibleElement,
): "BBLITE_GROUND" | "BBLITE_BACKGROUND" {
    return without === "ground" ? "BBLITE_GROUND" : "BBLITE_BACKGROUND";
}

/** The parity flags, shared with the dispatcher's usage text. */
export const PARITY_FLAGS: FlagSpec = {
    value: [...MEASURE_FLAGS.value, "--without", "--actual", "--runs"],
    boolean: [
        ...MEASURE_FLAGS.boolean,
        "--attribute",
        "--geometry",
        "--single-sample",
        "--recapture-reference",
        "--no-fail",
    ],
};

/** Refuse `present` flags beside `mode`, naming why they cannot compose. */
function refuseBeside(
    mode: string,
    present: ReadonlyArray<readonly [string, boolean]>,
    reason: string,
): void {
    const dropped = present.filter(([, set]) => set).map(([flag]) => flag);
    if (dropped.length > 0) {
        throw new Error(
            `parity: ${mode} does not compose with ${dropped.join(", ")}: ${reason}`,
        );
    }
}

export function parseParityArguments(rest: readonly string[]): ParityArguments {
    return parityArgumentsFrom(parseFlags(rest, PARITY_FLAGS, "parity"));
}

export function parityArgumentsFrom(parsed: ParsedFlags): ParityArguments {
    const backendValue = parsed.values.get("--backend");
    const backend =
        backendValue === undefined
            ? undefined
            : parseBackendName(backendValue, "parity: --backend", true);
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
    const runsValue = parsed.values.get("--runs");
    const runs = runsValue === undefined ? undefined : Number(runsValue);
    if (runs !== undefined && (!Number.isInteger(runs) || runs < 2)) {
        throw new Error(
            `parity: --runs must be an integer >= 2 (got '${runsValue}').`,
        );
    }
    const result: ParityArguments = {
        ...(backend !== undefined ? { backend } : {}),
        ...(seekSeconds !== undefined ? { seekSeconds } : {}),
        ...(withoutValue !== undefined ? { without: withoutValue } : {}),
        ...(actual !== undefined ? { actual } : {}),
        attribute: parsed.flags.has("--attribute"),
        geometry: parsed.flags.has("--geometry"),
        ...(runs !== undefined ? { runs } : {}),
        singleSample: parsed.flags.has("--single-sample"),
        recaptureReference: parsed.flags.has("--recapture-reference"),
        noFail: parsed.flags.has("--no-fail"),
        gpuDebug: parsed.flags.has("--gpu-debug"),
    };
    const modes = [
        ["--runs", result.runs !== undefined],
        ["--geometry", result.geometry],
        ["--attribute", result.attribute],
    ] as const;
    const selected = modes.filter(([, set]) => set).map(([flag]) => flag);
    if (selected.length > 1) {
        throw new Error(
            `parity: ${selected.join(" and ")} are separate modes; run them separately.`,
        );
    }
    if (result.singleSample && result.runs === undefined) {
        throw new Error(
            "parity: --single-sample is a stability measurement; pass --runs N beside it.",
        );
    }
    if (result.runs !== undefined) {
        refuseBeside(
            "--runs",
            [
                ["--without", result.without !== undefined],
                ["--actual", result.actual !== undefined],
                ["--recapture-reference", result.recaptureReference],
                ["--no-fail", result.noFail],
            ],
            "the runs re-render the native side against the golden as it stands and gate nothing.",
        );
    }
    if (result.geometry) {
        refuseBeside(
            "--geometry",
            [
                ["--without", result.without !== undefined],
                ["--actual", result.actual !== undefined],
                ["--no-fail", result.noFail],
            ],
            "the copy tasks are rendered and measured alone and gate nothing.",
        );
    }
    if (result.attribute) {
        refuseBeside(
            "--attribute",
            [
                ["--without", result.without !== undefined],
                ["--actual", result.actual !== undefined],
            ],
            "the instrumented twin must render the attribution buffers itself.",
        );
    }
    if (result.without !== undefined) {
        // The suppression flags are read by the native GPU frame options,
        // and the experiment is native-versus-unchanged-golden; each of
        // these companions would quietly measure something else.
        refuseBeside(
            "--without",
            [
                ["--actual", result.actual !== undefined],
                ["--recapture-reference", result.recaptureReference],
            ],
            "the element is suppressed natively only and the golden keeps it; recapture a stale golden in a separate plain run.",
        );
    }
    if (result.seekSeconds !== undefined) {
        refuseBeside(
            "--seek",
            [["--recapture-reference", result.recaptureReference]],
            "a seek is measured against its own browser capture at that pose, never the golden; recapture the golden in a plain run.",
        );
    }
    if (
        result.actual !== undefined &&
        (result.backend === undefined || result.backend === "both")
    ) {
        throw new Error(
            "parity: --actual measures one pre-rendered image; name its backend with --backend sdl_gpu|dawn.",
        );
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
        "--max-slope-mb",
    ],
};

export interface MemoryArguments {
    /** Frames to run; at least three samples, so the warm-up third has one. */
    frames: number;
    /** Working-set trend after warm-up that fails the run, in MB per
     *  1,000 frames. */
    maxSlopeMb: number;
    backend?: string;
    /** An explicit BBLITE_INPUT_REPLAY tape; absent, the scene's default
     *  gameplay tape (`checks/memory/<id>.json`) when it declares one. */
    replay?: string;
}

export function parseMemoryArguments(rest: readonly string[]): MemoryArguments {
    return memoryArgumentsFrom(parseFlags(rest, MEMORY_FLAGS, "memory"));
}

export function memoryArgumentsFrom(parsed: ParsedFlags): MemoryArguments {
    const frames = flagNumber(parsed, "--frames", "memory") ?? 6000;
    const minimumFrames = 9 * memoryProfileFrames;
    if (!Number.isInteger(frames) || frames < minimumFrames) {
        throw new Error(
            `memory: --frames must be an integer >= ${minimumFrames} (a warm-up third and two samples per later third at one every ${memoryProfileFrames} frames; got '${parsed.values.get("--frames")}').`,
        );
    }
    const maxSlopeMb = flagNumber(parsed, "--max-slope-mb", "memory") ?? 2;
    if (maxSlopeMb < 0) {
        throw new Error("memory: --max-slope-mb must be nonnegative.");
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
        maxSlopeMb,
        ...(backend !== undefined ? { backend } : {}),
        ...(replay !== undefined ? { replay } : {}),
    };
}

/** One `[mem][frame]` sample used by the memory report. */
export interface MemorySample {
    frame: number;
    workingSetMb: number;
    /** Engine mesh records, against the meshes the scene still draws. */
    meshRecords: number;
    sceneMeshes: number;
    /** Engine geometry records, against the ones still holding vertices. */
    geometryRecords: number;
    liveGeometries: number;
    geometryMb: number;
    gcNodes: number;
    gcAllocations: number;
}

/**
 * Complete `[mem][frame]` samples in frame order. Missing or invalid report
 * fields discard the sample.
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
                ? undefined
                : value;
        };
        const count = (name: string): number | undefined => {
            const value = read(name);
            return value !== undefined && Number.isInteger(value)
                ? value
                : undefined;
        };
        const frame = count("frame");
        const workingSetMb = read("working_set_mb");
        const meshRecords = count("mesh_records");
        const sceneMeshes = count("scene_meshes");
        const geometryRecords = count("geometry_records");
        const liveGeometries = count("live_geometries");
        const geometryMb = read("geometry_mb");
        const gcNodes = count("gc_nodes");
        const gcAllocations = count("gc_allocations");
        if (
            frame === undefined ||
            workingSetMb === undefined ||
            workingSetMb === 0 ||
            meshRecords === undefined ||
            sceneMeshes === undefined ||
            geometryRecords === undefined ||
            liveGeometries === undefined ||
            geometryMb === undefined ||
            gcNodes === undefined ||
            gcAllocations === undefined
        ) {
            continue;
        }
        samples.push({
            frame,
            workingSetMb,
            meshRecords,
            sceneMeshes,
            geometryRecords,
            liveGeometries,
            geometryMb,
            gcNodes,
            gcAllocations,
        });
    }
    return samples;
}

/**
 * A counter across the post-warm-up window: its value where warm-up ends
 * and at the last sample, and the floor (minimum) of each third of the
 * window. A leak raises every floor; a sawtooth (garbage waiting for its
 * collection, a mesh built then retired) leaves the floors where they were.
 */
export interface MemoryCounterTrend {
    settled: number;
    last: number;
    floors: [number, number, number];
}

export interface MemorySummary {
    /** The sample that ends warm-up: a third of the way through the run. */
    settled: MemorySample;
    last: MemorySample;
    /** `last.workingSetMb - settled.workingSetMb`. */
    growthMb: number;
    /** Least-squares working-set slope after warm-up, MB per 1,000 frames. */
    slopeMbPer1000Frames: number;
    maxSlopeMb: number;
    /**
     * Mesh records past the most the scene has drawn at once so far
     * (`mesh_records` minus the running maximum of `scene_meshes`).
     */
    orphanMeshRecords: MemoryCounterTrend;
    /**
     * Geometry records past the most that held vertices at once so far
     * (`geometry_records` minus the running maximum of `live_geometries`).
     */
    orphanGeometryRecords: MemoryCounterTrend;
    gcNodes: MemoryCounterTrend;
    /** Why the run failed; empty when it passed. */
    failures: string[];
    passed: boolean;
}

/** GC nodes must rise by at least this share of their first floor (and
 *  `gcNodeRiseMinimum` nodes) across the window to count as a leak. */
const gcNodeRiseShare = 0.01;
const gcNodeRiseMinimum = 100;

function counterTrend(
    window: readonly MemorySample[],
    value: (sample: MemorySample) => number,
): MemoryCounterTrend {
    const third = Math.floor(window.length / 3);
    const floor = (from: number, to: number): number =>
        Math.min(...window.slice(from, to).map(value));
    return {
        settled: value(window[0]!),
        last: value(window[window.length - 1]!),
        floors: [
            floor(0, third),
            floor(third, window.length - third),
            floor(window.length - third, window.length),
        ],
    };
}

/** Each sample's running maximum of `value` over the run up to it. */
function runningMaximum(
    samples: readonly MemorySample[],
    value: (sample: MemorySample) => number,
): Map<MemorySample, number> {
    const result = new Map<MemorySample, number>();
    let peak = 0;
    for (const sample of samples) {
        peak = Math.max(peak, value(sample));
        result.set(sample, peak);
    }
    return result;
}

function slopePer1000Frames(window: readonly MemorySample[]): number {
    const frames = window.map((sample) => sample.frame);
    const values = window.map((sample) => sample.workingSetMb);
    const meanFrame = frames.reduce((sum, x) => sum + x, 0) / frames.length;
    const meanValue = values.reduce((sum, y) => sum + y, 0) / values.length;
    let covariance = 0;
    let variance = 0;
    for (let index = 0; index < frames.length; index += 1) {
        covariance +=
            (frames[index]! - meanFrame) * (values[index]! - meanValue);
        variance += (frames[index]! - meanFrame) ** 2;
    }
    return variance === 0 ? 0 : (covariance / variance) * 1000;
}

/**
 * The memory gate over the samples after the warm-up third. A run fails
 * when any of these holds:
 *   - the working set trends upward faster than `maxSlopeMb` per 1,000
 *     frames (least squares, so one late spike does not decide);
 *   - engine mesh or geometry records pile up past the most meshes the
 *     scene has drawn (geometries have held vertices) at once: the last
 *     third's floor is above the first third's — records a correct
 *     program retires are reused, so the tables never outgrow that
 *     high-water, however far the scene's own count dips below it;
 *   - GC nodes rise steadily: each third's floor above the previous one's,
 *     by more than `gcNodeRiseShare` of the first floor.
 * Undefined when the run printed too few lines to judge (a loop without
 * the line, an unordered or truncated run, or fewer than two samples per
 * post-warm-up third).
 */
export function summarizeMemoryProfile(
    samples: readonly MemorySample[],
    maxSlopeMb: number,
    requestedFrames?: number,
): MemorySummary | undefined {
    const settledIndex = Math.ceil((samples.length - 1) / 3);
    const window = samples.slice(settledIndex);
    if (window.length < 6) return undefined;
    const settled = window[0]!;
    const last = window[window.length - 1]!;
    if (
        (requestedFrames !== undefined &&
            last.frame < requestedFrames - memoryProfileFrames) ||
        samples.some(
            (sample, index) =>
                index > 0 && sample.frame <= samples[index - 1]!.frame,
        )
    )
        return undefined;
    const growthMb = last.workingSetMb - settled.workingSetMb;
    const slope = slopePer1000Frames(window);
    const sceneMeshPeak = runningMaximum(
        samples,
        (sample) => sample.sceneMeshes,
    );
    const liveGeometryPeak = runningMaximum(
        samples,
        (sample) => sample.liveGeometries,
    );
    const orphanMeshRecords = counterTrend(
        window,
        (sample) => sample.meshRecords - sceneMeshPeak.get(sample)!,
    );
    const orphanGeometryRecords = counterTrend(
        window,
        (sample) => sample.geometryRecords - liveGeometryPeak.get(sample)!,
    );
    const gcNodes = counterTrend(window, (sample) => sample.gcNodes);
    const failures: string[] = [];
    if (slope > maxSlopeMb) {
        failures.push(
            `working set trends +${slope.toFixed(2)} MB per 1,000 frames (> ${maxSlopeMb})`,
        );
    }
    for (const [label, trend] of [
        ["mesh records the scene no longer draws", orphanMeshRecords],
        ["geometry records without vertices", orphanGeometryRecords],
    ] as const) {
        if (trend.floors[2] > trend.floors[0]) {
            failures.push(
                `${label} pile up: ${trend.settled} -> ${trend.last} (floors ${trend.floors.join(" / ")})`,
            );
        }
    }
    const [first, middle, final] = gcNodes.floors;
    if (
        first < middle &&
        middle < final &&
        final - first > Math.max(gcNodeRiseMinimum, first * gcNodeRiseShare)
    ) {
        failures.push(
            `GC nodes rise steadily: floors ${gcNodes.floors.join(" / ")}`,
        );
    }
    return {
        settled,
        last,
        growthMb,
        slopeMbPer1000Frames: slope,
        maxSlopeMb,
        orphanMeshRecords,
        orphanGeometryRecords,
        gcNodes,
        failures,
        passed: failures.length === 0,
    };
}

export function formatMemorySummary(
    id: string,
    summary: MemorySummary | undefined,
): string {
    if (!summary) {
        return `${id}: unmeasured (missing, unordered or incomplete [mem][frame] samples)`;
    }
    const { settled, last, growthMb, slopeMbPer1000Frames } = summary;
    const signed = (value: number, digits: number): string =>
        `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
    return [
        `${id}: ${summary.passed ? "ok" : "FAILED"} -- working set ${signed(growthMb, 1)} MB after warm-up ` +
            `(${settled.workingSetMb.toFixed(1)} -> ${last.workingSetMb.toFixed(1)} MB, ` +
            `frames ${settled.frame}..${last.frame}; trend ${signed(slopeMbPer1000Frames, 2)} MB per 1,000 frames), ` +
            `geometry ${last.geometryMb.toFixed(1)} MB, ` +
            `${last.meshRecords} mesh records for ${last.sceneMeshes} scene mesh entries, ` +
            `${last.geometryRecords} geometry records for ${last.liveGeometries} live, ` +
            `GC nodes ${settled.gcNodes} -> ${last.gcNodes}, ` +
            `${last.gcAllocations - settled.gcAllocations} GC allocations after warm-up`,
        ...summary.failures.map((failure) => `  FAILED: ${failure}`),
    ].join("\n");
}

/**
 * `scene -- memory <id|all>`: run a scene for many frames at the fixed
 * capture delta with BBLITE_MEM_PROFILE=1 and judge whether it settles
 * after the warm-up third (`summarizeMemoryProfile`). `all` runs the
 * registered application demos, the sources closest to a real program's
 * lifetime. A demo with a default gameplay tape (`checks/memory/<id>.json`)
 * plays it, because an idle program retires nothing; `--replay` or
 * `--replay-file` hands the run another tape (`--replay -` idles).
 */
export function runMemoryReport(
    idOrSource: string,
    memoryArguments: MemoryArguments,
): void {
    const selected =
        idOrSource === "all" ? applicationScenes : [resolveScene(idOrSource)];
    const backend = resolveBackend(memoryArguments.backend, "memory");
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
            artifactDirectory(
                "memory",
                `${scene.id}-${backendFileToken(backend)}.build-stamp`,
            ),
        );
        mkdirSync(resolve(stampPath, ".."), { recursive: true });
        rmSync(stampPath, { force: true });
        const defaultTape =
            memoryArguments.replay === undefined
                ? readMemoryTape(scene.id, memoryArguments.frames)
                : undefined;
        const replay = memoryArguments.replay ?? defaultTape?.tape.join(",");
        const stderr = spawnNativeMeasured(
            executable,
            {
                ...fixedCaptureEnvironment(),
                ...(backend === "dawn" ? { BBLITE_GPU_BACKEND: "dawn" } : {}),
                BBLITE_BENCHMARK_FRAMES: String(memoryArguments.frames),
                BBLITE_MEM_PROFILE: "1",
                BBLITE_BUILD_STAMP_OUT: stampPath,
                ...(replay !== undefined
                    ? { BBLITE_INPUT_REPLAY: replay }
                    : {}),
            },
            ["BBLITE_GPU_BACKEND"],
            true,
        );
        verifyBuildIdentity(executable, generatedDirectory, stampPath);
        const samples = parseMemoryProfile(stderr);
        const summary = summarizeMemoryProfile(
            samples,
            memoryArguments.maxSlopeMb,
            memoryArguments.frames,
        );
        const reportStem = stampPath.slice(0, -".build-stamp".length);
        writeFileSync(`${reportStem}.log`, stderr);
        writeReport(
            `${reportStem}.json`,
            {
                tool: "memory",
                backend,
                generatedDirectory,
            },
            {
                scene: scene.id,
                requestedFrames: memoryArguments.frames,
                maxSlopeMb: memoryArguments.maxSlopeMb,
                ...(memoryArguments.replay !== undefined
                    ? { replay: memoryArguments.replay }
                    : {}),
                ...(defaultTape !== undefined
                    ? { tape: defaultTape.path }
                    : {}),
                status:
                    summary === undefined
                        ? "unmeasured"
                        : summary.passed
                          ? "passed"
                          : "failed",
                samples,
                ...(summary !== undefined ? { summary } : {}),
            },
        );
        if (!summary) unmeasured += 1;
        if (summary && !summary.passed) failures += 1;
        console.log(
            `${formatMemorySummary(scene.id, summary)}${
                defaultTape !== undefined
                    ? `\n  tape: ${defaultTape.path}`
                    : replay === undefined
                      ? "\n  tape: none (idle)"
                      : ""
            }`,
        );
    }
    if (failures > 0 || unmeasured > 0) {
        throw new Error(
            `memory: ${failures} run(s) failed the gate; ${unmeasured} unmeasured run(s). See artifacts/memory/.`,
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

/**
 * Where a scene's parity artifacts land at a pose: the configured parity
 * directory (the canvas-only lane's under `BBLITE_CAPTURE_UI=0`), and a
 * `seek-<t>` subdirectory beneath it for a pose the golden does not hold —
 * a seeked run is a diagnostic with its own browser reference, so it can
 * never overwrite the registry-pose evidence or the committed golden.
 */
export function parityOutputDirectory(
    scene: SceneDefinition & { parity: SceneParityDefinition },
    pose: ScenePose,
): string {
    const base = captureUiEnabled()
        ? resolve(scene.parity.outputDirectory)
        : resolve(artifactDirectory("parity-canvas", scene.id));
    return pose.golden ? base : resolve(base, `seek-${pose.seekSeconds}`);
}

/** One backend's run of the parity gate. */
export interface SceneParityRun {
    backend: NativeBackend;
    seekSeconds?: number;
    without?: SuppressibleElement;
    actual?: string;
    attribute: boolean;
    recaptureReference: boolean;
    noFail: boolean;
}

async function runSceneParity(
    scene: SceneDefinition,
    run: SceneParityRun,
): Promise<void> {
    const config = scene.parity;
    if (!config)
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    const { backend, without } = run;
    const captureUi = captureUiEnabled();
    const canvasOnly = !captureUi;
    const pose = resolvePose(scene, run.seekSeconds);
    // A pose the golden does not hold is measured against a browser
    // capture at that pose, in its own directory, and gates nothing.
    const seekedPose = !pose.golden;
    const outputDirectory = parityOutputDirectory(
        { ...scene, parity: config },
        pose,
    );
    const compiledManifest = readCompiledSceneManifest(scene);
    const retainedUiCapture =
        captureUi &&
        Array.isArray(compiledManifest?.features) &&
        compiledManifest.features.includes("ui:rml");
    const reference =
        canvasOnly || seekedPose
            ? resolve(
                  outputDirectory,
                  canvasOnly ? "browser-canvas.png" : "browser.png",
              )
            : resolve(config.reference.path);
    mkdirSync(outputDirectory, { recursive: true });
    // Backend-suffixed artifacts keep every backend's outputs side by
    // side in the scene's parity directory ("gpu" stays the SDL_GPU
    // suffix for continuity). A suppression run appends its element so
    // the standard run's artifacts stay untouched beside it.
    const artifactSuffix =
        backendFileToken(backend) +
        (without !== undefined ? `-without-${without}` : "");
    const actual = resolve(
        run.actual ?? parityNativeImagePath(outputDirectory, artifactSuffix),
    );
    const seek = run.seekSeconds;
    // A run with an element suppressed, or at another pose, is an
    // attribution measurement: its numbers are meant to move, so gating
    // them against the registry thresholds would fail it for working.
    const thresholds =
        canvasOnly || without !== undefined || seekedPose
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
    const idBufferPath =
        !without && config.attribution?.drawIds
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
        run.recaptureReference ||
        ((canvasOnly || seekedPose) && !existsSync(reference));
    const browserReferenceFrame = goldenFixedFrame(scene, retainedUiCapture);
    validateReferenceCapture(scene, reference, recaptureReference);
    // What both browser captures share: the seeded-random stub, the
    // companion DOM and the registry's pose search. The DOM is present in
    // a canvas-only capture too -- the harness hides it from the canvas
    // screenshot, and a page script that binds to it (the screen-space
    // toggles) would otherwise throw before the scene starts.
    const sharedCaptureOptions = {
        seededRandom: manifestUsesSeededRandom(compiledManifest),
        showScrollbars: config.referenceScrollbars ?? false,
        ...(config.independentEngines === undefined
            ? {}
            : { independentEngines: config.independentEngines }),
        ...(config.referenceHostPage === undefined
            ? {}
            : { hostPage: config.referenceHostPage }),
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
        pose.seekSeconds,
        config.referenceAnimationGroups,
        {
            ...sharedCaptureOptions,
            ...(browserReferenceFrame !== undefined
                ? { fixedAnimationFrame: browserReferenceFrame }
                : {}),
        },
    );
    if (run.actual === undefined) {
        runMeasured(resolveNativeExecutable(undefined, scene.buildDirectory), {
            generatedDirectory: resolve(scene.output),
            environment: {
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
            backend,
            screenshot: actual,
            ...(idBufferPath !== undefined ? { idBuffer: idBufferPath } : {}),
            ...(clusterBufferPath !== undefined
                ? { clusterBuffer: clusterBufferPath }
                : {}),
        });
    }

    if (run.attribute) {
        for (const buffer of [idBufferPath, clusterBufferPath]) {
            if (!buffer || !existsSync(buffer))
                throw new Error(
                    `The instrumented renderer did not produce attribution buffer '${buffer ?? "unconfigured"}'.`,
                );
        }
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
    const region = compareRegion(
        actual,
        reference,
        config.backgroundColor,
        config.backgroundThreshold,
    );
    const breakdown = analyzeDifference(
        actual,
        reference,
        config.backgroundColor,
        config.backgroundThreshold,
    );
    const idBreakdown =
        idBufferPath && existsSync(idBufferPath)
            ? analyzeIdBuffer(
                  actual,
                  reference,
                  idBufferPath,
                  breakdown.hotspots,
              )
            : undefined;
    if (idBufferPath && idVisualizationPath && existsSync(idBufferPath)) {
        generateIdVisualization(idBufferPath, idVisualizationPath);
    }
    const specialization = config.attribution?.specialization;
    const specializations =
        specialization && existsSync(resolve(specialization))
            ? (JSON.parse(
                  readFileSync(resolve(specialization), "utf8"),
              ) as GltfSpecialization[])
            : [];
    const renderItems = new Map(
        specializations
            .flatMap((specialization) => specialization.renderItems)
            .map((item) => [item.drawId, item] as const),
    );
    const renderItemForCluster = (
        clusterId: number,
    ): RenderItemSpecialization | undefined =>
        specializations
            .flatMap((specialization) => specialization.renderItems)
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
            ? analyzeIdBuffer(
                  actual,
                  reference,
                  clusterBufferPath,
                  breakdown.hotspots,
              )
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
    const hotspotClusterAttribution = clusterBreakdown?.hotspots.map(
        (hotspot) => {
            const { drawIds, ...region } = hotspot;
            return {
                ...region,
                clusterIds: drawIds.map(({ drawId, pixels }) => ({
                    clusterId: drawId,
                    pixels,
                    renderItem: renderItemForCluster(drawId),
                })),
            };
        },
    );
    const diffPath = resolve(outputDirectory, `diff-map-${artifactSuffix}.png`);
    const hotspotPath = resolve(
        outputDirectory,
        `hotspots-${artifactSuffix}.png`,
    );
    generateDiffMap(actual, reference, diffPath);
    generateHotspotMap(actual, breakdown.hotspots, hotspotPath);

    // The canvas-only lane: a UI-dominated application gates the full
    // page at its glyph-rasterization residual, which is loose enough for
    // a genuine 3D regression of a few tenths MAD to hide under. A scene declaring `canvasThresholds` therefore also
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
        run.actual === undefined
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
            artifactDirectory("parity-canvas", scene.id),
        );
        mkdirSync(canvasDirectory, { recursive: true });
        // The reference reproduces the attribution run exactly — the
        // companion DOM present but hidden, the canvas screenshot
        // excluding the page, at the pose that run derives
        // (`referenceFrame` when the registry declares one; tetris
        // settles onto its ad-hoc native frame) — and follows the
        // committed golden's lifecycle: captured when missing,
        // recaptured only with --recapture-reference.
        const canvasReference = resolve(canvasDirectory, "browser-canvas.png");
        await withEnvironment("BBLITE_CAPTURE_UI", "0", () =>
            captureSuiteReference(
                scene.source,
                canvasReference,
                run.recaptureReference,
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
        runMeasured(resolveNativeExecutable(undefined, scene.buildDirectory), {
            generatedDirectory: resolve(scene.output),
            environment: {
                ...config.nativeEnvironment,
                BBLITE_CAPTURE_UI: "0",
            },
            backend,
            screenshot: canvasActual,
        });
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
        sourceOrigin: scene.sourceOrigin ?? "babylon-lite",
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
            ...(idBufferPath && existsSync(idBufferPath)
                ? { drawIds: idBufferPath }
                : {}),
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
                "and the element whose removal makes the number worse is not the culprit.",
        );
    } else if (seekedPose) {
        console.log(
            `Seeked pose (${pose.seekSeconds}s): measured against a browser capture at that pose in ${outputDirectory}; ` +
                "diagnostic only, the golden and its thresholds describe the registry pose.",
        );
    } else if (thresholds.gate === "diagnostic-only") {
        console.warn(
            "Parity result is diagnostic-only because no thresholds are configured.",
        );
    }
    console.log(
        `${scene.name} full image (${full.totalPixels} px): MAD=${full.mad.toFixed(3)}, max=${full.maxDiff}`,
    );
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
        failures.push(
            `region MAD ${region.mad.toFixed(3)} > ${thresholds.maxRegionMad}`,
        );
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
        if (run.noFail) console.warn(message);
        else throw new Error(message);
    }
}

/**
 * The reader slices of the two report families this module writes: the
 * per-backend parity report (`runSceneParity`) and the differential
 * merge (`runParityBackends`). The writers are single; these
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

/**
 * The parity gate over `backends`, in order, stopping at the first backend
 * that fails its gate. With both backends and nothing suppressed or
 * supplied, the two native images are then diffed against each other —
 * the decisive diagnostic (backend agreement to one LSB puts a divergence
 * on the CPU side; disagreement puts it on the GPU side) — and the merged
 * report lands beside the per-backend ones. The browser reference is
 * captured (or recaptured) by the first backend's run only.
 */
export async function runParityBackends(
    scene: SceneDefinition,
    backends: readonly NativeBackend[],
    options: Omit<SceneParityRun, "backend">,
): Promise<void> {
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const pose = resolvePose(scene, options.seekSeconds);
    for (const [index, backend] of backends.entries()) {
        await runSceneParity(scene, {
            ...options,
            backend,
            // A seeked pose is measured against its own browser capture,
            // taken once per invocation at that pose.
            recaptureReference:
                index === 0 && (options.recaptureReference || !pose.golden),
        });
    }
    if (
        backends.length !== 2 ||
        options.without !== undefined ||
        options.actual !== undefined
    ) {
        return;
    }
    const outputDirectory = parityOutputDirectory(
        { ...scene, parity: config },
        pose,
    );
    // Each backend run writes its own suffixed actual, so the two images
    // sit side by side without a copy step and neither run can overwrite
    // the other's.
    const sdlImage = parityNativeImagePath(outputDirectory, "gpu");
    const dawnImage = parityNativeImagePath(outputDirectory, "dawn");
    const backendDelta = compareImages(sdlImage, dawnImage);
    const readBackendReport = (suffix: string): ParityReportSummary =>
        JSON.parse(
            readFileSync(parityReportPath(outputDirectory, suffix), "utf8"),
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
// `scene -- parity <id> --runs N` — the run-to-run wobble check
//
// Some scenes render differently from one run to the next with no code
// change at all (`scene-neutrality.ts` lists the measured ones, per
// backend). This mode is that check on demand, with its one trap built
// in: comparing runs only against each other hides a stable-but-wrong
// image, so every run is also compared against the golden and both
// columns always print.
// ---------------------------------------------------------------------------

export interface StabilityRun {
    backend: NativeBackend;
    runs: number;
    singleSample: boolean;
    /** Render every run at this pose instead of the registry's. At a
     *  pose the golden does not hold the golden columns are suppressed:
     *  a cross-pose comparison measures nothing. */
    seekSeconds?: number;
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
            (right.vsFirst?.mad ?? 0) > (left.vsFirst?.mad ?? 0) ? right : left,
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
                    "so every scene reads worse against them at one sample.",
            );
        } else if (wobbling.length === 0 && first.vsGolden.maxDiff > 0) {
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
    scene: SceneDefinition,
    stabilityArguments: StabilityRun,
): void {
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const { backend } = stabilityArguments;
    const reference = resolve(config.reference.path);
    // `--seek` at the registry pose is the standard measurement with the
    // pose written explicitly; any other pose suppresses the golden
    // columns — the golden holds the registry pose, so a cross-pose
    // comparison measures nothing.
    const seek = stabilityArguments.seekSeconds;
    const goldenComparable = resolvePose(scene, seek).golden;
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
    const executable = resolveNativeExecutable(undefined, scene.buildDirectory);
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
        runMeasured(executable, {
            generatedDirectory: resolve(scene.output),
            environment: {
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
            backend,
            screenshot: image,
        });
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
