/**
 * `scene -- check <id>`: the driver over a declared check (`check-spec.ts`).
 *
 * One driver owns what every interaction check shares — the executable,
 * the environment composition (registry pose first, then the phase
 * window), the backend loop, the stale-output deletion, the log scan,
 * the build-identity gate, the expectation vocabulary and the report —
 * so a check's pose cannot silently differ from parity's and a checker
 * cannot forget a gate. Scene-specific arithmetic runs from the plugin
 * modules a check names.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import {
    adHocCaptureEnvironment,
    fixedCaptureEnvironment,
} from "../capture-timing.js";
import { compareImages, compareRegion, type CompareResult } from "../parity.js";
import type { SceneDefinition } from "../scene-registry.js";
import { NATIVE_BACKENDS, defaultCheckDirectory } from "./artifacts.js";
import { readCapturePath } from "./capture-path.js";
import {
    expandTape,
    type CheckExpectation,
    type CheckPhase,
    type CheckSpec,
} from "./check-spec.js";
import {
    NATIVE_LOG_ERROR_PATTERN,
    enableGpuDebug,
    runMeasured,
} from "./native-run.js";
import { readReport, writeReport } from "./reports.js";
import { computeBuildStamp } from "../build-stamp.js";

/** The generated tree and build a check runs against: the scene's own,
 *  or its twin (`generated/<id>-live`). */
export interface CheckTarget {
    output: string;
    buildDirectory: string;
    executable: string;
}

export interface CheckRunOptions {
    checkId: string;
    scene: SceneDefinition;
    spec: CheckSpec;
    target: CheckTarget;
    /** The backends to run; every one by default. */
    backends?: readonly string[];
    /** Only this phase (its expectations that name other phases skip). */
    phase?: string;
    /** Reuse phase outputs whose build stamp is current instead of rendering. */
    keep?: boolean;
}

/** What one phase's native run left: the image, the capture, the log. */
export interface PhaseResult {
    id: string;
    backend: string;
    frame: number;
    image: string;
    capturePath?: string;
    capture?: unknown;
    log: string;
    logPath: string;
    buildStamp: string;
    kept: boolean;
}

export interface ExpectationResult {
    index: number;
    kind: string;
    phase?: string;
    backend?: string;
    ok: boolean;
    detail: string;
}

export interface CheckVerdict {
    ok: boolean;
    reportPath: string;
    results: ExpectationResult[];
}

/** The observation report `scene -- observe` writes, as the check reads it. */
export interface ObservationsReport {
    sourceSha256?: string;
    moduleSha256?: string;
    referenceSha256?: string;
    captureFrames?: Array<{ frame: number; image?: string; state?: unknown }>;
    steps?: Array<{ id: string; image?: string; state?: unknown; extras?: Record<string, unknown>; errors?: string[] }>;
}

export function observationsPath(outputDirectory: string): string {
    return resolve(outputDirectory, "browser", "observations.json");
}

/** The context a plugin module's `check(context)` receives. */
export interface PluginContext {
    checkId: string;
    scene: SceneDefinition;
    spec: CheckSpec;
    target: CheckTarget;
    outputDirectory: string;
    options: Record<string, unknown>;
    backends: readonly string[];
    /** Phase results, by backend then phase id. */
    results: Record<string, Record<string, PhaseResult>>;
    observations: ObservationsReport | undefined;
    observeDirectory: string;
    /** The same phase across every backend, in backend order. */
    phase(id: string): PhaseResult[];
    log(message: string): void;
}

/** What a plugin returns; a thrown error (an assertion) is a failure. */
export interface PluginOutcome {
    findings?: string[];
    details?: unknown;
}

