import {
    existsSync,
    mkdirSync,
    readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
    captureSuiteReference,
    pinnedBrowserEntryUrl,
    type SuiteSourceTransform,
} from "./capture-suite-reference.js";
import {
    applyGpuBackendEnvironment,
    backendFileToken,
    enableGpuDebug,
    parityReportPath,
    readSeekMeta,
    resolveBackend,
    resolveNativeExecutable,
    runNative,
    usesSeededRandom,
    writeReport,
    writeSeekMeta,
} from "./parity-scene.js";
import {
    compareImages,
    generateDiffMap,
} from "./parity.js";
import { resolveScene } from "./scene-registry.js";

interface GeometryDiagnosticResult {
    task: string;
    reference: string;
    actual: string;
    diff: string;
    mad: number;
    maxDiff: number;
}

const impostorNamePattern = /"([A-Za-z0-9_]+-impostor-[A-Za-z0-9_]+)"/g;

/**
 * The impostor copy tasks are discovered from the generated tree rather than
 * from the scene source. Scenes 145, 146 and 149 build theirs in a loop over a
 * texture array, so the names exist only as
 * `` `sceneNNN-impostor-${entry.name}` `` and never appear literally in the
 * source; the compiler unrolls that loop, so the generated entry point carries
 * every name in the order the scene adds them.
 */
function geometryCopyTasks(generatedDirectory: string): string[] {
    const entryPoint = resolve(generatedDirectory, "main.cpp");
    if (!existsSync(entryPoint)) {
        throw new Error(
            `Generated entry point '${entryPoint}' is missing; ` +
                "compile the scene before running geometry diagnostics.",
        );
    }
    const generated = readFileSync(entryPoint, "utf8");
    const result: string[] = [];
    for (const match of generated.matchAll(impostorNamePattern)) {
        const name = match[1];
        if (name !== undefined && !result.includes(name)) result.push(name);
    }
    return result;
}

const impostorShimPath = "/__bbl-geometry-impostor-shim.js";
const pinnedModulePath = pinnedBrowserEntryUrl;

/**
 * Selects one impostor in the browser the way the native frame loop selects it
 * from `BBLITE_COPY_TASK`: by task name, dropping the other impostor copies and
 * giving the selected one the full viewport. Doing it by name rather than by
 * rewriting the source is what reaches the loop-built tasks, whose viewport is
 * computed from the loop index and has no per-task literal to replace.
 *
 * `export *` skips names a module exports explicitly, so the scene still binds
 * every other pinned export directly.
 */
function impostorShimModule(selected: string): string {
    return `import * as pinned from ${JSON.stringify(pinnedModulePath)};
export * from ${JSON.stringify(pinnedModulePath)};

const selected = ${JSON.stringify(selected)};
const skipped = Symbol("bblite-skipped-copy-task");

export function createCopyToTextureTask(options, engine, scene) {
    const name = options && options.name;
    if (typeof name === "string" && name.includes("-impostor-")) {
        if (name !== selected) return skipped;
        return pinned.createCopyToTextureTask(
            { ...options, viewport: { x: 0, y: 0, width: 1, height: 1 } },
            engine,
            scene,
        );
    }
    return pinned.createCopyToTextureTask(options, engine, scene);
}

export function addTask(scene, task) {
    if (task === skipped) return undefined;
    return pinned.addTask(scene, task);
}

export function addTaskAtStart(scene, task) {
    if (task === skipped) return undefined;
    return pinned.addTaskAtStart(scene, task);
}
`;
}

function impostorShimTransform(): SuiteSourceTransform {
    return (source) =>
        source
            .replaceAll('"babylon-lite"', JSON.stringify(impostorShimPath))
            .replaceAll('"@babylonjs/lite"', JSON.stringify(impostorShimPath));
}

function taskSlug(task: string): string {
    return task.slice(task.indexOf("-impostor-") + "-impostor-".length);
}

/**
 * The four files one impostor task leaves in the scene's geometry
 * directory, spelled once for the writer and the staleness reader. The
 * browser reference carries no native backend and stays `-lite`; its
 * seek-provenance sidecar sits beside it the way `capture --native`'s
 * does (`captureNativePaths`), and the native/diff pair carry the shared
 * backend filename token.
 */
export function geometryTaskPaths(
    outputDirectory: string,
    slug: string,
    token: string,
): { reference: string; referenceMeta: string; actual: string; diff: string } {
    return {
        reference: resolve(outputDirectory, `${slug}-lite.png`),
        referenceMeta: resolve(outputDirectory, `${slug}-lite.meta.json`),
        actual: resolve(outputDirectory, `${slug}-native-${token}.png`),
        diff: resolve(outputDirectory, `${slug}-diff-${token}.png`),
    };
}

/**
 * Why a cached impostor reference is NOT reusable at `wantSeek`, or
 * `undefined` when it is — the same rule `scene -- diff` applies to the
 * native capture before trusting it: reuse on bare existence compared an
 * animated scene's settled browser pose against whatever pose the file
 * happened to hold. `null` means "no seek"; a missing sidecar reads as
 * unknown and forces a recapture.
 */
