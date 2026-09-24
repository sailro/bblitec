import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    captureSuiteReference,
    pinnedBrowserEntryUrl,
    suiteBrowserModuleDigest,
    type SuiteSourceTransform,
} from "./capture-suite-reference.js";
import { capturePin } from "./capture-instrumented.js";
import { usesSeededRandom } from "./parity-scene.js";
import {
    backendFileToken,
    captureMetaStaleness,
    parityReportPath,
    readCaptureMeta,
    resolvePose,
    writeSeekMeta,
} from "./tooling/artifacts.js";
import type { NativeBackend } from "./tooling/backends.js";
import { writeReport } from "./tooling/reports.js";
import { resolveNativeExecutable, runMeasured } from "./tooling/native-run.js";
import { compareImages, generateDiffMap } from "./parity.js";
import { type SceneDefinition } from "./scene-registry.js";

interface GeometryDiagnosticResult {
    task: string;
    reference: string;
    actual: string;
    diff: string;
    mad: number;
    maxDiff: number;
}

/**
 * The impostor copy tasks, read from the generated manifest rather than
 * from the scene source. Scenes 145, 146 and 149 build theirs in a loop
 * over a texture array, so the names exist only as
 * `` `sceneNNN-impostor-${entry.name}` `` and never appear literally in the
 * source; the compiler folds each name and records every copy task in the
 * manifest (`copyTasks`) in the order the scene adds them.
 */
