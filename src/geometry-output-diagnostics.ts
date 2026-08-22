import {
    existsSync,
    mkdirSync,
    readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
    captureSuiteReference,
    type SuiteSourceTransform,
} from "./capture-suite-reference.js";
import {
    applyGpuBackendEnvironment,
    backendFileToken,
    defaultExecutable,
    parityReportPath,
    resolveBackend,
    runNative,
    writeReport,
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
const pinnedModulePath = "/node_modules/@babylonjs/lite/lib/index.js";

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

export interface GeometryDiagnosticsOptions {
    recaptureReference?: boolean;
    /** `sdl_gpu` (default; `gpu` accepted) or `dawn`; the ambient
     *  `BBLITE_GPU_BACKEND` variable is the fallback. */
    backend?: string;
    /** Override the pose for both sides; requires `recaptureReference`. */
    seekSeconds?: number;
}

export async function runGeometryOutputDiagnostics(
    idOrSource: string,
    options: GeometryDiagnosticsOptions = {},
): Promise<void> {
    const recaptureReference = options.recaptureReference ?? false;
    const backend = resolveBackend(
        options.backend,
        ["sdl_gpu", "dawn"],
        "geometry",
    );
    applyGpuBackendEnvironment(backend);
    // Backend-produced files carry the shared filename token
    // (`-gpu`/`-dawn`) so the two backends' attachments sit side by side;
    // the browser reference has no native backend and stays `-lite`.
    const token = backendFileToken(backend);
    const seek = options.seekSeconds;
    if (seek !== undefined && !recaptureReference) {
        throw new Error(
            "geometry: --seek compares a seeked native frame against references captured at another pose, which measures nothing. " +
                "Add --recapture-reference to recapture the references at this seek.",
        );
    }
    const scene = resolveScene(idOrSource);
    const tasks = geometryCopyTasks(resolve(scene.output));
    if (tasks.length === 0) {
        throw new Error(
            `Scene '${scene.id}' has no geometry-output copy tasks.`,
        );
    }
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
        const reference = resolve(
            outputDirectory,
            `${slug}-lite.png`,
        );
        const actual = resolve(
            outputDirectory,
            `${slug}-native-${token}.png`,
        );
        const diff = resolve(
            outputDirectory,
            `${slug}-diff-${token}.png`,
        );
        await captureSuiteReference(
            scene.source,
            reference,
            recaptureReference,
            impostorShimTransform(),
            seek,
            undefined,
            { virtualModules: { [impostorShimPath]: impostorShimModule(task) } },
        );
        runNative(
            defaultExecutable(scene.buildDirectory),
            actual,
            true,
            {
                BBLITE_COPY_TASK: task,
                ...(seek !== undefined
                    ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
                    : {}),
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