export function geometryReferenceStaleness(
    referencePath: string,
    metaPath: string,
    wantSeek: number | null,
): string | undefined {
    if (!existsSync(referencePath)) return "missing";
    if (readSeekMeta(metaPath) !== wantSeek) {
        return "was captured at a different seek (or carries no provenance)";
    }
    return undefined;
}

export interface GeometryDiagnosticsOptions {
    recaptureReference?: boolean;
    /** `sdl_gpu` (default; `gpu` accepted) or `dawn`; the ambient
     *  `BBLITE_GPU_BACKEND` variable is the fallback. */
    backend?: string;
    /**
     * Override the pose for both sides; the default is the registry's
     * `referenceTimeSeconds`. A cached reference at another pose is
     * recaptured rather than compared (the rule `diff` applies).
     */
    seekSeconds?: number;
    /** The backend's validation layer plus the SDL assertion defusal,
     *  exactly as the sibling commands' `--gpu-debug`. */
    gpuDebug?: boolean;
    /** `--exe` override; `BBLITE_NATIVE_EXE` is the environment
     *  fallback, then the scene's own Release build. */
    executable?: string;
}

export async function runGeometryOutputDiagnostics(
    idOrSource: string,
    options: GeometryDiagnosticsOptions = {},
): Promise<void> {
    const recaptureReference = options.recaptureReference ?? false;
    if (options.gpuDebug) enableGpuDebug();
    const backend = resolveBackend(options.backend, "geometry");
    applyGpuBackendEnvironment(backend);
    // Backend-produced files carry the shared filename token
    // (`-gpu`/`-dawn`) so the two backends' attachments sit side by side;
    // the browser reference has no native backend and stays `-lite`.
    const token = backendFileToken(backend);
    const scene = resolveScene(idOrSource);
    const config = scene.parity;
    // The measured pose, exactly as parity resolves it: the explicit
    // `--seek` wins, else the registry's pinned pose, else no seek. The
    // browser capture takes the seconds; the native side reads the same
    // number through `BBLITE_ANIMATION_SEEK_SECONDS` — the registry's
    // `nativeEnvironment` already carries the derived copy, and an
    // explicit seek overrides it after the spread as parity does.
    const seek = options.seekSeconds ?? config?.referenceTimeSeconds;
    const tasks = geometryCopyTasks(resolve(scene.output));
    if (tasks.length === 0) {
        throw new Error(
            `Scene '${scene.id}' has no geometry-output copy tasks.`,
        );
    }
    const executable = resolveNativeExecutable(
        options.executable,
        scene.buildDirectory,
    );
    const outputDirectory = resolve(
        "artifacts",
        "parity",
        scene.id,
        "geometry",
    );
    mkdirSync(outputDirectory, { recursive: true });
    const results: GeometryDiagnosticResult[] = [];
    for (const task of tasks) {
        const slug = taskSlug(task);
        const { reference, referenceMeta, actual, diff } = geometryTaskPaths(
            outputDirectory,
            slug,
            token,
        );
        // The same staleness discipline diff applies: a cached reference
        // is only evidence at the pose it was captured at, so a stale or
        // provenance-less one is recaptured rather than compared.
        const staleness = recaptureReference
            ? undefined
            : geometryReferenceStaleness(
                  reference,
                  referenceMeta,
                  seek ?? null,
              );
        if (staleness !== undefined && staleness !== "missing") {
            console.log(
                `Geometry reference ${slug} ${staleness}; recapturing.`,
            );
        }
        const capture = recaptureReference || staleness !== undefined;
        await captureSuiteReference(
            scene.source,
            reference,
            capture,
            impostorShimTransform(),
            seek,
            config?.referenceAnimationGroups,
            {
                virtualModules: {
                    [impostorShimPath]: impostorShimModule(task),
                },
                // The same stub the parity reference installs: a seeded
                // scene must draw the pinned sequence in this capture too,
                // or its impostor references describe different content
                // than the golden's.
                seededRandom: usesSeededRandom(scene),
                ...(config?.referenceSearch !== undefined
                    ? { search: config.referenceSearch }
                    : {}),
            },
        );
        if (capture) writeSeekMeta(referenceMeta, seek);
        runNative(
            executable,
            actual,
            {
                ...config?.nativeEnvironment,
                ...(seek !== undefined
                    ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
                    : {}),
                BBLITE_COPY_TASK: task,
            },
            undefined,
            undefined,
            resolve(scene.output),
        );
        const comparison = compareImages(actual, reference);
        generateDiffMap(actual, reference, diff);
        results.push({
            task,
            reference,
            actual,
            diff,
            mad: comparison.mad,
            maxDiff: comparison.maxDiff,
        });
        console.log(
            `${scene.id} ${slug}: MAD=${comparison.mad.toFixed(3)}, ` +
                `max=${comparison.maxDiff}`,
        );
    }
    const report = parityReportPath(outputDirectory, token);
    writeReport(
        report,
        {
            tool: "geometry",
            backend,
            generatedDirectory: resolve(scene.output),
        },
        { scene: scene.id, results },
    );
    console.log(`Report: ${report}`);
}