function geometryCopyTasks(generatedDirectory: string): string[] {
    const manifestPath = resolve(generatedDirectory, "manifest.json");
    if (!existsSync(manifestPath)) {
        throw new Error(
            `Generated manifest '${manifestPath}' is missing; ` +
                "compile the scene before running geometry diagnostics.",
        );
    }
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const recorded =
        typeof manifest === "object" &&
        manifest !== null &&
        "copyTasks" in manifest
            ? manifest.copyTasks
            : [];
    if (!Array.isArray(recorded)) {
        throw new Error(`'${manifestPath}' records copyTasks as a non-array.`);
    }
    const names = recorded.filter(
        (name): name is string => typeof name === "string",
    );
    if (names.length !== recorded.length) {
        throw new Error(`'${manifestPath}' records a non-string copy task.`);
    }
    return [...new Set(names.filter((name) => name.includes("-impostor-")))];
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
 * The browser half of one impostor task in the scene's geometry
 * directory: the reference carries no native backend and stays `-lite`;
 * its provenance sidecar sits beside it the way `capture --native`'s does
 * (`captureNativePaths`).
 */
export function geometryReferencePaths(
    outputDirectory: string,
    slug: string,
): { reference: string; referenceMeta: string } {
    return {
        reference: resolve(outputDirectory, `${slug}-lite.png`),
        referenceMeta: resolve(outputDirectory, `${slug}-lite.meta.json`),
    };
}

/**
 * The four files one impostor task leaves per backend, spelled once for
 * the writer and the staleness reader: the shared browser reference pair
 * and the native/diff pair carrying the backend filename token.
 */
export function geometryTaskPaths(
    outputDirectory: string,
    slug: string,
    token: string,
): { reference: string; referenceMeta: string; actual: string; diff: string } {
    return {
        ...geometryReferencePaths(outputDirectory, slug),
        actual: resolve(outputDirectory, `${slug}-native-${token}.png`),
        diff: resolve(outputDirectory, `${slug}-diff-${token}.png`),
    };
}

/**
 * Why a cached impostor reference is NOT reusable, or `undefined` when it
 * is: missing, else the provenance rule every browser-evidence reuse path
 * applies (`captureMetaStaleness`) — the pose, the pin and the served
 * scene module must all still be the ones the reference was captured
 * from.
 */
export function geometryReferenceStaleness(
    referencePath: string,
    metaPath: string,
    want: Parameters<typeof captureMetaStaleness>[1],
): string | undefined {
    if (!existsSync(referencePath)) return "missing";
    return captureMetaStaleness(readCaptureMeta(metaPath), want);
}

export interface GeometryDiagnosticsOptions {
    /** The native backends to measure; the browser references are shared. */
    backends: readonly NativeBackend[];
    recaptureReference?: boolean;
    /**
     * Override the pose for both sides; the default is the registry's
     * `referenceTimeSeconds` (`resolvePose`). A cached reference at another
     * pose is recaptured rather than compared.
     */
    seekSeconds?: number;
}

/**
 * `scene -- parity <id> --geometry`: each impostor copy task rendered
 * alone, browser against native, one report per backend in the scene's
 * configured parity directory (`<outputDirectory>/geometry/`).
 */
export async function runGeometryOutputDiagnostics(
    scene: SceneDefinition,
    options: GeometryDiagnosticsOptions,
): Promise<void> {
    const config = scene.parity;
    if (!config) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const recaptureReference = options.recaptureReference ?? false;
    // The measured pose, exactly as parity resolves it. The browser capture
    // takes the seconds; the native side reads the same number through
    // `BBLITE_ANIMATION_SEEK_SECONDS` — the registry's `nativeEnvironment`
    // already carries the derived copy, and an explicit seek overrides it
    // after the spread as parity does.
    const { seekSeconds: seek } = resolvePose(scene, options.seekSeconds);
    const tasks = geometryCopyTasks(resolve(scene.output));
    if (tasks.length === 0) {
        throw new Error(
            `Scene '${scene.id}' has no geometry-output copy tasks.`,
        );
    }
    const executable = resolveNativeExecutable(undefined, scene.buildDirectory);
    const outputDirectory = resolve(config.outputDirectory, "geometry");
    mkdirSync(outputDirectory, { recursive: true });
    const provenance = {
        seekSeconds: seek ?? null,
        pin: capturePin(),
        moduleSha256: (seekSeconds: number | undefined) =>
            suiteBrowserModuleDigest(
                scene.source,
                seekSeconds,
                config.referenceAnimationGroups,
            ),
    };
    // The browser half is backend-independent: each task's reference is
    // captured (or reused) once and measured against every backend.
    for (const task of tasks) {
        const slug = taskSlug(task);
        const { reference, referenceMeta } = geometryReferencePaths(
            outputDirectory,
            slug,
        );
        const staleness = recaptureReference
            ? undefined
            : geometryReferenceStaleness(reference, referenceMeta, provenance);
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
            config.referenceAnimationGroups,
            {
                virtualModules: {
                    [impostorShimPath]: impostorShimModule(task),
                },
                // The same stub the parity reference installs: a seeded
                // scene must draw the pinned sequence in this capture too,
                // or its impostor references describe different content
                // than the golden's.
                seededRandom: usesSeededRandom(scene),
                ...(config.referenceSearch !== undefined
                    ? { search: config.referenceSearch }
                    : {}),
            },
        );
        if (capture) {
            writeSeekMeta(referenceMeta, seek, {
                moduleSha256: provenance.moduleSha256(seek),
                pin: provenance.pin,
            });
        }
    }
    for (const backend of options.backends) {
        // Backend-produced files carry the shared filename token
        // (`-gpu`/`-dawn`) so the two backends' attachments sit side by
        // side; the browser reference has no native backend and stays
        // `-lite`.
        const token = backendFileToken(backend);
        const results: GeometryDiagnosticResult[] = [];
        for (const task of tasks) {
            const slug = taskSlug(task);
            const { reference, actual, diff } = geometryTaskPaths(
                outputDirectory,
                slug,
                token,
            );
            runMeasured(executable, {
                generatedDirectory: resolve(scene.output),
                environment: {
                    ...config.nativeEnvironment,
                    ...(seek !== undefined
                        ? { BBLITE_ANIMATION_SEEK_SECONDS: String(seek) }
                        : {}),
                    BBLITE_COPY_TASK: task,
                },
                backend,
                screenshot: actual,
            });
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
                `${scene.id} ${slug} (${backend}): MAD=${comparison.mad.toFixed(3)}, ` +
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
}