const MEASUREMENT_VARIABLES = [
    "BBLITE_SCREENSHOT",
    "BBLITE_SCREENSHOT_FRAME",
    "BBLITE_MAX_FRAMES",
    "BBLITE_RENDER_CAPTURE",
    "BBLITE_ANIMATION_SEEK_SECONDS",
    "BBLITE_INPUT_REPLAY",
    "BBLITE_CAPTURE_ENGINE_FRAME",
    "BBLITE_FRAME_DELTA_MS",
    "BBLITE_NODE_GPU_CAPTURE",
    "BBLITE_CAPTURE_UI",
    "BBLITE_MSAA",
    "BBLITE_RUNTIME_TRACE",
    "BBLITE_WINDOW_TRACE",
    "BBLITE_PHYSICS_TRACE",
];

/**
 * The environment base a check's phases share: the registry pose first
 * (`docs/debugging.md`: a checker spreads it before its own frame
 * window), then the ad-hoc or fixed clock a check asks for.
 */
export function checkEnvironmentBase(
    scene: SceneDefinition,
    spec: CheckSpec,
): Record<string, string> {
    const registry = scene.parity?.nativeEnvironment ?? {};
    switch (spec.base ?? "registry") {
        case "registry":
            return { ...registry };
        case "adhoc":
            return { ...registry, ...adHocCaptureEnvironment() };
        case "fixed":
            return { ...registry, ...fixedCaptureEnvironment() };
        case "none":
            return {};
    }
}

