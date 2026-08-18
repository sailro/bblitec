import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
    defaultExecutable,
    verifyBuildIdentity,
    verifyDeployedPayload,
} from "./parity-scene.js";
import { resolveScene } from "./scene-registry.js";

/**
 * The native half of `scene -- capture`.
 *
 * The browser half hooks WebGPU and records what Babylon Lite uploaded.
 * This half asks the native runtime for the same description of the same
 * frame: `BBLITE_RENDER_CAPTURE` makes it write every uniform block it
 * builds, the draw list in submission order, and the scene, camera,
 * light and material records those are built from
 * (`native/src/pal_render_capture.hpp`).
 *
 * It runs under the same build-identity checks as a measured parity run,
 * because a capture from a stale executable describes a frame nobody is
 * looking at — and that failure is silent, which is exactly the kind of
 * hour this tooling exists to avoid.
 */
export interface NativeCaptureOptions {
    /** `sdl_gpu` (default) or `dawn`. */
    backend?: string;
    seekSeconds?: number;
    outputDirectory?: string;
}

export interface NativeCaptureResult {
    capturePath: string;
    screenshotPath: string;
    backend: string;
}

export function runNativeCapture(
    idOrSource: string,
    options: NativeCaptureOptions = {},
): NativeCaptureResult {
    const scene = resolveScene(idOrSource);
    const backend = options.backend ?? "sdl_gpu";
    const outputDirectory = resolve(
        options.outputDirectory ?? join("artifacts", "capture", scene.id),
    );
    mkdirSync(outputDirectory, { recursive: true });
    const executable = defaultExecutable(scene.buildDirectory);
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Run 'scene -- process ${scene.id}' first.`,
        );
    }
    verifyDeployedPayload(executable, scene.output);

    const capturePath = join(outputDirectory, `native-${backend}.json`);
    const screenshotPath = join(outputDirectory, `native-${backend}.png`);
    const stampPath = `${screenshotPath}.build-stamp`;
    // The seek pairs the native frame to the browser frame the golden was
    // captured at; without it an animated scene is described at a
    // different pose than the one being diffed against.
    const seekSeconds =
        options.seekSeconds ?? scene.parity?.referenceTimeSeconds;
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
        // npm_* leaks the invoking script's configuration into a run that
        // is supposed to describe the scene, and BBLITE_GPU_BACKEND is set
        // explicitly below so an ambient one cannot silently pick the
        // other backend.
        if (value === undefined) continue;
        if (name.toLowerCase().startsWith("npm_")) continue;
        if (name === "BBLITE_GPU_BACKEND") continue;
        inherited[name] = value;
    }
    const environment: Record<string, string> = {
        ...inherited,
        ...(scene.parity?.nativeEnvironment ?? {}),
        BBLITE_GPU: "1",
        BBLITE_GPU_REQUIRED: "1",
        ...(backend === "dawn" ? { BBLITE_GPU_BACKEND: "dawn" } : {}),
        BBLITE_TEST_PASS: "1",
        BBLITE_MAX_FRAMES: "1",
        BBLITE_SCREENSHOT: screenshotPath,
        BBLITE_RENDER_CAPTURE: capturePath,
        BBLITE_BUILD_STAMP_OUT: stampPath,
        ...(seekSeconds !== undefined
            ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seekSeconds) }
            : {}),
    };
    const result = spawnSync(executable, [], {
        stdio: "inherit",
        windowsHide: true,
        env: environment,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `Native renderer exited with status ${result.status}.`,
        );
    }
    verifyBuildIdentity(executable, scene.output, stampPath);
    if (!existsSync(capturePath)) {
        throw new Error(
            `The native run wrote no capture to ${capturePath}. A scene with no PBR render plan ` +
                `(a sprite-only scene) has nothing to describe here.`,
        );
    }
    // Seek provenance for the reuse path; the build stamp is already inside
    // the capture itself, written by the native run.
    writeFileSync(
        join(outputDirectory, `native-${backend}.meta.json`),
        `${JSON.stringify({ seekSeconds: seekSeconds ?? null })}\n`,
    );
    return { capturePath, screenshotPath, backend };
}
