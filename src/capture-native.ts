import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { computeBuildStamp } from "./build-stamp.js";
import {
    backendFileToken,
    canonicalBackend,
    captureNativePaths,
    defaultCaptureDirectory,
    readSeekMeta,
    writeSeekMeta,
} from "./tooling/artifacts.js";
import {
    resolveNativeExecutable,
    runMeasured,
} from "./tooling/native-run.js";
import { resolveScene, type SceneDefinition } from "./scene-registry.js";

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
 * looking at — and that failure is silent.
 */
export interface NativeCaptureOptions {
    /** `sdl_gpu` (default) or `dawn`; `gpu` is accepted for `sdl_gpu`. */
    backend?: string;
    seekSeconds?: number;
    outputDirectory?: string;
    /** An explicit executable; `BBLITE_NATIVE_EXE` and the scene's own
     *  Release build are the fallbacks (`resolveNativeExecutable`). */
    executable?: string;
}

export interface NativeCaptureResult {
    capturePath: string;
    screenshotPath: string;
    backend: string;
}

/**
 * Why a native capture on disk is NOT reusable as evidence for `scene`
 * at `wantSeek` (`null` = no seek), or `undefined` when it is. The
 * capture embeds the stamp of the generated tree it was built from; a
 * tree that moved since makes the capture describe a build that no
 * longer exists. `scene -- diff` recaptures on any reason.
 */
export function nativeCaptureStaleness(
    scene: SceneDefinition,
    captureDirectory: string,
    token: string,
    wantSeek: number | null,
): string | undefined {
    const paths = captureNativePaths(captureDirectory, token);
    if (!existsSync(paths.capture)) return "missing";
    try {
        const capture = JSON.parse(
            readFileSync(paths.capture, "utf8"),
        ) as { buildStamp?: string };
        if (
            capture.buildStamp !==
            computeBuildStamp(resolve(scene.output)).stamp
        ) {
            return "was captured from a different generated tree";
        }
    } catch {
        return "is unreadable";
    }
    if (readSeekMeta(paths.meta) !== wantSeek) {
        return "was captured at a different seek (or carries no provenance)";
    }
    return undefined;
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
    const executable = resolveNativeExecutable(
        options.executable,
        scene.buildDirectory,
    );
    if (!existsSync(executable)) {
        throw new Error(
            `Native executable not found: ${executable}. Run 'scene -- process ${scene.id}' first.`,
        );
    }
    // One spelling for the trio, shared with the `scene -- diff` reader.
    const paths = captureNativePaths(outputDirectory, token);
    // The seek pairs the native frame to the browser frame the golden was
    // captured at; without it an animated scene is described at a
    // different pose than the one being diffed against.
    const seekSeconds =
        options.seekSeconds ?? scene.parity?.referenceTimeSeconds;
    // The run deletes the capture, screenshot and stamp it must write;
    // the provenance sidecar is this writer's own and goes with them, so
    // a failed run cannot leave a previous capture looking current.
    rmSync(paths.meta, { force: true });
    runMeasured(executable, {
        generatedDirectory: scene.output,
        ...(scene.parity?.nativeEnvironment !== undefined
            ? { environment: scene.parity.nativeEnvironment }
            : {}),
        // An ambient backend selection must not survive into a run whose
        // backend the flag chooses explicitly.
        backend,
        screenshot: paths.screenshot,
        capture: paths.capture,
        ...(seekSeconds !== undefined ? { seekSeconds } : {}),
    });
    if (!existsSync(paths.capture)) {
        // Every frame loop writes a capture: the scene loops describe
        // the families a scene composes, and the standalone sprite/effect
        // loops (pal_*_sprite.cpp / pal_*_effect.cpp) write theirs through
        // write_standalone_render_capture. A run that completed without
        // one is a real failure — a stale executable predating the
        // standalone writers, or a run that ended before the capture
        // frame — never an expected shape.
        throw new Error(
            `The native run wrote no capture to ${paths.capture}. Every frame loop writes one ` +
                `(scene, sprite-only and effect-renderer-only alike), so this run either ended ` +
                `before the capture frame or ran an executable predating the standalone capture ` +
                `writers. Rebuild with 'scene -- process ${scene.id}' and recapture.`,
        );
    }
    // Seek provenance for the reuse path; the build stamp is already inside
    // the capture itself, written by the native run.
    writeSeekMeta(paths.meta, seekSeconds);
    return {
        capturePath: paths.capture,
        screenshotPath: paths.screenshot,
        backend,
    };
}