function phaseStem(outputDirectory: string, backend: string, phase: CheckPhase): string {
    return resolve(outputDirectory, `${backend}-${phase.id}`);
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

function runPhase(
    options: CheckRunOptions,
    outputDirectory: string,
    backend: string,
    phase: CheckPhase,
    base: Readonly<Record<string, string>>,
    expectedStamp: string,
): PhaseResult {
    const { spec, target } = options;
    const stem = phaseStem(outputDirectory, backend, phase);
    const image = `${stem}.png`;
    const wantsCapture = phase.capture ?? spec.capture ?? true;
    const capturePath = wantsCapture ? `${stem}.json` : undefined;
    const logPath = `${stem}.log`;
    const stampPath = `${image}.build-stamp`;
    const tape = phase.tape === undefined ? undefined : expandTape(phase.tape);
    const readBack = (kept: boolean): PhaseResult => ({
        id: phase.id,
        backend,
        frame: phase.frame,
        image,
        ...(capturePath !== undefined
            ? { capturePath, capture: readJson(capturePath) }
            : {}),
        log: readFileSync(logPath, "utf8"),
        logPath,
        buildStamp: readFileSync(stampPath, "utf8").trim(),
        kept,
    });
    if (
        options.keep &&
        existsSync(image) &&
        existsSync(logPath) &&
        existsSync(stampPath) &&
        (capturePath === undefined || existsSync(capturePath)) &&
        readFileSync(stampPath, "utf8").trim() === expectedStamp
    ) {
        return readBack(true);
    }
    const { log } = runMeasured(target.executable, {
        generatedDirectory: target.output,
        environment: {
            BBLITE_RUNTIME_TRACE: "1",
            ...base,
            ...spec.env,
            ...phase.env,
        },
        backend,
        testPass: spec.testPass ?? false,
        frame: phase.frame,
        maxFrames: Math.max(phase.maxFrames ?? 0, spec.minFrames ?? 0),
        screenshot: image,
        ...(capturePath !== undefined ? { capture: capturePath } : {}),
        ...(phase.seek !== undefined ? { seekSeconds: phase.seek } : {}),
        ...(tape !== undefined ? { tape } : {}),
        dropVariables: MEASUREMENT_VARIABLES,
        captureLog: true,
        timeoutMs: spec.timeoutMs ?? 60_000,
    });
    writeFileSync(logPath, log);
    const errorPattern =
        spec.logErrorPattern === undefined
            ? NATIVE_LOG_ERROR_PATTERN
            : new RegExp(spec.logErrorPattern, "i");
    const errorLine = log.split(/\r?\n/).find((line) => errorPattern.test(line));
    if (errorLine !== undefined) {
        throw new Error(
            `${backend}/${phase.id}: the native log reports an error: ${errorLine} (see ${logPath})`,
        );
    }
    if (capturePath !== undefined && !existsSync(capturePath)) {
        throw new Error(
            `${backend}/${phase.id}: the run wrote no render capture to ${capturePath}; the frame window ended before the capture frame or the executable predates the capture writers.`,
        );
    }
    return readBack(false);
}

function imageDimensions(path: string): [number, number] {
    const png = PNG.sync.read(readFileSync(path));
    return [png.width, png.height];
}

function describe(value: unknown): string {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

interface Evaluation {
    scene: SceneDefinition;
    spec: CheckSpec;
    outputDirectory: string;
    results: Record<string, Record<string, PhaseResult>>;
    observations: ObservationsReport | undefined;
    backends: readonly string[];
}

/** Resolve an image reference for `backend`: a phase, the golden, or a browser observation. */
function referenceImage(
    evaluation: Evaluation,
    backend: string,
    reference: string,
): { path: string; label: string } {
    if (reference === "golden") {
        const path = evaluation.scene.parity?.reference.path;
        if (path === undefined) throw new Error(`scene '${evaluation.scene.id}' has no golden`);
        return { path: resolve(path), label: "golden" };
    }
    if (reference.startsWith("browser:")) {
        const id = reference.slice("browser:".length);
        const observations = evaluation.observations;
        if (observations === undefined) {
            throw new Error(
                `'${reference}' needs browser observations; run 'scene -- observe' for this check first`,
            );
        }
        const frameMatch = /^frame-(\d+)$/.exec(id);
        const image = frameMatch
            ? observations.captureFrames?.find((entry) => entry.frame === Number(frameMatch[1]))?.image
            : observations.steps?.find((step) => step.id === id)?.image;
        if (image === undefined) {
            throw new Error(`the browser observations carry no image for '${id}'`);
        }
        return { path: resolve(evaluation.outputDirectory, "browser", image), label: reference };
    }
    const phase = evaluation.results[backend]?.[reference];
    if (phase === undefined) throw new Error(`phase '${reference}' has no result for ${backend}`);
    return { path: phase.image, label: `phase ${reference}` };
}

function phaseResult(evaluation: Evaluation, backend: string, id: string): PhaseResult {
    const result = evaluation.results[backend]?.[id];
    if (result === undefined) throw new Error(`phase '${id}' has no result for ${backend}`);
    return result;
}

function within(label: string, value: number, min: number | undefined, max: number | undefined): string[] {
    const problems: string[] = [];
    if (min !== undefined && !(value > min)) problems.push(`${label} ${value} is not > ${min}`);
    if (max !== undefined && !(value < max)) problems.push(`${label} ${value} is not < ${max}`);
    return problems;
}

function evaluateForBackendPhase(
    evaluation: Evaluation,
    expectation: Exclude<CheckExpectation, { kind: "plugin" }>,
    backend: string,
    phase: PhaseResult,
): string[] {
    switch (expectation.kind) {
        case "capture-path": {
            const value = readCapturePath(phase.capture, expectation.path);
            const problems: string[] = [];
            if ("equals" in expectation) {
                try {
                    assert.deepEqual(value, expectation.equals);
                } catch {
                    problems.push(`${expectation.path} is ${describe(value)}, expected ${describe(expectation.equals)}`);
                }
            }
            if (expectation.min !== undefined || expectation.max !== undefined || expectation.finite) {
                // Numeric bounds apply to every leaf a path yields: a
                // position list yields triples, and each lane is judged.
                const leaves = (entry: unknown): unknown[] =>
                    Array.isArray(entry) ? entry.flatMap(leaves) : [entry];
                for (const entry of leaves(value)) {
                    if (typeof entry !== "number") {
                        problems.push(`${expectation.path} yields ${describe(entry)}, not a number`);
                        continue;
                    }
                    if (expectation.finite && !Number.isFinite(entry)) {
                        problems.push(`${expectation.path} yields ${entry}`);
                    }
                    problems.push(...within(expectation.path, entry, expectation.min, expectation.max));
                }
            }
            return problems;
        }
        case "capture-same":
        case "capture-differs": {
            const other = phaseResult(evaluation, backend, expectation.vs);
            const left = readCapturePath(phase.capture, expectation.path);
            const right = readCapturePath(other.capture, expectation.path);
            let same = true;
            try {
                assert.deepEqual(left, right);
            } catch {
                same = false;
            }
            if (expectation.kind === "capture-same" && !same) {
                return [`${expectation.path} differs from phase ${expectation.vs}: ${describe(left)} vs ${describe(right)}`];
            }
            if (expectation.kind === "capture-differs" && same) {
                return [`${expectation.path} equals phase ${expectation.vs}: ${describe(left)}`];
            }
            return [];
        }
        case "capture-compare": {
            const other = phaseResult(evaluation, backend, expectation.vs);
            const left = readCapturePath(phase.capture, expectation.path);
            const right = readCapturePath(other.capture, expectation.path);
            if (typeof left !== "number" || typeof right !== "number") {
                return [`${expectation.path} must be numeric on both sides (got ${describe(left)} and ${describe(right)})`];
            }
            const holds =
                expectation.op === ">" ? left > right
                : expectation.op === "<" ? left < right
                : expectation.op === ">=" ? left >= right
                : left <= right;
            return holds ? [] : [`${expectation.path} ${left} is not ${expectation.op} phase ${expectation.vs}'s ${right}`];
        }
        case "camera-delta": {
            const other = phaseResult(evaluation, backend, expectation.vs);
            const left = readCapturePath(phase.capture, `camera.${expectation.key}`);
            const right = readCapturePath(other.capture, `camera.${expectation.key}`);
            if (typeof left !== "number" || typeof right !== "number") {
                return [`camera.${expectation.key} must be numeric on both sides (got ${describe(left)} and ${describe(right)})`];
            }
            return within(`|camera.${expectation.key} delta vs ${expectation.vs}|`, Math.abs(left - right), expectation.min, expectation.max);
        }
        case "image-mad": {
            const reference = referenceImage(evaluation, backend, expectation.vs);
            const comparison = compareImages(phase.image, reference.path);
            const problems = within(`image MAD vs ${reference.label}`, comparison.mad, expectation.min, expectation.max);
            if (expectation.maxDiff !== undefined && comparison.maxDiff > expectation.maxDiff) {
                problems.push(`image max channel difference vs ${reference.label} is ${comparison.maxDiff}, allowed ${expectation.maxDiff}`);
            }
            if (expectation.changedPixelsMin !== undefined) {
                const changed = comparison.totalPixels - comparison.exactMatch;
                if (changed < expectation.changedPixelsMin) {
                    problems.push(`${changed} pixel(s) differ from ${reference.label}, expected at least ${expectation.changedPixelsMin}`);
                }
            }
            return problems;
        }
        case "viewport": {
            const problems: string[] = [];
            const viewport = readCapturePath(phase.capture, "viewport");
            if (phase.capture !== undefined) {
                try {
                    assert.deepEqual(viewport, { width: expectation.equals[0], height: expectation.equals[1] });
                } catch {
                    problems.push(`capture viewport is ${describe(viewport)}, expected ${expectation.equals.join("x")}`);
                }
            }
            const [width, height] = imageDimensions(phase.image);
            if (width !== expectation.equals[0] || height !== expectation.equals[1]) {
                problems.push(`image is ${width}x${height}, expected ${expectation.equals.join("x")}`);
            }
            return problems;
        }
        case "golden-mad": {
            const reference = referenceImage(evaluation, backend, expectation.reference ?? "golden");
            const parity = evaluation.scene.parity;
            const background = expectation.background ?? parity?.backgroundColor;
            const threshold = expectation.threshold ?? parity?.backgroundThreshold ?? 30;
            const full = compareImages(phase.image, reference.path);
            const problems: string[] = [];
            if (full.mad >= expectation.max) {
                problems.push(`full MAD vs ${reference.label} ${full.mad.toFixed(4)} is not < ${expectation.max}`);
            }
            if (expectation.foregroundMax !== undefined) {
                if (background === undefined) {
                    problems.push("foregroundMax needs a background colour (registry or 'background')");
                } else {
                    const region = compareRegion(phase.image, reference.path, background, threshold);
                    if (region.mad >= expectation.foregroundMax) {
                        problems.push(`foreground MAD vs ${reference.label} ${region.mad.toFixed(4)} is not < ${expectation.foregroundMax}`);
                    }
                }
            }
            return problems;
        }
        case "log-match": {
            const pattern = new RegExp(expectation.pattern, expectation.flags ?? "");
            const matches = [...phase.log.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
            if (expectation.absent) {
                return matches.length === 0 ? [] : [`log matches /${expectation.pattern}/ ${matches.length} time(s): ${matches[0]![0]}`];
            }
            if (expectation.count !== undefined && matches.length !== expectation.count) {
                return [`log matches /${expectation.pattern}/ ${matches.length} time(s), expected ${expectation.count}`];
            }
            return matches.length > 0 || expectation.count === 0 ? [] : [`log does not match /${expectation.pattern}/`];
        }
        case "backends-agree":
            // Evaluated once per phase across backends, not per backend.
            return [];
    }
}

function evaluateBackendsAgree(
    evaluation: Evaluation,
    expectation: Extract<CheckExpectation, { kind: "backends-agree" }>,
    phaseId: string,
): string[] {
    const backends = evaluation.backends.filter((backend) => evaluation.results[backend]?.[phaseId] !== undefined);
    if (backends.length < 2) return [];
    const [first, ...others] = backends.map((backend) => evaluation.results[backend]![phaseId]!);
    const problems: string[] = [];
    for (const other of others) {
        for (const path of expectation.paths ?? []) {
            const left = readCapturePath(first!.capture, path);
            const right = readCapturePath(other.capture, path);
            try {
                assert.deepEqual(left, right);
            } catch {
                problems.push(`${path} differs between ${first!.backend} and ${other.backend}: ${describe(left)} vs ${describe(right)}`);
            }
        }
        if (expectation.imageMaxDiff !== undefined || expectation.imageMad !== undefined) {
            const comparison: CompareResult = compareImages(first!.image, other.image);
            if (expectation.imageMaxDiff !== undefined && comparison.maxDiff > expectation.imageMaxDiff) {
                problems.push(`images differ between ${first!.backend} and ${other.backend} by max ${comparison.maxDiff}, allowed ${expectation.imageMaxDiff}`);
            }
            if (expectation.imageMad !== undefined && comparison.mad >= expectation.imageMad) {
                problems.push(`image MAD between ${first!.backend} and ${other.backend} is ${comparison.mad.toFixed(4)}, not < ${expectation.imageMad}`);
            }
        }
    }
    return problems;
}

async function runPlugin(
    options: CheckRunOptions,
    outputDirectory: string,
    expectation: Extract<CheckExpectation, { kind: "plugin" }>,
    evaluation: Evaluation,
): Promise<PluginOutcome> {
    const modulePath = resolve(expectation.module);
    if (!existsSync(modulePath)) {
        throw new Error(`plugin module not found: ${modulePath}`);
    }
    const loaded: unknown = await import(pathToFileURL(modulePath).href);
    const check = (loaded as { check?: unknown }).check;
    if (typeof check !== "function") {
        throw new Error(`${expectation.module} exports no check(context) function`);
    }
    const context: PluginContext = {
        checkId: options.checkId,
        scene: options.scene,
        spec: options.spec,
        target: options.target,
        outputDirectory,
        options: expectation.options ?? {},
        backends: evaluation.backends,
        results: evaluation.results,
        observations: evaluation.observations,
        observeDirectory: resolve(outputDirectory, "browser"),
        phase: (id) =>
            evaluation.backends.flatMap((backend) => {
                const result = evaluation.results[backend]?.[id];
                return result === undefined ? [] : [result];
            }),
        log: (message) => console.log(`  [${basename(expectation.module)}] ${message}`),
    };
    const outcome: unknown = await (check as (context: PluginContext) => unknown)(context);
    if (outcome === undefined || outcome === null) return {};
    if (typeof outcome !== "object") {
        throw new Error(`${expectation.module} returned ${describe(outcome)}; a plugin returns { findings?, details? } or nothing`);
    }
    return outcome as PluginOutcome;
}

export async function runCheck(options: CheckRunOptions): Promise<CheckVerdict> {
    const { checkId, scene, spec, target } = options;
    if (spec.gpuDebug !== false) {
        enableGpuDebug();
    } else {
        // A timing measurement runs without the validation layer, and
        // without an ambient one either.
        delete process.env.BBLITE_GPU_DEBUG;
    }
    const outputDirectory = resolve(defaultCheckDirectory(checkId));
    const backends = [...(options.backends ?? NATIVE_BACKENDS)];
    const phases = options.phase === undefined
        ? spec.phases
        : spec.phases.filter((phase) => phase.id === options.phase);
    if (options.phase !== undefined && phases.length === 0) {
        throw new Error(
            `check ${checkId}: no phase '${options.phase}' (declared: ${spec.phases.map((phase) => phase.id).join(", ")})`,
        );
    }
    const base = checkEnvironmentBase(scene, spec);
    const expectedStamp = phases.length > 0 ? computeBuildStamp(resolve(target.output)).stamp : "";
    const results: Record<string, Record<string, PhaseResult>> = {};
    for (const backend of backends) {
        results[backend] = {};
        for (const phase of phases) {
            const started = Date.now();
            const result = runPhase(options, outputDirectory, backend, phase, base, expectedStamp);
            results[backend]![phase.id] = result;
            console.log(
                `check ${checkId}: ${backend}/${phase.id} frame ${phase.frame} ${
                    result.kept ? "kept" : `rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`
                }`,
            );
        }
    }
    const observations = readReport<ObservationsReport>(observationsPath(outputDirectory));
    const evaluation: Evaluation = { scene, spec, outputDirectory, results, observations, backends };
    const expectationResults: ExpectationResult[] = [];
    const record = (entry: ExpectationResult): void => {
        expectationResults.push(entry);
        const where = [entry.backend, entry.phase].filter((part) => part !== undefined).join("/");
        console.log(`  ${entry.ok ? "ok  " : "FAIL"} #${entry.index} ${entry.kind}${where ? ` ${where}` : ""}: ${entry.detail}`);
    };
    const selectedIds = new Set(phases.map((phase) => phase.id));
    // The one implicit expectation: a capture describes the frame the
    // phase asked for. A run that ended early or a capture writer that
    // fired on another frame would otherwise pass every declared
    // expectation against the wrong frame. Frame 0 asks for the first
    // frame the scene is ready on, which the runtime chooses; that frame
    // is recorded rather than compared.
    for (const backend of backends) {
        for (const phase of phases) {
            const result = results[backend]![phase.id]!;
            if (result.capture === undefined) continue;
            const frame = readCapturePath(result.capture, "frame");
            const firstReady = phase.frame === 0 && typeof frame === "number" && frame >= 0;
            record({
                index: -1, kind: "frame", phase: phase.id, backend,
                ok: firstReady || frame === phase.frame,
                detail: firstReady
                    ? `first ready frame ${describe(frame)}`
                    : frame === phase.frame
                      ? `captured frame ${phase.frame}`
                      : `capture describes frame ${describe(frame)}, phase asked for ${phase.frame}`,
            });
        }
    }
    for (const [index, expectation] of spec.expect.entries()) {
        if (expectation.kind === "plugin") {
            try {
                const outcome = await runPlugin(options, outputDirectory, expectation, evaluation);
                const findings = outcome.findings ?? [];
                record({
                    index, kind: "plugin",
                    ok: findings.length === 0,
                    detail: findings.length === 0
                        ? `${expectation.module} passed`
                        : `${expectation.module}: ${findings.join("; ")}`,
                });
            } catch (error) {
                record({ index, kind: "plugin", ok: false, detail: `${expectation.module}: ${(error as Error).message}` });
            }
            continue;
        }
        const targets = expectation.phase === "*"
            ? phases.map((phase) => phase.id)
            : selectedIds.has(expectation.phase) ? [expectation.phase] : [];
        if (targets.length === 0) {
            record({ index, kind: expectation.kind, phase: expectation.phase, ok: true, detail: "skipped (phase not selected)" });
            continue;
        }
        if ("vs" in expectation && expectation.kind !== "image-mad" && !selectedIds.has(expectation.vs)) {
            record({ index, kind: expectation.kind, phase: expectation.phase, ok: true, detail: `skipped (phase '${expectation.vs}' not selected)` });
            continue;
        }
        for (const phaseId of targets) {
            if (expectation.kind === "backends-agree") {
                if (backends.length < 2) {
                    record({ index, kind: expectation.kind, phase: phaseId, ok: true, detail: "skipped (one backend)" });
                    continue;
                }
                const problems = evaluateBackendsAgree(evaluation, expectation, phaseId);
                record({
                    index, kind: expectation.kind, phase: phaseId,
                    ok: problems.length === 0,
                    detail: problems.length === 0 ? `${backends.join(" and ")} agree` : problems.join("; "),
                });
                continue;
            }
            for (const backend of backends) {
                const phase = results[backend]?.[phaseId];
                if (phase === undefined) continue;
                try {
                    const problems = evaluateForBackendPhase(evaluation, expectation, backend, phase);
                    record({
                        index, kind: expectation.kind, phase: phaseId, backend,
                        ok: problems.length === 0,
                        detail: problems.length === 0 ? (expectation.notes ?? "ok") : problems.join("; "),
                    });
                } catch (error) {
                    record({ index, kind: expectation.kind, phase: phaseId, backend, ok: false, detail: (error as Error).message });
                }
            }
        }
    }
    const failures = expectationResults.filter((entry) => !entry.ok);
    const reportPath = resolve(outputDirectory, "report.json");
    mkdirSync(outputDirectory, { recursive: true });
    writeReport(
        reportPath,
        { tool: "check", backend: backends.join("+"), generatedDirectory: resolve(target.output) },
        {
            check: checkId,
            scene: scene.id,
            target,
            phases: Object.fromEntries(
                backends.map((backend) => [
                    backend,
                    Object.fromEntries(
                        phases.map((phase) => {
                            const result = results[backend]![phase.id]!;
                            return [phase.id, {
                                frame: result.frame,
                                image: result.image,
                                ...(result.capturePath !== undefined ? { capture: result.capturePath } : {}),
                                log: result.logPath,
                                buildStamp: result.buildStamp,
                                kept: result.kept,
                            }];
                        }),
                    ),
                ]),
            ),
            expectations: expectationResults,
            status: failures.length === 0 ? "passed" : "failed",
        },
    );
    console.log(
        `check ${checkId}: ${expectationResults.length - failures.length}/${expectationResults.length} expectation(s) passed on ${backends.join(", ")}` +
            (failures.length > 0 ? `, ${failures.length} FAILED` : "") +
            `. Report: ${reportPath}`,
    );
    return { ok: failures.length === 0, reportPath, results: expectationResults };
}
