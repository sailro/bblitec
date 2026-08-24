import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
    backendFileToken,
    canonicalBackend,
    captureNativePaths,
    defaultCaptureDirectory,
    defaultExecutable,
    nativeCaptureFrameBudget,
    spawnNativeMeasured,
    verifyBuildIdentity,
    verifyDeployedPayload,
    writeSeekMeta,
} from "./parity-scene.js";
import { resolveScene } from "./scene-registry.js";

/**
 * The native half of `scene -- capture`.
 *
 * The browser half hooks WebGPU and records what Babylon Lite uploaded.
 * This half asks the native runtime for the same description of the same
 * frame: `BBLITE_RENDER_CAPTURE` makes it write every uniform block it
 * builds, the draw list in submission order — meshes, splats, billboard
 * systems, and the sprite/effect state the engine records — and the
 * scene, camera, light and material records those are built from
 * (`native/src/pal_render_capture.hpp`).
 *
 * It runs under the same build-identity checks as a measured parity run,
 * because a capture from a stale executable describes a frame nobody is
 * looking at — and that failure is silent, which is exactly the kind of
 * hour this tooling exists to avoid.
 */
export interface NativeCaptureOptions {
    /** `sdl_gpu` (default) or `dawn`; `gpu` is accepted for `sdl_gpu`. */
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
    const backend = canonicalBackend(
        options.backend ?? "sdl_gpu",
        "capture",
    );
    // Filenames use the shared token ("gpu" for SDL_GPU), matching the
    // parity artifacts.
    const token = backendFileToken(backend);
    const outputDirectory = resolve(
        options.outputDirectory ?? defaultCaptureDirectory(scene.id),
    );
    mkdirSync(outputDirectory, { recursive: true });
    const executable = defaultExecutable(scene.buildDirectory);
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Run 'scene -- process ${scene.id}' first.`,
        );
    }
    verifyDeployedPayload(executable, scene.output);

    // One spelling for the trio, shared with the `scene -- diff` reader.
    const paths = captureNativePaths(outputDirectory, token);
    const capturePath = paths.capture;
    const screenshotPath = paths.screenshot;
    const stampPath = `${screenshotPath}.build-stamp`;
    // The seek pairs the native frame to the browser frame the golden was
    // captured at; without it an animated scene is described at a
    // different pose than the one being diffed against.
    const seekSeconds =
        options.seekSeconds ?? scene.parity?.referenceTimeSeconds;
    const nativeEnvironment = scene.parity?.nativeEnvironment;
    // A failed or too-short run must not make a previous same-build capture
    // look current. These paths are this invocation's exact native outputs.
    for (const path of [capturePath, screenshotPath, stampPath, paths.meta]) {
        rmSync(path, { force: true });
    }
    spawnNativeMeasured(
        executable,
        {
            ...(nativeEnvironment ?? {}),
            ...(backend === "dawn" ? { BBLITE_GPU_BACKEND: "dawn" } : {}),
            BBLITE_TEST_PASS: "1",
            BBLITE_MAX_FRAMES: String(
                nativeCaptureFrameBudget(nativeEnvironment),
            ),
            BBLITE_SCREENSHOT: screenshotPath,
            BBLITE_RENDER_CAPTURE: capturePath,
            BBLITE_BUILD_STAMP_OUT: stampPath,
            ...(seekSeconds !== undefined
                ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seekSeconds) }
                : {}),
        },
        // An ambient backend selection must not survive into a run whose
        // backend the flag chooses explicitly.
        ["BBLITE_GPU_BACKEND"],
    );
    verifyBuildIdentity(executable, scene.output, stampPath);
    if (!existsSync(capturePath)) {
        // The capture is written by the scene frame loop, which describes
        // every renderable family a scene composes (meshes, splats,
        // billboards, effect tasks). A sprite-only or effect-renderer-only
        // scene renders through a standalone loop (pal_*_sprite.cpp /
        // pal_*_effect.cpp) that writes no capture yet, so the run
        // completing without one is that gap, not a broken build.
        throw new Error(
            `The native run wrote no capture to ${capturePath}. A scene with no scene renderer — ` +
                `a sprite-only or effect-renderer-only scene — draws through a standalone frame ` +
                `loop that does not write captures yet, so rung 3 has nothing to pair for it; ` +
                `use the parity ladder's pixel rungs instead.`,
        );
    }
    // Seek provenance for the reuse path; the build stamp is already inside
    // the capture itself, written by the native run.
    writeSeekMeta(paths.meta, seekSeconds);
    return { capturePath, screenshotPath, backend };
}
