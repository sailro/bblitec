/**
 * The one way the scene tools run a generated `bblite_native` executable.
 *
 * Every measured run — parity, stability, the native capture, the
 * interaction checks, the physics-inputs extraction — resolves the
 * executable through `resolveNativeExecutable`, verifies the payload
 * deployed beside it, composes its `BBLITE_*` environment through
 * `runMeasured`, and verifies the build stamp the run reports. One
 * composition, so a checker's pose cannot silently differ from parity's.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
    comparePayload,
    computeBuildStamp,
    deployedPayloads,
} from "../build-stamp.js";

/**
 * Runs `body` with one environment variable set (or, for `undefined`,
 * deleted — deleting matters as much as setting: an ambient value would
 * otherwise survive into a run that chose otherwise), restoring the
 * previous state however the body ends. The body is awaited before the
 * restore, because restoring while spawned work is still running would
 * change the variable under it.
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
 * harness waiting on a prompt instead of naming itself ("Failed to close
 * command list" becomes "Store op is RESOLVE ... but texture is not
 * multisample" once it can print).
 */
export function enableGpuDebug(): void {
    process.env.BBLITE_GPU_DEBUG = "1";
    process.env.SDL_ASSERT = "always_ignore";
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
 * scene's own Release build. One resolver, so every command can be
 * pointed at another build the same way.
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
 * child, and the exit contract. `dropVariables` scrubs ambient variables
 * a caller sets explicitly (the capture drops `BBLITE_GPU_BACKEND` so an
 * ambient one cannot silently pick the other backend).
 */
export function spawnNativeMeasured(
    executable: string,
    overrides: Record<string, string>,
    dropVariables: readonly string[] = [],
    captureStderr = false,
    timeoutMs?: number,
    arguments_: readonly string[] = [],
): string {
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (name.toLowerCase().startsWith("npm_")) continue;
        if (dropVariables.includes(name)) continue;
        inherited[name] = value;
    }
    const result = spawnSync(resolve(executable), [...arguments_], {
        // A report that parses the renderer's frame lines takes stderr
        // back; every other measured run streams it to the terminal.
        stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "inherit",
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...inherited, ...overrides },
    });
    const tail = captureStderr && result.stderr ? `\n${result.stderr.slice(-2000)}` : "";
    if (result.error) {
        throw new Error(
            `Native renderer did not complete: ${result.error.message}` +
                (timeoutMs !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
                    ? ` (killed after ${timeoutMs} ms)`
                    : "") +
                tail,
        );
    }
    if (result.status !== 0) {
        throw new Error(`Native renderer exited with status ${result.status}.${tail}`);
    }
    return captureStderr ? result.stderr : "";
}

/**
 * A measured capture must run through the requested screenshot frame. The
 * frame number is zero-based, so frame 10 needs an eleven-frame budget.
 */
export function nativeCaptureFrameBudget(
    nativeEnvironment?: Readonly<Record<string, string>>,
): number {
    const screenshotFrame = Number.parseInt(
        nativeEnvironment?.BBLITE_SCREENSHOT_FRAME ?? "0",
        10,
    );
    return Number.isFinite(screenshotFrame) && screenshotFrame >= 0
        ? screenshotFrame + 1
        : 1;
}

export interface MeasuredRunOptions {
    /**
     * The generated tree the executable must have been built from. When
     * given, the payload beside the executable is verified before the
     * run and the reported build stamp after it (for a run that writes
     * a screenshot or capture; a run producing neither reports none).
     */
    generatedDirectory?: string;
    /**
     * Variables spread first: the scene's registry `nativeEnvironment`
     * (its deterministic clock and pose), so a check runs at the pose
     * parity measures unless it says otherwise.
     */
    environment?: Readonly<Record<string, string>>;
    /**
     * The zero-based screenshot frame. Sets `BBLITE_SCREENSHOT_FRAME`,
     * and `BBLITE_MAX_FRAMES` follows as `frame + 1` (or `maxFrames`
     * when larger). Absent, the frame `environment` declares decides the
     * budget.
     */
    frame?: number;
    maxFrames?: number;
    /** `BBLITE_ANIMATION_SEEK_SECONDS`. */
    seekSeconds?: number;
    /** `BBLITE_INPUT_REPLAY` entries (docs/debugging.md, the tape grammar). */
    tape?: readonly string[];
    /** Where the screenshot lands; deleted before the run. */
    screenshot?: string;
    /** Where the render capture lands (`BBLITE_RENDER_CAPTURE`); deleted before the run. */
    capture?: string;
    /** `BBLITE_ID_BUFFER` / `BBLITE_CLUSTER_BUFFER` attribution outputs. */
    idBuffer?: string;
    clusterBuffer?: string;
    /**
     * The backend for this run. Given, the ambient `BBLITE_GPU_BACKEND`
     * is scrubbed and replaced; absent, the ambient selection stands.
     */
    backend?: string;
    /**
     * `BBLITE_TEST_PASS`. A measured render is a hidden test pass
     * (`true`, the default); an interaction check runs outside one,
     * because pointer callbacks only attach there.
     */
    testPass?: boolean;
    /** Variables spread last, over everything derived above. */
    extra?: Readonly<Record<string, string>>;
    /** Ambient variables scrubbed from the child's environment. */
    dropVariables?: readonly string[];
    /** Command-line arguments for the executable (none for a render). */
    arguments?: readonly string[];
    /** Take stderr back as the returned log instead of streaming it. */
    captureLog?: boolean;
    timeoutMs?: number;
}

export interface MeasuredRun {
    /** The run's stderr when `captureLog` was set; empty otherwise. */
    log: string;
    /** The build stamp the run reported, when it was asked to. */
    stampPath?: string;
}

/**
 * The stamp file a measured run writes beside its screenshot or capture:
 * `<screenshot>.build-stamp`, or `<capture>.build-stamp` for a capture
 * with no screenshot.
 */
export function measuredStampPath(
    options: Pick<MeasuredRunOptions, "screenshot" | "capture">,
): string | undefined {
    const anchor = options.screenshot ?? options.capture;
    return anchor === undefined ? undefined : resolve(`${anchor}.build-stamp`);
}

/**
 * Run the executable once, measured.
 *
 * The environment is composed in one order: the base `environment`
 * (registry clock and pose), the backend, the test-pass flag, the frame
 * window, the output paths, the seek, the tape, the attribution buffers,
 * then `extra`. Outputs the run must write are deleted first: a failed or
 * too-short run must not make a previous same-build output look current.
 */
export function runMeasured(
    executable: string,
    options: MeasuredRunOptions,
): MeasuredRun {
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Build the scene with 'scene -- process' first.`,
        );
    }
    if (options.generatedDirectory !== undefined) {
        verifyDeployedPayload(executable, options.generatedDirectory);
    }
    const stampPath =
        options.generatedDirectory === undefined
            ? undefined
            : measuredStampPath(options);
    const outputs = [
        options.screenshot,
        options.capture,
        stampPath,
        options.idBuffer,
        options.clusterBuffer,
    ].filter((path): path is string => path !== undefined);
    for (const path of outputs) {
        mkdirSync(resolve(path, ".."), { recursive: true });
        rmSync(resolve(path), { force: true });
    }
    const environment = options.environment ?? {};
    const frameWindow: Record<string, string> =
        options.frame === undefined
            ? {
                  BBLITE_MAX_FRAMES: String(
                      Math.max(
                          nativeCaptureFrameBudget(environment),
                          options.maxFrames ?? 0,
                      ),
                  ),
              }
            : {
                  BBLITE_SCREENSHOT_FRAME: String(options.frame),
                  BBLITE_MAX_FRAMES: String(
                      Math.max(options.frame + 1, options.maxFrames ?? 0),
                  ),
              };
    const overrides: Record<string, string> = {
        ...environment,
        ...(options.backend === "dawn" ? { BBLITE_GPU_BACKEND: "dawn" } : {}),
        BBLITE_TEST_PASS: options.testPass === false ? "0" : "1",
        ...frameWindow,
        ...(options.screenshot !== undefined
            ? { BBLITE_SCREENSHOT: resolve(options.screenshot) }
            : {}),
        ...(options.capture !== undefined
            ? { BBLITE_RENDER_CAPTURE: resolve(options.capture) }
            : {}),
        ...(stampPath !== undefined
            ? { BBLITE_BUILD_STAMP_OUT: stampPath }
            : {}),
        ...(options.seekSeconds !== undefined
            ? { BBLITE_ANIMATION_SEEK_SECONDS: String(options.seekSeconds) }
            : {}),
        ...(options.tape !== undefined
            ? { BBLITE_INPUT_REPLAY: options.tape.join(",") }
            : {}),
        ...(options.idBuffer !== undefined
            ? { BBLITE_ID_BUFFER: resolve(options.idBuffer) }
            : {}),
        ...(options.clusterBuffer !== undefined
            ? { BBLITE_CLUSTER_BUFFER: resolve(options.clusterBuffer) }
            : {}),
        ...options.extra,
    };
    const log = spawnNativeMeasured(
        executable,
        overrides,
        [
            ...(options.backend !== undefined ? ["BBLITE_GPU_BACKEND"] : []),
            ...(options.dropVariables ?? []),
        ],
        options.captureLog ?? false,
        options.timeoutMs,
        options.arguments ?? [],
    );
    if (options.generatedDirectory !== undefined && stampPath !== undefined) {
        verifyBuildIdentity(executable, options.generatedDirectory, stampPath);
    }
    return { log, ...(stampPath !== undefined ? { stampPath } : {}) };
}

/** The pattern a measured run's log must not match: a backend's
 *  validation layer or an exception naming itself. */
export const NATIVE_LOG_ERROR_PATTERN = /validation error|gpu error|exception/i;
