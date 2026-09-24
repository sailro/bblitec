#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    parse,
    relative,
    resolve,
} from "node:path";
import {
    type DifferentialReportSummary,
    MEMORY_FLAGS,
    PARITY_FLAGS,
    type ParityArguments,
    type ParityReportSummary,
    memoryArgumentsFrom,
    parityArgumentsFrom,
    parityOutputDirectory,
    runParityBackends,
    runMemoryReport,
    runStabilityReport,
} from "./parity-scene.js";
import {
    type FlagSpec,
    type ParsedFlags,
    MEASURE_FLAGS,
    flagNumber,
    isMainModule,
    parseFlags,
    parseRgbTriple,
    usageFromSpec,
} from "./tooling/flags.js";
import {
    artifactDirectory,
    backendFileToken,
    captureMetaPath,
    captureNativePaths,
    captureSeekBracketDirectory,
    defaultCaptureDirectory,
    isOwnedArtifact,
    measuredBackends,
    parityReportPath,
    readCaptureMeta,
    resolveBackend,
    resolvePose,
    seekBracketPlan,
    type ScenePose,
} from "./tooling/artifacts.js";
import {
    compiledBackend,
    NATIVE_BACKENDS,
    type CompiledBackend,
} from "./tooling/backends.js";
import { readCheckSpec } from "./tooling/check-spec.js";
import { runCheck } from "./tooling/check-run.js";
import { runObserve } from "./tooling/observe-run.js";
import { runChecked as run } from "./tooling/logged-process.js";
import {
    contentFingerprint,
    hashEntries,
    listFiles,
    toolIdentity,
} from "./tooling/records.js";
import {
    formatAdaptations,
    formatFeatureActivation,
    formatProvenance,
    formatSceneStatus,
    readAdaptations,
    readFeatureActivation,
    readProvenance,
    readSceneStatus,
} from "./tooling/generated-readers.js";
import { writeReport } from "./tooling/reports.js";
import {
    enableGpuDebug,
    resolveNativeExecutable,
    runMeasured,
    withEnvironment,
} from "./tooling/native-run.js";
import { formatPngMeasurement, measurePng } from "./tooling/png-measure.js";
import {
    computeBuildStamp,
    deployedPayloads,
    generatorWouldReconfigure,
    incompatibleCacheEntries,
    payloadOrphans,
    readCacheConfiguration,
    sameCachePath,
} from "./build-stamp.js";
import {
    generationIsCurrent,
    historicalGenerationCostMs,
    recordGeneration,
    refreshBuildStamp,
} from "./generation-stamp.js";
import {
    attributionScene,
    copyAttributionReferences,
} from "./attribution-scene.js";
// The instrumented capture, the geometry diagnostics, the diff/uniforms
// readers, the compose report and the API survey are imported per
// subcommand rather than here: their chains pull playwright-core,
// typescript and the pinned-module cluster, which every other subcommand —
// including each parity child of a matrix run — would pay at startup
// without using.
import {
    nativeCaptureStaleness,
    runNativeCapture,
    type NativeCaptureResult,
} from "./capture-native.js";
import { compareImages } from "./parity.js";
import {
    resolveScene,
    scenes,
    type SceneDefinition,
} from "./scene-registry.js";
import { holdDistLock } from "./dist-lock.js";
import { runNeutralityReport } from "./scene-neutrality.js";
import {
    compareGeneratedDigest,
    digestGeneratedTree,
    parseDigestBaseline,
} from "./generated-tree.js";
import { verifyStatus } from "./verify-status.js";
import {
    canonicalCompiledBackend,
    canonicalDevelopmentCompiler,
    canonicalOfflineShaderTarget,
    compiledBuildDirectory,
    developmentTriplet,
    hostOfflineShaderTarget,
    needsOfflineShaders,
    selectedCompiledBackend,
    type OfflineShaderTarget,
} from "./build-options.js";
import { resolveBrowserPath } from "./browser-path.js";
import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
    type DependencyPatchRecord,
    type DevelopmentTools,
    type WindowsBuildTools,
} from "./development-tools.js";
import { checkPatchInventory } from "./patch-inventory.js";
import {
    developmentVcpkgInstall,
    installVcpkgManifest,
    type VcpkgManifestInstall,
} from "./vcpkg-install.js";
import { runConcurrently } from "./run-concurrently.js";
import { pinnedLabPublicUrl } from "./pinned-lab-public.js";
import {
    historicalBuildCostMs,
    orderByHistoricalCost,
} from "./build-scheduling.js";
import {
    materializePhysicsDebugCatalog,
    physicsDebugCatalogPath,
    renderPhysicsDebugCatalog,
} from "./physics-debug-catalog.js";

/**
 * `run` for work that shares the machine with other work.
 *
 * With `capture` the child's output is collected instead of inherited, so
 * concurrent builds do not interleave line by line; the caller prints
 * each block whole. Without it the behaviour matches `run`.
 */
function runAsync(
    command: string,
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
    capture: string[] | undefined,
    timeoutMs?: number,
): Promise<void> {
    return new Promise((resolve_, reject) => {
        const child = spawn(command, arguments_, {
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
            env: environment,
        });
        const timeout =
            timeoutMs === undefined
                ? undefined
                : setTimeout(() => {
                      child.kill();
                      reject(
                          new Error(
                              `${command} exceeded the ${timeoutMs} ms execution bound.`,
                          ),
                      );
                  }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) =>
            capture?.push(chunk.toString()),
        );
        child.stderr?.on("data", (chunk: Buffer) =>
            capture?.push(chunk.toString()),
        );
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (status) => {
            clearTimeout(timeout);
            if (status === 0) {
                resolve_();
                return;
            }
            reject(new Error(`${command} exited with status ${status}.`));
        });
    });
}

/**
 * The buffered-child-output stanza every concurrent spawn shares: the
 * body runs children through one buffer, and the finally prints the
 * block whole — label first — however the body ends, so interleaved
 * children stay readable and a failure keeps its own diagnostics
 * together. `buffer: false` inherits stdio instead (the single-child
 * case); `settleMs` waits after the flush, success or not — the settle
 * that has always followed a measured run on Windows.
 */
async function runBuffered(
    options: {
        buffer?: boolean;
        label?: string;
        settleMs?: number;
    },
    body: (
        run: (
            command: string,
            arguments_: string[],
            environment?: NodeJS.ProcessEnv,
        ) => Promise<void>,
    ) => Promise<void>,
): Promise<void> {
    const buffered = options.buffer ?? true;
    const output: string[] = [];
    try {
        await body((command, arguments_, environment = process.env) =>
            runAsync(
                command,
                arguments_,
                environment,
                buffered ? output : undefined,
            ),
        );
    } finally {
        if (output.length > 0) {
            process.stdout.write(`${options.label ?? ""}${output.join("")}`);
        }
        if (options.settleMs !== undefined) {
            await new Promise((done) => setTimeout(done, options.settleMs));
        }
    }
}

/** The bblitec invocation for a scene: its entry, its output and the
 *  options its registry entry declares. */
function compilerArguments(scene: SceneDefinition): string[] {
    const arguments_ = [
        resolve("dist/src/cli.js"),
        scene.source,
        "--out",
        scene.output,
        "--title",
        scene.title,
        "--public-url",
        pinnedLabPublicUrl(),
    ];
    if (scene.parity?.referenceSearch !== undefined) {
        arguments_.push("--search", scene.parity.referenceSearch);
        arguments_.push("--initial-search", "");
    }
    if (scene.nativeHostUi !== undefined) {
        arguments_.push("--host-ui", scene.nativeHostUi);
    }
    if (
        scene.parity?.attribution?.drawIds ||
        scene.parity?.attribution?.triangleClusters
    ) {
        arguments_.push("--id-diagnostics");
    }
    return arguments_;
}

/** `--cold`: regenerate, recompile shaders and reconfigure regardless of
 *  what the records say. */
function coldBuild(): boolean {
    return process.env.BBLITE_COLD_BUILD === "1";
}

async function compile(idOrSource: string): Promise<void> {
    await compileScenes(
        idOrSource === "all" ? scenes : [resolveScene(idOrSource)],
    );
}

async function compileScenes(
    selected: readonly SceneDefinition[],
): Promise<void> {
    // A scene whose recorded inputs are unchanged is not generated again:
    // its tree already holds what the compiler would write. What a hit
    // still owes is the build stamp, which follows the native sources the
    // input digest does not cover (`src/generation-stamp.ts`).
    const cold = coldBuild();
    const stale: SceneDefinition[] = [];
    let refreshedStamps = 0;
    for (const scene of selected) {
        if (!cold && generationIsCurrent(scene, compilerArguments(scene))) {
            if (refreshBuildStamp(scene.output)) refreshedStamps += 1;
        } else {
            stale.push(scene);
        }
    }
    const upToDate = selected.length - stale.length;
    if (upToDate > 0) {
        console.log(
            `compile: ${upToDate} of ${selected.length} scene(s) up to date` +
                (refreshedStamps > 0
                    ? `, ${refreshedStamps} build stamp(s) refreshed.`
                    : "."),
        );
    }
    if (stale.length === 0) return;
    // Each scene is a separate Node process writing to its own output
    // directory, so there is nothing to serialize -- the sequential loop
    // spent two minutes running one interpreter at a time. Node is far
    // lighter than MSVC, so this is bounded by threads alone. A single
    // scene keeps its output on the console.
    const inFlight =
        concurrencyOverride("BBLITE_PARALLEL_COMPILES") ??
        availableParallelism();
    if (stale.length > 1) {
        console.log(`Compiling ${stale.length} scenes, ${inFlight} at a time.`);
    }
    const generations = new Map<
        string,
        { startedAt: number; durationMs: number }
    >();
    // The longest generations start first: in registry order the largest
    // applications, registered last, used to finish the stage alone.
    await runConcurrently(
        orderByHistoricalCost(stale, (scene) =>
            historicalGenerationCostMs(scene.id),
        ),
        inFlight,
        (scene) => scene.id,
        (scene) =>
            runBuffered({ buffer: stale.length > 1 }, async (run) => {
                const arguments_ = compilerArguments(scene);
                const startedAt = Date.now();
                await run(process.execPath, arguments_);
                generations.set(scene.id, {
                    startedAt,
                    durationMs: Date.now() - startedAt,
                });
                if (!sceneUsesNativeFeature(scene, "physics:viewer"))
                    recordGeneration(scene, arguments_, startedAt);
            }),
        { completed: "compiled" },
    );
    // The emitted extraction entry executes only admitted startup construction.
    // Keep native bootstrap builds serialized; the ordinary compile pool remains
    // independent and no renderer or physics frame runs during this stage.
    for (const scene of stale.filter((scene) =>
        sceneUsesNativeFeature(scene, "physics:viewer"),
    )) {
        const generation = generations.get(scene.id)!;
        const specializedAt = Date.now();
        await specializePhysicsDebugGeometry(scene);
        // Its cost is its own generation and specialization, not the wait
        // for the rest of the pool between them.
        recordGeneration(
            scene,
            compilerArguments(scene),
            generation.startedAt,
            {
                durationMs: generation.durationMs + Date.now() - specializedAt,
            },
        );
    }
}

/**
 * The byte-identical no-query twin of a registry scene: the same source
 * compiled without the pinned parity query (`--search`), so the branch the
 * corpus source takes for a live page — a running physics world, an
 * animating manager, a spawning emitter — is the branch the native run
 * takes. It lands in `generated/<id>-live` and builds into
 * `native/build-<id>-live-release`, both of which `clean --orphans`
 * recognises as owned. An interaction check declares `twin: true` to run
 * against it.
 */
function twinScene(scene: SceneDefinition): SceneDefinition {
    if (scene.parity === undefined) {
        return {
            ...scene,
            id: `${scene.id}-live`,
            output: `generated/${scene.id}-live`,
            buildDirectory: `native/build-${scene.id}-live-release`,
        };
    }
    const { referenceSearch, ...parity } = scene.parity;
    void referenceSearch;
    return {
        ...scene,
        id: `${scene.id}-live`,
        output: `generated/${scene.id}-live`,
        buildDirectory: `native/build-${scene.id}-live-release`,
        parity,
    };
}

/** `process` for a twin: generate, compile shaders, build — each stage
 *  skipped when its record says the tree is current. */
async function processTwin(
    twin: SceneDefinition,
    requireDrawAttribution = false,
): Promise<void> {
    requireDevelopmentPreflight({
        browser: false,
        labSound: sceneUsesNativeFeature(twin, "audio:engine"),
        rmlUi: sceneUsesNativeFeature(twin, "ui:rml"),
        shaders: true,
    });
    await compileScenes([twin]);
    if (
        requireDrawAttribution &&
        !sceneUsesNativeFeature(twin, "renderer:scene")
    ) {
        throw new Error("Draw attribution requires the scene renderer.");
    }
    await shaderStage([twin]).body();
    await buildScenes([twin]);
}

async function specializePhysicsDebugGeometry(
    scene: SceneDefinition,
): Promise<void> {
    requireDevelopmentPreflight({
        browser: false,
        labSound: sceneUsesNativeFeature(scene, "audio:engine"),
        rmlUi: sceneUsesNativeFeature(scene, "ui:rml"),
        shaders: false,
    });
    await buildScenes([scene]);
    const construction = computeBuildStamp(scene.output);
    const directory = resolve(artifactDirectory("physics-constructor-inputs"));
    mkdirSync(directory, { recursive: true });
    const inputPath = join(directory, `${scene.id}.json`);
    console.log(
        `physics debug geometry: extracting construction inputs for ${scene.id}.`,
    );
    // The tree just built is the one whose construction inputs generation
    // folds in: an ambient `BBLITE_NATIVE_EXE` (a diagnostic override for
    // measuring commands) must not redirect generation to a foreign binary,
    // so the scene's own build is named directly. The run still goes
    // through the measured-run gate: the payload beside the executable is
    // verified and the npm_* variables are scrubbed.
    runMeasured(resolveNativeExecutable(undefined, scene.buildDirectory), {
        generatedDirectory: scene.output,
        arguments: ["--physics-constructor-inputs", inputPath],
        timeoutMs: 60_000,
    });
    const entries = await materializePhysicsDebugCatalog(
        JSON.parse(readFileSync(inputPath, "utf8")),
    );
    const manifestPath = join(scene.output, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        inputs: string[];
    };
    const setup = buildSetup();
    const compiler = setup.windows?.compiler ?? setup.tools.cxx;
    // Unlike ordinary scene generation this producer executes native shaping
    // inputs; those sources therefore participate in generation invalidation.
    manifest.inputs = [
        ...new Set([
            ...manifest.inputs,
            setup.cmake,
            ...(compiler ? [compiler] : []),
            ...construction.inputs
                .filter((input) => input.path.startsWith("native/"))
                .map((input) => input.path),
        ]),
    ].sort();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const sourceAndAssets = contentFingerprint([
        ...manifest.inputs,
        join(scene.output, "assets"),
        "dist/.build-stamp",
        "package-lock.json",
        "upstream",
    ]);
    const nativeTools = {
        cmake: toolIdentity(setup.cmake),
        compiler: compiler ? toolIdentity(compiler) : setup.generator,
        generator: setup.generator,
        backend: setup.backend,
    };
    writeFileSync(
        join(scene.output, physicsDebugCatalogPath),
        renderPhysicsDebugCatalog(entries),
    );
    writeFileSync(
        join(scene.output, "physics-debug-geometry.json"),
        `${JSON.stringify(
            {
                version: 1,
                sourceAndAssets,
                nativeTools,
                construction,
                entries: entries.map((entry) => ({
                    descriptor: entry.descriptor,
                    shapeIdentity: entry.shapeIdentity,
                    geometry: hashEntries([JSON.stringify(entry.geometry)]),
                    positions: entry.geometry.positions.length / 3,
                    triangles: entry.geometry.indices.length / 3,
                })),
            },
            null,
            2,
        )}\n`,
    );
    refreshBuildStamp(scene.output, { generatedInputsChanged: true });
    console.log(
        `physics debug geometry: materialized ${entries.length} complete shape descriptor(s).`,
    );
}

/**
 * `scene -- parity <id|all>`: the gate on every measured backend
 * (`measuredBackends`: both by default), or one of its modes — `--runs N`
 * (stability), `--geometry` (copy-task attachments), `--attribute` (the
 * instrumented twin). `rest` is forwarded verbatim to each `all` child.
 */
async function parity(
    idOrSource: string,
    parsed: ParityArguments,
    rest: readonly string[],
): Promise<void> {
    if (idOrSource === "all") {
        const perScene = [
            ["--attribute", parsed.attribute],
            ["--geometry", parsed.geometry],
            ["--runs", parsed.runs !== undefined],
            ["--actual", parsed.actual !== undefined],
            ["--seek", parsed.seekSeconds !== undefined],
        ] as const;
        const refused = perScene.filter(([, set]) => set);
        if (refused.length > 0)
            throw new Error(
                `parity: ${refused.map(([flag]) => flag).join(", ")} requires one scene id or source path.`,
            );
        const measured = scenes.filter((scene) => scene.parity);
        const audioScenes: SceneDefinition[] = [];
        const parallelScenes: SceneDefinition[] = [];
        for (const scene of measured) {
            (sceneUsesNativeFeature(scene, "audio:engine")
                ? audioScenes
                : parallelScenes
            ).push(scene);
        }
        // One child process per scene, not one promise: a scene that loses
        // its GPU device or crashes a native run takes only itself down,
        // and the process-global capture switches (`BBLITE_CAPTURE_UI`,
        // `--gpu-debug`) stay per child.
        // A flat eight, and unlike the other stages it is not derived
        // from the machine -- because the resource it was expected to
        // bind on turned out not to bind at all. Sampling dedicated GPU
        // memory through a whole registry sweep: 0.28 GB per concurrent
        // scene, 2.25 GB attributable at eight at a time, and 2.09 GB at
        // sixteen (scenes finish sooner, so fewer overlap). That fits a
        // 4 GB card beside a desktop, so scaling it to the adapter would
        // add a platform probe to guard a limit nothing reaches.
        //
        // What does bind is GPU throughput. Measuring all 57 scenes:
        // 195.5s at one, 100.0s at two, 52.8s at four, 33.6s at eight,
        // 26.0s at sixteen -- doubling past eight buys 23%. Eight takes
        // the knee of that curve without assuming a workstation GPU;
        // every level produced byte-identical differential reports.
        const inFlight = concurrencyOverride("BBLITE_PARALLEL_PARITY") ?? 8;
        if (inFlight > 1) {
            console.log(
                `Measuring ${measured.length} scenes, ${inFlight} at a time ` +
                    `(${audioScenes.length} audio scenes serialized).`,
            );
        }
        // The children are scene-command.js processes themselves, and they
        // inherit this process's environment — which `holdDistLock` marked
        // when it claimed the lock, so the first finished child cannot
        // unlink it from under the rest of the run.
        const measureBatch = async (
            batch: readonly SceneDefinition[],
            limit: number,
        ): Promise<void> =>
            runConcurrently(
                batch,
                limit,
                (scene) => scene.id,
                (scene) =>
                    runBuffered(
                        {
                            buffer: limit > 1,
                            // The settle that has always followed a measured
                            // run on Windows; per worker rather than per
                            // scene.
                            ...(process.platform === "win32"
                                ? { settleMs: 500 }
                                : {}),
                        },
                        (run) =>
                            run(process.execPath, [
                                resolve("dist/src/scene-command.js"),
                                "parity",
                                scene.id,
                                ...rest,
                            ]),
                    ),
                {
                    // A saturated adapter can occasionally reject one child
                    // even though the same scene is healthy in isolation.
                    // Drain the parallel batch, then give only those failures
                    // one exclusive attempt. A repeat still fails the sweep.
                    retryFailuresSequentially: limit > 1,
                },
            );
        // LabSound owns a process-global hardware device. Separate native
        // processes do not make simultaneous contexts safe on Windows: the
        // contexts can race while tearing down and both exit with an access
        // violation. Keep the GPU-only bulk parallel, then give each scene
        // whose generated manifest reaches audio:engine exclusive ownership.
        const failures: string[] = [];
        for (const [batch, limit] of [
            [parallelScenes, inFlight],
            [audioScenes, 1],
        ] as const) {
            try {
                await measureBatch(batch, limit);
            } catch (error) {
                failures.push((error as Error).message);
            }
        }
        if (failures.length > 0) {
            throw new Error(failures.join("\n  "));
        }
        console.log(
            `All ${measured.length} scenes measured within their gates.`,
        );
        return;
    }
    const scene = resolveScene(idOrSource);
    if (!scene.parity)
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    const backends = measuredBackends(parsed.backend, "parity");
    if (parsed.runs !== undefined) {
        for (const backend of backends) {
            runStabilityReport(scene, {
                backend,
                runs: parsed.runs,
                singleSample: parsed.singleSample,
                ...(parsed.seekSeconds !== undefined
                    ? { seekSeconds: parsed.seekSeconds }
                    : {}),
            });
        }
        return;
    }
    if (parsed.geometry) {
        const { runGeometryOutputDiagnostics } =
            await import("./geometry-output-diagnostics.js");
        await runGeometryOutputDiagnostics(scene, {
            backends,
            recaptureReference: parsed.recaptureReference,
            ...(parsed.seekSeconds !== undefined
                ? { seekSeconds: parsed.seekSeconds }
                : {}),
        });
        return;
    }
    const gate = {
        ...(parsed.seekSeconds !== undefined
            ? { seekSeconds: parsed.seekSeconds }
            : {}),
        ...(parsed.without !== undefined ? { without: parsed.without } : {}),
        ...(parsed.actual !== undefined ? { actual: parsed.actual } : {}),
        attribute: parsed.attribute,
        recaptureReference: parsed.recaptureReference,
        noFail: parsed.noFail,
    };
    if (parsed.attribute) {
        if (
            !existsSync(scene.parity.reference.path) &&
            !parsed.recaptureReference
        ) {
            throw new Error(
                `Attribution requires the source scene's reference: ${scene.parity.reference.path}.`,
            );
        }
        const twin = attributionScene(scene);
        copyAttributionReferences(scene, twin);
        await processTwin(twin, true);
        // The twin is its own build: an ambient executable override names
        // the source scene's binary, which renders no attribution buffers.
        await withEnvironment("BBLITE_NATIVE_EXE", undefined, () =>
            runParityBackends(twin, backends, gate),
        );
        return;
    }
    await runParityBackends(scene, backends, gate);
}

async function build(idOrSource: string): Promise<void> {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    const reachesAudio =
        idOrSource === "all" ||
        selected.some((scene) => sceneUsesNativeFeature(scene, "audio:engine"));
    const reachesUi =
        idOrSource === "all" ||
        selected.some((scene) => sceneUsesNativeFeature(scene, "ui:rml"));
    requireDevelopmentPreflight({
        browser: false,
        labSound: reachesAudio,
        rmlUi: reachesUi,
        shaders: false,
    });
    await buildScenes(selected);
}

function sceneUsesNativeFeature(
    scene: SceneDefinition,
    feature: string,
): boolean {
    const features = resolve(scene.output, "features.cmake");
    return (
        existsSync(features) && readFileSync(features, "utf8").includes(feature)
    );
}

/** A positive-integer environment override, rejected loudly if malformed. */
function concurrencyOverride(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer (got '${value}').`);
    }
    return parsed;
}

/**
 * How many scenes compile at once, and how many jobs each is given.
 *
 * Every scene is an independent CMake project writing to its own build
 * directory, so the only shared resource is the machine. One scene alone
 * cannot use it: a registry-wide rebuild after a PAL edit leaves each
 * scene with a handful of dirty translation units, so the sequential loop
 * ran two or three compilers on a 32-core host.
 *
 * The budget is expressed in compiler processes rather than scenes,
 * because that is what costs memory -- MSVC on `pal_dawn.cpp` is the
 * heaviest translation unit here. Scenes in flight times jobs per scene
 * stays near the core count, and both halves are overridable for a
 * smaller machine.
 */
function buildConcurrency(): {
    scenes: number;
    jobsPerScene: number;
} {
    const override = concurrencyOverride;
    // One job per scene, and as many scenes as the machine can hold.
    //
    // Measured on a 24-core/32-thread, 69 GB host, rebuilding all 58
    // scenes after a `pal_dawn.cpp` edit: 246.7s sequential, then
    //
    //     32x1  25.9s     24x1  28.4s     16x2  30.6s
    //                     12x2  33.6s      8x3  42.3s
    //
    // Splitting the same budget the other way costs 15-33%: an
    // incremental rebuild leaves most scenes with one or two dirty
    // translation units, so a second job per scene has nothing to do
    // while a second scene always does. Threads beat cores by 9%, which
    // is real but much smaller than getting the split right.
    const jobsPerScene = override("BBLITE_SCENE_BUILD_JOBS") ?? 1;
    // Two limits, whichever binds first: hardware threads, and roughly
    // 2 GB per compiler process, which is what MSVC wants for the
    // heaviest translation unit here. Free memory never moved on the
    // host above, so the memory term is there for smaller machines.
    const compilerBudget = Math.min(
        availableParallelism(),
        Math.floor(totalmem() / 2e9),
    );
    const scenesInFlight =
        override("BBLITE_PARALLEL_SCENES") ??
        Math.max(1, Math.floor(compilerBudget / jobsPerScene));
    return { scenes: scenesInFlight, jobsPerScene };
}

/**
 * Builds each scene, several at a time. Output is buffered per scene and
 * printed whole when that scene finishes, so interleaved compilers stay
 * readable and a failure keeps its own diagnostics together.
 *
 * A failure does not cancel the scenes already running: they are allowed
 * to finish so one broken scene does not hide the state of the rest, and
 * every failure is reported together at the end.
 */
async function buildScenes(
    selected: readonly (typeof scenes)[number][],
): Promise<void> {
    const { vcpkg, tools, environment, generator } = buildSetup();
    if (vcpkg) installVcpkgManifest(tools.vcpkg!, vcpkg.install, environment);
    if (selected.length === 1) {
        await runSceneBuild(
            selected[0]!,
            concurrencyOverride("BBLITE_SCENE_BUILD_JOBS"),
            false,
        );
        return;
    }
    const { scenes: inFlight, jobsPerScene } = buildConcurrency();
    console.log(
        `Building ${selected.length} scenes, ${inFlight} at a time ` +
            `(${jobsPerScene} jobs each).`,
    );
    await runConcurrently(
        orderByHistoricalCost(selected, (scene) =>
            historicalBuildCostMs(
                compiledBuildDirectory(scene.buildDirectory),
                generator,
            ),
        ),
        inFlight,
        (scene) => scene.id,
        (scene) => runSceneBuild(scene, jobsPerScene, true),
        { completed: "built" },
    );
}

/**
 * True when the build directory was configured with exactly the values
 * this invocation would pass. Anything unaccounted for -- a missing
 * cache, a value that differs, a generator switch -- configures again,
 * so the skip can only ever be taken when it changes nothing.
 */
function cacheMatchesConfiguration(
    buildDirectory: string,
    configureArguments: string[],
): boolean {
    if (process.env.BBLITE_COLD_BUILD === "1") {
        return false;
    }
    const cache = readCacheConfiguration(buildDirectory);
    if (!cache) {
        return false;
    }
    const generatorIndex = configureArguments.indexOf("-G");
    const generator =
        generatorIndex >= 0
            ? configureArguments[generatorIndex + 1]
            : undefined;
    if (generator !== undefined && cache.CMAKE_GENERATOR !== generator) {
        return false;
    }
    const passed = new Set<string>();
    for (const argument of configureArguments) {
        if (!argument.startsWith("-D")) {
            continue;
        }
        const separator = argument.indexOf("=");
        if (separator < 0) {
            return false;
        }
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        passed.add(name);
        const cached = cache[name];
        if (cached === undefined) {
            return false;
        }
        if (!sameCachePath(cached, value)) {
            return false;
        }
    }
    // The optional entries are compared in the unset direction too: a
    // cache still carrying BBLITE_SDL_DIR from a previous configure while
    // this invocation passes none would silently keep building against
    // the previous SDL3, so the absence has to reconfigure as much as a
    // changed value does.
    for (const name of ["BBLITE_SDL_DIR"]) {
        if (!passed.has(name) && cache[name]) {
            return false;
        }
    }
    return true;
}

/**
 * `--cold` reconfigures every build directory it touches instead of
 * trusting the cache comparison. Nothing should need it -- a mismatch
 * reconfigures on its own -- but the pre-push validation run has the
 * option of not depending on that reasoning at all.
 */
async function withColdBuild(
    parsed: ParsedFlags,
    body: () => Promise<void>,
): Promise<void> {
    if (!parsed.flags.has("--cold")) {
        await body();
        return;
    }
    await withEnvironment("BBLITE_COLD_BUILD", "1", body);
}

/** Build/process flags which shape the compiled tree, not the runtime. */
async function withBuildOptions(
    command: "build" | "process",
    parsed: ParsedFlags,
    body: () => Promise<void>,
): Promise<void> {
    const requestedBackend = parsed.values.get("--backend");
    const requestedCompiler = parsed.values.get("--compiler");
    const requestedShader = parsed.values.get("--shader");
    const withBackend = async (next: () => Promise<void>): Promise<void> => {
        if (requestedBackend === undefined) return next();
        await withEnvironment(
            "BBLITE_BACKEND",
            canonicalCompiledBackend(requestedBackend, command),
            next,
        );
    };
    const withCompiler = async (next: () => Promise<void>): Promise<void> => {
        if (requestedCompiler === undefined) return next();
        await withEnvironment(
            "BBLITE_DEV_COMPILER",
            canonicalDevelopmentCompiler(requestedCompiler),
            next,
        );
    };
    const withShader = async (next: () => Promise<void>): Promise<void> => {
        if (requestedShader === undefined) return next();
        await withEnvironment(
            "BBLITE_SHADER_TARGET",
            canonicalOfflineShaderTarget(requestedShader),
            next,
        );
    };
    await withBackend(() =>
        withCompiler(() => withShader(() => withColdBuild(parsed, body))),
    );
}

/**
 * The generator, toolchain environment and backend selection every scene
 * shares. Resolving it per scene meant running `vswhere` and rebuilding
 * the MSVC environment once per scene for one answer, and the backend
 * validation only reported a bad `BBLITE_BACKEND` once the first scene
 * reached it.
 */
interface SharedBuildSetup {
    cmake: string;
    environment: NodeJS.ProcessEnv;
    generator: string;
    windows: WindowsBuildTools | undefined;
    backend: CompiledBackend;
    tools: DevelopmentTools;
    vcpkg:
        | {
              root: string;
              toolchain: string;
              install: VcpkgManifestInstall;
          }
        | undefined;
}

let sharedBuildSetup: SharedBuildSetup | undefined;
let sharedDevelopmentTools: DevelopmentTools | undefined;
let sharedWindowsBuildTools: WindowsBuildTools | undefined;

function currentDevelopmentTools(): DevelopmentTools {
    sharedDevelopmentTools ??= discoverDevelopmentTools();
    return sharedDevelopmentTools;
}

function currentWindowsBuildTools(): WindowsBuildTools {
    const tools = currentDevelopmentTools();
    sharedWindowsBuildTools ??= discoverWindowsBuildTools(
        canonicalDevelopmentCompiler(process.env.BBLITE_DEV_COMPILER ?? "auto"),
        tools.visualStudioRoot
            ? {
                  environment: {
                      ...process.env,
                      VSINSTALLDIR: tools.visualStudioRoot,
                  },
              }
            : {},
    );
    return sharedWindowsBuildTools;
}

function buildSetup(): SharedBuildSetup {
    if (sharedBuildSetup) return sharedBuildSetup;
    const generator = process.env.BBLITE_CMAKE_GENERATOR ?? "Ninja";
    const windows =
        process.platform === "win32" && generator === "Ninja"
            ? currentWindowsBuildTools()
            : undefined;
    const tools = currentDevelopmentTools();
    if (!tools.cmake) {
        throw new Error(
            "CMake was not found. Install CMake or set CMAKE_COMMAND (see docs/development.md#setup).",
        );
    }
    // Backend selection: BOTH (the dual-backend differential binary) for
    // development. A missing pinned Dawn install is an incomplete dev setup,
    // not a reason to silently reduce validation to SDL_GPU. Set
    // BBLITE_BACKEND=SDL_GPU|DAWN|BOTH to override;
    // BBLITE_GPU_BACKEND still selects at runtime in BOTH builds.
    const backend = selectedCompiledBackend();
    if ((backend === "DAWN" || backend === "BOTH") && !tools.dawnInstalled) {
        throw new Error(
            `BBLITE_BACKEND=${backend} requires pinned Dawn at ${tools.dawnDirectory}. Run 'npm run dev:setup'.`,
        );
    }
    const needsVcpkg = !process.env.BBLITE_SDL_DIR;
    if (
        needsVcpkg &&
        (!tools.vcpkgRoot || !tools.vcpkg || !tools.vcpkgToolchain)
    ) {
        throw new Error(
            "vcpkg was not found. Install the Visual Studio vcpkg component, set VCPKG_ROOT, or run with BBLITE_SDL_DIR for a shipping SDL tree.",
        );
    }
    const vcpkg = !needsVcpkg
        ? undefined
        : {
              root: tools.vcpkgRoot!,
              toolchain: tools.vcpkgToolchain!,
              install: developmentVcpkgInstall(),
          };
    const environment: NodeJS.ProcessEnv = {
        ...(windows?.environment ?? setupEnvironment(tools)),
        CMAKE_COMMAND: tools.cmake,
        ...(vcpkg ? { VCPKG_ROOT: vcpkg.root } : {}),
        ...(tools.tint ? { TINT_PATH: tools.tint } : {}),
        ...(tools.dxc ? { DXC_PATH: tools.dxc } : {}),
    };
    sharedBuildSetup = {
        cmake: tools.cmake,
        environment,
        generator,
        windows,
        backend,
        tools,
        vcpkg,
    };
    return sharedBuildSetup;
}

interface DevelopmentCheck {
    label: string;
    path?: string;
    problem?: string;
}

interface PreflightScope {
    browser: boolean;
    labSound: boolean;
    rmlUi: boolean;
    shaders: boolean;
}

/** Why a pinned artifact counts as not installed: its stale record, or its absence. */
function artifactProblem(
    tools: DevelopmentTools,
    library: DependencyPatchRecord["library"],
    directory: string,
): string {
    return (
        tools.dependencyPatchRecords.find(
            (record) =>
                record.library === library && record.state.state === "stale",
        )?.message ?? `not built at ${directory}`
    );
}

function developmentChecks(scope: PreflightScope): DevelopmentCheck[] {
    const tools = currentDevelopmentTools();
    const checks: DevelopmentCheck[] = [
        { label: "Node.js", path: process.execPath },
        {
            label: "CMake",
            ...(tools.cmake
                ? { path: tools.cmake }
                : {
                      problem: "not found (install CMake or set CMAKE_COMMAND)",
                  }),
        },
    ];
    const generator = process.env.BBLITE_CMAKE_GENERATOR ?? "Ninja";
    if (process.platform === "win32" && generator === "Ninja") {
        try {
            const windows = currentWindowsBuildTools();
            checks.push(
                { label: "Ninja", path: windows.ninja },
                { label: "C++ compiler", path: windows.compiler },
            );
        } catch (error) {
            checks.push({
                label: "Visual Studio C++/Ninja",
                problem: (error as Error).message,
            });
        }
    } else if (process.platform !== "win32") {
        checks.push({
            label: "C++ compiler",
            ...(tools.cxx
                ? { path: tools.cxx }
                : {
                      problem:
                          "C++ compiler was not found; install Clang or set CXX",
                  }),
        });
        if (generator === "Ninja") {
            checks.push({
                label: "Ninja",
                ...(tools.ninja
                    ? { path: tools.ninja }
                    : { problem: "ninja was not found" }),
            });
        }
    }
    if (!process.env.BBLITE_SDL_DIR) {
        checks.push({
            label: "vcpkg",
            ...(tools.vcpkg && tools.vcpkgToolchain
                ? { path: tools.vcpkg }
                : {
                      problem:
                          "not found (install the Visual Studio vcpkg component or set VCPKG_ROOT)",
                  }),
        });
    }
    let backend: CompiledBackend | undefined;
    try {
        backend = selectedCompiledBackend();
    } catch (error) {
        checks.push({ label: "backend", problem: (error as Error).message });
    }
    if (backend === "DAWN" || backend === "BOTH") {
        checks.push({
            label: "Dawn",
            ...(tools.dawnInstalled
                ? { path: tools.dawnDirectory }
                : {
                      problem: artifactProblem(
                          tools,
                          "dawn",
                          tools.dawnDirectory,
                      ),
                  }),
        });
    }
    if (
        scope.shaders &&
        backend !== undefined &&
        needsOfflineShaders(backend, process.env.BBLITE_SHADER_TARGET)
    ) {
        const target = shaderTarget();
        if (target !== "metal") {
            checks.push({
                label: "DXC",
                ...(tools.dxc
                    ? { path: tools.dxc }
                    : { problem: `not installed for shader target ${target}` }),
            });
        }
        checks.push({
            label: "Tint",
            ...(tools.tint
                ? { path: tools.tint }
                : { problem: "pinned Tint was not built" }),
        });
    }
    if (scope.labSound) {
        checks.push({
            label: "LabSound",
            ...(tools.labSoundInstalled
                ? { path: tools.labSoundDirectory }
                : {
                      problem: artifactProblem(
                          tools,
                          "labsound",
                          tools.labSoundDirectory,
                      ),
                  }),
        });
    }
    if (scope.rmlUi) {
        checks.push({
            label: "RmlUi",
            ...(tools.rmlUiInstalled
                ? { path: tools.rmlUiDirectory }
                : {
                      problem: artifactProblem(
                          tools,
                          "rmlui",
                          tools.rmlUiDirectory,
                      ),
                  }),
        });
    }
    if (scope.browser) {
        try {
            checks.push({
                label: "Chromium",
                path: resolveBrowserPath(),
            });
        } catch (error) {
            checks.push({
                label: "Chromium",
                problem: (error as Error).message,
            });
        }
    }
    return checks;
}

function requireDevelopmentPreflight(scope: PreflightScope): void {
    const failures = developmentChecks(scope).filter((check) => check.problem);
    if (failures.length > 0) {
        throw new Error(
            `Development preflight failed before generation/build:\n${failures
                .map((check) => `  - ${check.label}: ${check.problem}`)
                .join("\n")}\nRun 'npm run dev:setup', then 'npm run doctor'.`,
        );
    }
    buildSetup();
}

function runDoctor(): void {
    const checks = [
        ...developmentChecks({
            browser: true,
            labSound: true,
            rmlUi: true,
            shaders: true,
        }),
        ...checkPatchInventory().map((problem): DevelopmentCheck => ({
            label: "patch inventory",
            problem,
        })),
    ];
    for (const record of currentDevelopmentTools().dependencyPatchRecords) {
        if (record.message && record.state.state !== "stale")
            console.log(`WARN    ${record.library}: ${record.message}`);
    }
    for (const check of checks) {
        console.log(
            `${check.problem ? "MISSING" : "OK     "} ${check.label}: ${
                check.problem ?? check.path
            }`,
        );
    }
    const failures = checks.filter((check) => check.problem);
    if (failures.length > 0) {
        throw new Error(
            `doctor: ${failures.length} development prerequisite(s) missing. Run 'npm run dev:setup'.`,
        );
    }
    console.log("doctor: full development environment ready.");
}

function setupEnvironment(tools: DevelopmentTools): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...(tools.cmake ? { CMAKE_COMMAND: tools.cmake } : {}),
        ...(tools.vcpkgRoot ? { VCPKG_ROOT: tools.vcpkgRoot } : {}),
        ...(tools.cc ? { CC: tools.cc } : {}),
        ...(tools.cxx ? { CXX: tools.cxx } : {}),
    };
}

function runDevelopmentSetup(): void {
    if (
        process.platform !== "win32" &&
        process.platform !== "linux" &&
        process.platform !== "darwin"
    ) {
        throw new Error(
            "dev:setup supports Windows, Linux and macOS; install host tools manually on this platform and run 'npm run doctor'.",
        );
    }
    const tools = discoverDevelopmentTools();
    const bootstrapMissing = [
        ["CMake", tools.cmake],
        ["vcpkg", tools.vcpkg],
        ["PowerShell", tools.powershell],
        ["git", tools.git],
        ...(process.platform !== "win32"
            ? [
                  ["Clang (or CC)", tools.cc],
                  ["Clang++ (or CXX)", tools.cxx],
              ]
            : []),
    ].filter((entry) => !entry[1]);
    if (bootstrapMissing.length > 0) {
        throw new Error(
            `dev:setup needs ${bootstrapMissing.map(([label]) => label).join(", ")}. See docs/development.md#setup for host prerequisites.`,
        );
    }
    const environment = setupEnvironment(tools);
    installVcpkgManifest(tools.vcpkg!, developmentVcpkgInstall(), environment);
    const pinnedDxc = resolve(
        "tools",
        "shader-compiler",
        "vcpkg_installed",
        developmentTriplet(),
        "tools",
        "directx-dxc",
        process.platform === "win32" ? "dxc.exe" : "dxc",
    );
    if (
        hostOfflineShaderTarget(process.platform) !== "metal" &&
        !existsSync(pinnedDxc)
    ) {
        run(
            tools.vcpkg!,
            [
                "install",
                `--x-manifest-root=${resolve("tools", "shader-compiler")}`,
                `--x-install-root=${resolve(
                    "tools",
                    "shader-compiler",
                    "vcpkg_installed",
                )}`,
                `--triplet=${developmentTriplet()}`,
            ],
            environment,
        );
    }
    // A stale source/patch record makes its artifact count as not installed,
    // so it is rebuilt below; an unrecorded one is reported and kept.
    for (const record of tools.dependencyPatchRecords) {
        if (record.message) console.log(`setup: ${record.message}`);
    }
    const buildPinned = (installed: boolean, script: string): void => {
        if (!installed) {
            run(
                tools.powershell!,
                ["-File", script, "-CMake", tools.cmake!],
                environment,
            );
        }
    };
    buildPinned(tools.dawnInstalled, "tools/build-dawn.ps1");
    buildPinned(!!tools.tint, "tools/build-tint.ps1");
    buildPinned(tools.labSoundInstalled, "tools/build-labsound.ps1");
    buildPinned(tools.rmlUiInstalled, "tools/build-rmlui.ps1");
    if (!tools.ccache && process.platform === "win32") {
        run(
            tools.powershell!,
            ["-File", "tools/install-ccache.ps1"],
            environment,
        );
    }
    sharedBuildSetup = undefined;
    sharedDevelopmentTools = undefined;
    sharedWindowsBuildTools = undefined;
    runDoctor();
}

/**
 * Deletes what the build directory deploys and the generated tree no longer
 * has.
 *
 * The asset deploy merges rather than mirrors, for the reason
 * `native/CMakeLists.txt` records beside it. The cost is that a file the
 * generated tree drops stays behind, and the measured run then refuses to
 * start over an asset it never asked for. Pruning here keeps the copy
 * incremental: only the orphans are removed.
 *
 * `payloadOrphans` shares its walk with `comparePayload`, so the prune and
 * the guard that reports an orphan cannot disagree about what one is — and
 * the prune skips the byte-compare of every expected file, which it never
 * used.
 */
function pruneDeployedOrphans(scene: (typeof scenes)[number]): void {
    for (const payload of deployedPayloads(
        resolve(scene.buildDirectory),
        resolve(scene.output),
    )) {
        for (const path of payloadOrphans(payload)) {
            rmSync(resolve(payload.deployed, path), { force: true });
        }
    }
}

/**
 * CMake cannot safely change a build tree's generator, compiler, make
 * program, toolchain, or vcpkg install root. Recreate only that disposable
 * scene tree before configure instead of leaving a poisoned cache behind.
 */
function resetIncompatibleBuildTree(
    buildDirectory: string,
    configureArguments: string[],
): void {
    const cache = readCacheConfiguration(buildDirectory);
    if (!cache) return;
    const incompatible = incompatibleCacheEntries(cache, configureArguments);
    if (incompatible.length === 0) return;
    const nativeRoot = resolve("native");
    const target = resolve(buildDirectory);
    const withinNative = relative(nativeRoot, target);
    if (
        withinNative === "" ||
        withinNative.startsWith("..") ||
        isAbsolute(withinNative)
    ) {
        throw new Error(
            `Refusing to replace compiler cache outside native/: ${target}.`,
        );
    }
    console.log(
        `build: ${incompatible.map((entry) => entry.name).join(", ")} changed; ` +
            `recreating incompatible disposable tree ${buildDirectory}.`,
    );
    rmSync(target, { recursive: true, force: true });
}

async function runSceneBuild(
    scene: (typeof scenes)[number],
    jobsPerScene: number | undefined,
    captureOutput: boolean,
): Promise<void> {
    const { cmake, environment, generator, windows, backend, tools, vcpkg } =
        buildSetup();
    scene = {
        ...scene,
        buildDirectory: compiledBuildDirectory(scene.buildDirectory),
    };
    refreshBuildStamp(scene.output);
    const configureArguments = [
        "-S",
        "native",
        "-B",
        scene.buildDirectory,
        "-DCMAKE_BUILD_TYPE=Release",
        `-DBBLITE_GENERATED_DIR=${resolve(scene.output)}`,
        "-G",
        generator,
    ];
    configureArguments.push(
        `-DBBLITE_BACKEND=${backend}`,
        `-DBBLITE_NATIVE_CACHE=${process.env.BBLITE_NATIVE_CACHE === "0" ? "OFF" : "ON"}`,
        `-DBBLITE_CCACHE=${tools.ccache ?? "BBLITE_CCACHE-NOTFOUND"}`,
        `-DBBLITE_CHECKED_HANDLES=${process.env.BBLITE_CHECKED_HANDLES === "1" ? "ON" : "OFF"}`,
        `-DBBLITE_DAWN_DIR=${tools.dawnDirectory}`,
        `-DBBLITE_LABSOUND_DIR=${tools.labSoundDirectory}`,
        `-DBBLITE_RMLUI_DIR=${tools.rmlUiDirectory}`,
    );
    // An SDL3 install to use instead of the toolchain's. Forwarded like
    // BBLITE_BACKEND so a whole-matrix run can be pointed at one build,
    // and included in the cache comparison below so switching it always
    // reconfigures rather than silently keeping the previous SDL3.
    const sdlDirectory = process.env.BBLITE_SDL_DIR;
    if (sdlDirectory) {
        configureArguments.push(`-DBBLITE_SDL_DIR=${resolve(sdlDirectory)}`);
    }
    if (windows) {
        configureArguments.push(
            `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`,
            `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
        );
    } else if (tools.cxx) {
        configureArguments.push(`-DCMAKE_CXX_COMPILER=${tools.cxx}`);
    }
    if (vcpkg) {
        configureArguments.push(
            `-DCMAKE_TOOLCHAIN_FILE=${vcpkg.toolchain}`,
            `-DVCPKG_INSTALLED_DIR=${vcpkg.install.installedDirectory}`,
            `-DVCPKG_TARGET_TRIPLET=${vcpkg.install.triplet}`,
            `-DVCPKG_MANIFEST_FEATURES=${vcpkg.install.features.join(";")}`,
            // The shared install is made current once per population run
            // (`ensureDevelopmentVcpkgInstall`); a configure runs no vcpkg.
            "-DVCPKG_MANIFEST_INSTALL=OFF",
        );
    }
    // Configure only when the cache does not already hold exactly what
    // this invocation would set — or when a configure input
    // (CMakeLists.txt, vcpkg.json, the scene's features.cmake) is newer
    // than the cache. The generator would re-run CMake for the latter
    // itself, inside the build; configuring it here keeps the output
    // attributed to the step that ran.
    await runBuffered(
        { buffer: captureOutput, label: `--- ${scene.id}\n` },
        async (run) => {
            resetIncompatibleBuildTree(
                scene.buildDirectory,
                configureArguments,
            );
            if (
                !cacheMatchesConfiguration(
                    scene.buildDirectory,
                    configureArguments,
                ) ||
                generatorWouldReconfigure(scene.buildDirectory, scene.output)
            ) {
                await run(cmake, configureArguments, environment);
            }
            pruneDeployedOrphans(scene);
            await run(
                cmake,
                [
                    "--build",
                    scene.buildDirectory,
                    "--config",
                    "Release",
                    "--parallel",
                    // Without a count ninja takes the whole machine, which
                    // is wrong once scenes run beside each other.
                    ...(jobsPerScene === undefined
                        ? []
                        : [String(jobsPerScene)]),
                ],
                environment,
            );
        },
    );
}

/** One validation stage. Individual tools own their reuse records. */
interface Stage {
    name: string;
    body: () => Promise<void>;
}

/** The one offline shader format this host compiles, or the override. */
function shaderTarget(): OfflineShaderTarget {
    return hostOfflineShaderTarget(
        process.platform,
        process.env["BBLITE_SHADER_TARGET"],
    );
}

/** Each selected shader directory reuses its own content checkpoint. */
function shaderStage(selected: readonly SceneDefinition[]): Stage {
    const setup = buildSetup();
    if (!needsOfflineShaders(setup.backend, process.env.BBLITE_SHADER_TARGET)) {
        return {
            name: "shaders (Dawn WGSL)",
            body: async () => {
                console.log(
                    "shaders: Dawn consumes generated WGSL; no offline compiler required.",
                );
            },
        };
    }
    return {
        name: "shaders",
        body: async () => {
            const directories = selected
                .map((scene) => resolve(scene.output, "upstream", "shaders"))
                .filter(existsSync);
            if (directories.length === 0) return;
            const { compileOfflineShaders, formatShaderCompilation } =
                await import("./compile-shaders.js");
            console.log(
                formatShaderCompilation(
                    compileOfflineShaders({
                        directories,
                        target: shaderTarget(),
                        tools: setup.tools,
                        environment: setup.environment,
                        cold: coldBuild(),
                    }),
                ),
            );
        },
    };
}

async function processScene(idOrSource: string): Promise<void> {
    requireDevelopmentPreflight({
        browser: true,
        labSound: idOrSource === "all",
        rmlUi: idOrSource === "all",
        shaders: true,
    });
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    await compile(idOrSource);
    await shaderStage(selected).body();
    if (idOrSource === "all") {
        await buildScenes(scenes);
        return;
    }
    await build(idOrSource);
}

/**
 * The browser capture as evidence at `pose`: reused while it is current
 * (`browserCaptureStaleness`), recaptured when it is stale or `recapture`
 * forces it. The one reuse rule `diff` and `diff --uniforms` share.
 */
async function ensureBrowserCapture(
    idOrSource: string,
    scene: SceneDefinition,
    captureDirectory: string,
    pose: ScenePose,
    recapture: boolean,
): Promise<void> {
    const { browserCaptureStaleness, runInstrumentedCapture } =
        await import("./capture-instrumented.js");
    const reason = browserCaptureStaleness(scene, captureDirectory, {
        requireSeek: pose.seekSeconds ?? null,
    });
    if (!recapture && reason === undefined) return;
    if (!recapture && reason !== "missing") {
        console.log(`Browser capture ${reason}; recapturing.`);
    }
    await runInstrumentedCapture(idOrSource, {
        ...(pose.seekSeconds !== undefined
            ? { seekSeconds: pose.seekSeconds }
            : {}),
        outputDirectory: captureDirectory,
    });
}

interface RenderDiffOptions {
    backend?: string;
    captureDirectory?: string;
    seekSeconds?: number;
    recapture: boolean;
}

/**
 * Capture both sides of a scene and report every difference.
 *
 * The captures are taken unless they are already on disk, because the
 * common shape of an investigation is one capture and many readings of
 * it: re-rendering the browser page for every question would make the
 * loop slow enough that it stops being the first thing anyone reaches
 * for. `--recapture` forces both, which is what to use after any change
 * to the scene, the compiler or the native build.
 */
async function runRenderDiff(
    idOrSource: string,
    options: RenderDiffOptions,
): Promise<{ findings: string[]; reportPath: string }> {
    const scene = resolveScene(idOrSource);
    const backend = resolveBackend(options.backend, "diff");
    const token = backendFileToken(backend);
    const captureDirectory = resolve(
        options.captureDirectory ?? defaultCaptureDirectory(scene.id),
    );
    // A capture on disk is only reusable when it was taken at this pose,
    // from the scene module as it stands — diffing across poses, or
    // against evidence from a scene source or pinned package that has
    // since moved, is the stale-evidence class this command exists to
    // prevent.
    const pose = resolvePose(scene, options.seekSeconds);
    await ensureBrowserCapture(
        idOrSource,
        scene,
        captureDirectory,
        pose,
        options.recapture,
    );
    // One shared spelling with the native-capture writer, so reader and
    // writer cannot drift.
    let nativeCapturePath = captureNativePaths(captureDirectory, token).capture;
    const nativeReason = nativeCaptureStaleness(
        scene,
        captureDirectory,
        token,
        pose.seekSeconds ?? null,
    );
    if (options.recapture || nativeReason !== undefined) {
        if (!options.recapture && nativeReason !== "missing") {
            console.log(`Native capture ${nativeReason}; recapturing.`);
        }
        const result = runNativeCapture(idOrSource, {
            backend,
            ...(options.seekSeconds !== undefined
                ? { seekSeconds: options.seekSeconds }
                : {}),
            outputDirectory: captureDirectory,
        });
        nativeCapturePath = result.capturePath;
    }
    const { buildRenderDiff, formatRenderDiff } =
        await import("./render-diff.js");
    const report = buildRenderDiff(
        scene.id,
        captureDirectory,
        nativeCapturePath,
        resolve(scene.output),
    );
    const reportPath = join(captureDirectory, `diff-${token}.json`);
    writeReport(
        reportPath,
        {
            tool: "diff",
            backend,
            generatedDirectory: resolve(scene.output),
        },
        report,
        1,
    );
    console.log(formatRenderDiff(report));
    console.log("");
    console.log(`Full report: ${reportPath}`);
    // A capture whose hooked render differed from the committed golden is
    // still self-consistent evidence for this browser-vs-native pairing,
    // but the reader deserves to know the golden moved out from under it.
    const meta = readCaptureMeta(captureMetaPath(captureDirectory));
    if (meta?.goldenIdentity === "differs") {
        console.warn(
            "Note: the browser capture DIFFERS from the committed golden — " +
                "the environment or pinned package moved since the golden was captured.",
        );
    }
    return { findings: report.findings, reportPath };
}

/**
 * `scene -- diff <id> --uniforms`: decode the captured browser uniform
 * buffers by WGSL struct size, from a browser capture current at the pose
 * (the same reuse rule as the pairing).
 */
async function runUniforms(
    idOrSource: string,
    parsed: ParsedFlags,
): Promise<void> {
    const scene = resolveScene(idOrSource);
    const directory = resolve(
        parsed.values.get("--capture") ?? defaultCaptureDirectory(scene.id),
    );
    const sizes = parsed.values.get("--size");
    const module = parsed.values.get("--module");
    await ensureBrowserCapture(
        idOrSource,
        scene,
        directory,
        resolvePose(scene, flagNumber(parsed, "--seek", "diff")),
        parsed.flags.has("--recapture"),
    );
    const { decodeCapturedUniforms, formatDecodedUniforms } =
        await import("./capture-uniforms.js");
    const decoded = decodeCapturedUniforms(directory, {
        ...(sizes !== undefined
            ? {
                  sizes: sizes.split(",").map((value) => {
                      const numeric = Number(value);
                      if (!Number.isFinite(numeric)) {
                          // A NaN would filter every buffer out silently:
                          // the tool would answer "no buffers" to a
                          // mistyped size.
                          throw new Error(
                              `diff: --size must be comma-separated numbers (got '${value}').`,
                          );
                      }
                      return numeric;
                  }),
              }
            : {}),
        ...(module !== undefined ? { module } : {}),
    });
    console.log(formatDecodedUniforms(decoded));
}

/** The three readings of one capture directory `diff` offers. */
type DiffView = "pair" | "uniforms" | "compose";

/**
 * Which reading a `diff` invocation asks for, refusing flags that belong
 * to another one: the pairing (default) needs both halves, `--uniforms`
 * decodes the browser half alone, `--compose` composes every glTF material
 * against the captured fragments.
 */
function diffView(idOrSource: string, parsed: ParsedFlags): DiffView {
    const uniforms = parsed.flags.has("--uniforms");
    const compose = parsed.flags.has("--compose");
    if (uniforms && compose) {
        throw new Error(
            "diff: --uniforms and --compose are separate readings; run them separately.",
        );
    }
    const refuse = (view: string, flags: readonly string[]): void => {
        const present = flags.filter(
            (flag) => parsed.values.has(flag) || parsed.flags.has(flag),
        );
        if (present.length > 0) {
            throw new Error(
                `diff: ${present.join(", ")} does not apply to ${view}.`,
            );
        }
    };
    if (!uniforms)
        refuse("this reading (it rides --uniforms)", ["--size", "--module"]);
    if (uniforms)
        refuse("--uniforms, which reads the browser half only", [
            "--backend",
            "--gpu-debug",
        ]);
    if (compose) {
        refuse("--compose, which reads the browser fragments only", [
            "--backend",
            "--gpu-debug",
            "--recapture",
        ]);
    }
    if (idOrSource === "all" && !compose) {
        throw new Error("diff: 'all' applies to --compose only.");
    }
    if (compose && idOrSource === "all" && parsed.values.has("--capture")) {
        throw new Error(
            "diff: --capture names one scene's capture directory and does not compose with 'all'.",
        );
    }
    return uniforms ? "uniforms" : compose ? "compose" : "pair";
}

/**
 * `scene -- capture <id> --seek-bracket`: three browser captures — the
 * exact seek, one frame before, one frame after — and the MAD between the
 * exact frame and each neighbour, which is the scale of one frame of
 * motion. A residual is then judged against that scale instead of against
 * intuition.
 */
async function runSeekBracketCapture(
    idOrSource: string,
    explicitSeek: number | undefined,
    outputDirectory: string | undefined,
): Promise<void> {
    const scene = resolveScene(idOrSource);
    // One bracket step is one *display* frame — the scale a residual is
    // judged against — not a clip's own frame rate.
    const frameRate = 60;
    const plan = seekBracketPlan(
        resolvePose(scene, explicitSeek).seekSeconds,
        frameRate,
    );
    const captureDirectory = resolve(
        outputDirectory ?? defaultCaptureDirectory(scene.id),
    );
    const { runInstrumentedCapture } =
        await import("./capture-instrumented.js");
    // The exact-seek capture keeps its byte-identity check against the
    // committed golden when the golden holds that pose; the neighbours sit
    // one frame away from it by design, so `resolvePose` skips theirs.
    await runInstrumentedCapture(idOrSource, {
        seekSeconds: plan.seekSeconds,
        outputDirectory: captureDirectory,
    });
    const brackets = [
        {
            label: "-1 frame",
            seekSeconds: plan.minus,
            directory: captureSeekBracketDirectory(captureDirectory, -1),
        },
        {
            label: "+1 frame",
            seekSeconds: plan.plus,
            directory: captureSeekBracketDirectory(captureDirectory, 1),
        },
    ];
    const measured: Array<{
        label: string;
        seekSeconds: number;
        directory: string;
        madVsExact: number;
        maxDiff: number;
    }> = [];
    for (const bracket of brackets) {
        await runInstrumentedCapture(idOrSource, {
            seekSeconds: bracket.seekSeconds,
            outputDirectory: bracket.directory,
        });
        const delta = compareImages(
            join(bracket.directory, "screenshot.png"),
            join(captureDirectory, "screenshot.png"),
        );
        measured.push({
            ...bracket,
            madVsExact: delta.mad,
            maxDiff: delta.maxDiff,
        });
    }
    const reportPath = join(captureDirectory, "seek-bracket.json");
    writeReport(
        reportPath,
        { tool: "seek-bracket" },
        {
            scene: scene.id,
            seekSeconds: plan.seekSeconds,
            frameRate,
            frameStep: plan.frameStep,
            brackets: measured,
        },
    );
    const mads = measured.map((entry) => entry.madVsExact);
    console.log("");
    console.log(
        `Seek bracket: ${scene.id} at ${plan.seekSeconds}s, one frame = ` +
            `${plan.frameStep.toFixed(6)}s (${frameRate} fps)`,
    );
    for (const entry of measured) {
        console.log(
            `  ${entry.label} (${entry.seekSeconds.toFixed(6)}s): ` +
                `MAD vs exact ${entry.madVsExact.toFixed(3)}, max ${entry.maxDiff} — ${entry.directory}`,
        );
    }
    console.log(
        `One frame of motion moves this scene by MAD ` +
            `${Math.min(...mads).toFixed(3)}-${Math.max(...mads).toFixed(3)}; ` +
            "judge a residual against that scale (docs/debugging.md#the-ladder).",
    );
    console.log(`Report: ${reportPath}`);
}

/**
 * `scene -- probe <id>`: the single-shader-arm probe.
 *
 * The build deploys every generated shader beside the executable in
 * `<build>/shaders/`, and the Dawn backend compiles the deployed
 * `.native.wgsl` at startup — so one term of one arm can be neutralized
 * there and measured with no rebuild. The command renders the native
 * frame twice through the existing capture entry point: once against the
 * deployed payload as built, once with the named term substituted (or
 * the whole file replaced), and prints both `scene -- measure`
 * measurements plus the MAD between the two frames — the neutralized
 * term's exact contribution at this pose. The deployed directory is
 * copied aside before the edit and restored afterward, unconditionally:
 * the probe is an ephemeral measurement, and what it finds flows back
 * into generation, never into a hand-edited shader.
 *
 * Dawn-only by construction: SDL_GPU consumes the target-selected offline
 * artifact beside the WGSL, which only `src/compile-shaders.ts` refreshes,
 * so an SDL_GPU run would measure the unedited compiled artifacts.
 */
async function runProbe(
    idOrSource: string,
    parsed: ParsedFlags,
): Promise<void> {
    const scene = resolveScene(idOrSource);
    const shader = parsed.values.get("--shader");
    if (shader === undefined) {
        throw new Error(
            "probe: --shader names the deployed shader to probe " +
                "(a *.native.wgsl file in the scene's build shaders directory, " +
                "with or without the suffix).",
        );
    }
    const term = parsed.values.get("--term");
    const replacement = parsed.values.get("--with");
    const replaceFile = parsed.values.get("--replace-file");
    if ((term === undefined) === (replaceFile === undefined)) {
        throw new Error(
            "probe: pass exactly one of --term <text> --with <replacement> " +
                "(literal substitution inside the shader) or --replace-file <path> " +
                "(the whole file's content).",
        );
    }
    if (term !== undefined && replacement === undefined) {
        throw new Error(
            "probe: --term requires --with <replacement>; there is no " +
                "safe default neutralization, and a guessed one measures a " +
                "different experiment than the one named.",
        );
    }
    if (term === undefined && replacement !== undefined) {
        throw new Error("probe: --with rides --term.");
    }
    const seek = flagNumber(parsed, "--seek", "probe");

    const executable = resolveNativeExecutable(undefined, scene.buildDirectory);
    const deployedDirectory = join(dirname(executable), "shaders");
    if (!existsSync(deployedDirectory)) {
        throw new Error(
            `No deployed shaders at ${deployedDirectory}. Run 'scene -- process ${scene.id}' first.`,
        );
    }
    // Resolve the shader, accepting the base name or the file name; a miss
    // names the deployed set, because the probe's first failure mode is a
    // guessed spelling.
    const deployedShaders = readdirSync(deployedDirectory).filter((name) =>
        name.endsWith(".native.wgsl"),
    );
    const fileName = deployedShaders.includes(shader)
        ? shader
        : deployedShaders.includes(`${shader}.native.wgsl`)
          ? `${shader}.native.wgsl`
          : undefined;
    if (fileName === undefined) {
        throw new Error(
            `probe: no deployed shader '${shader}' in ${deployedDirectory}. ` +
                `Deployed: ${deployedShaders
                    .map((name) => name.replace(/\.native\.wgsl$/, ""))
                    .join(", ")}.`,
        );
    }
    const shaderPath = join(deployedDirectory, fileName);
    // The edit, computed before any capture is spent on it: a term that
    // appears nowhere is a mistyped experiment, not a measurement.
    const original = readFileSync(shaderPath, "utf8");
    let edited: string;
    let occurrences: number | undefined;
    if (term !== undefined) {
        occurrences = original.split(term).length - 1;
        if (occurrences === 0) {
            throw new Error(`probe: '${term}' appears nowhere in ${fileName}.`);
        }
        edited = original.split(term).join(replacement);
    } else {
        const source = resolve(replaceFile!);
        if (!existsSync(source)) {
            throw new Error(`probe: no replacement file at ${source}.`);
        }
        edited = readFileSync(source, "utf8");
    }
    const backupDirectory = `${deployedDirectory}.probe-backup`;
    if (existsSync(backupDirectory)) {
        throw new Error(
            `probe: ${backupDirectory} already exists — a previous probe ` +
                `did not restore. Inspect it, move it back over ${deployedDirectory} ` +
                "(or delete it if the deployed directory is intact), then retry.",
        );
    }
    const probeDirectory = resolve(
        defaultCaptureDirectory(scene.id),
        "probe-variants",
    );
    const experiment =
        term !== undefined
            ? `'${term}' -> '${replacement}' (${occurrences} occurrence(s))`
            : `whole file from ${resolve(replaceFile!)}`;
    console.log(
        `Probe: ${scene.id} / ${fileName} — ${experiment}, backend dawn`,
    );
    // The before run measures the deployed payload as built — and, running
    // without the shader-dir override, still refuses a payload that is
    // stale against the generated tree, which anchors that the probe
    // starts from a clean deployment.
    const before = runNativeCapture(idOrSource, {
        backend: "dawn",
        executable,
        ...(seek !== undefined ? { seekSeconds: seek } : {}),
        outputDirectory: join(probeDirectory, "before"),
    });
    // Copy the deployed directory aside, neutralize in place, and restore
    // unconditionally — the manual recipe's exact shape.
    cpSync(deployedDirectory, backupDirectory, { recursive: true });
    let after: NativeCaptureResult;
    try {
        writeFileSync(shaderPath, edited);
        // The deliberate edit would (rightly) fail the deployed-payload
        // staleness check. Naming the deployed directory as the explicit
        // shader dir routes the runtime to the same files while telling
        // that check this run's shader payload is chosen on purpose; the
        // executable's build-stamp identity check still runs.
        after = await withEnvironment(
            "BBLITE_GPU_SHADER_DIR",
            resolve(deployedDirectory),
            async () =>
                runNativeCapture(idOrSource, {
                    backend: "dawn",
                    executable,
                    ...(seek !== undefined ? { seekSeconds: seek } : {}),
                    outputDirectory: join(probeDirectory, "after"),
                }),
        );
    } finally {
        rmSync(deployedDirectory, { recursive: true, force: true });
        renameSync(backupDirectory, deployedDirectory);
        console.log(`Deployed shaders restored: ${deployedDirectory}`);
    }
    const beforeMeasurement = measurePng(before.screenshotPath);
    const afterMeasurement = measurePng(after.screenshotPath);
    const delta = compareImages(after.screenshotPath, before.screenshotPath);
    // The golden holds the registry pose. A probe seeked anywhere else
    // would print golden MADs comparing two different poses, so those
    // columns are suppressed and say why.
    const pose = resolvePose(scene, seek);
    const goldenPath = scene.parity
        ? resolve(scene.parity.reference.path)
        : undefined;
    const golden =
        pose.golden && goldenPath !== undefined && existsSync(goldenPath)
            ? {
                  path: goldenPath,
                  before: compareImages(before.screenshotPath, goldenPath),
                  after: compareImages(after.screenshotPath, goldenPath),
              }
            : undefined;
    console.log("");
    console.log("Before (deployed payload as built):");
    console.log(formatPngMeasurement(before.screenshotPath, beforeMeasurement));
    console.log("");
    console.log("After (term neutralized):");
    console.log(formatPngMeasurement(after.screenshotPath, afterMeasurement));
    console.log("");
    console.log(
        `After vs before: MAD ${delta.mad.toFixed(3)}, max ${delta.maxDiff} — ` +
            "the neutralized term's exact contribution at this pose.",
    );
    if (golden) {
        console.log(
            `Against the golden (${scene.parity!.reference.path}): ` +
                `before MAD ${golden.before.mad.toFixed(3)}, ` +
                `after MAD ${golden.after.mad.toFixed(3)} — ` +
                "a residual the neutralization removes belongs to this arm.",
        );
    } else if (!pose.golden) {
        console.log(
            `Seeked pose (--seek ${seek}): golden columns suppressed — ` +
                "the golden holds the registry pose, so a cross-pose " +
                "comparison measures nothing. The after-vs-before MAD above " +
                "is the probe's answer at this pose.",
        );
    }
    const reportPath = join(probeDirectory, "probe-variants.json");
    writeReport(
        reportPath,
        {
            tool: "probe-variants",
            backend: "dawn",
            generatedDirectory: resolve(scene.output),
        },
        {
            scene: scene.id,
            shader: fileName,
            mode: term !== undefined ? "term" : "replace-file",
            ...(term !== undefined
                ? { term, replacement, occurrences }
                : { replaceFile: resolve(replaceFile!) }),
            seekSeconds: pose.seekSeconds ?? null,
            before: {
                screenshot: before.screenshotPath,
                measurement: beforeMeasurement,
            },
            after: {
                screenshot: after.screenshotPath,
                measurement: afterMeasurement,
            },
            afterVsBefore: { mad: delta.mad, maxDiff: delta.maxDiff },
            ...(pose.golden
                ? {}
                : { goldenSuppressed: "seeked pose - not comparable" }),
            ...(golden
                ? {
                      golden: {
                          path: golden.path,
                          before: {
                              mad: golden.before.mad,
                              maxDiff: golden.before.maxDiff,
                          },
                          after: {
                              mad: golden.after.mad,
                              maxDiff: golden.after.maxDiff,
                          },
                      },
                  }
                : {}),
        },
    );
    console.log(`Report: ${reportPath}`);
}

/**
 * `scene -- neutrality <baseline.txt> --generated [--write]`: the
 * compile-and-digest half of the neutrality proof. Digests every
 * registry-owned file under `generated/` (sha1, `generated/<path>\t<hash>`
 * lines) and writes or compares the baseline file. It never compiles —
 * run `scene -- compile all` before each invocation, or the digest
 * describes whatever tree the last compile left. Stray top-level
 * directories no registry scene owns are listed loudly and excluded,
 * because hashing a corpus-sweep leftover silently is how two identical
 * compiles digest differently.
 */
function runGeneratedNeutrality(baselinePath: string, write: boolean): boolean {
    const { lines, strays } = digestGeneratedTree(
        "generated",
        scenes.map((scene) => scene.output),
    );
    if (strays.length > 0) {
        console.warn(
            `generated/ contains ${strays.length} top-level entr${
                strays.length === 1 ? "y" : "ies"
            } no registry scene owns — excluded from the digest ` +
                "(a corpus sweep or a deleted probe leaves these; remove them):",
        );
        for (const stray of strays) console.warn(`  generated/${stray}`);
    }
    if (lines.length === 0) {
        throw new Error(
            "Nothing to digest under generated/. This command digests, it does not compile — " +
                "run 'npm run scene -- compile all' first.",
        );
    }
    if (write) {
        writeFileSync(baselinePath, `${lines.join("\n")}\n`);
        console.log(
            `Baseline written: ${lines.length} file(s) -> ${baselinePath}`,
        );
        return true;
    }
    if (!existsSync(baselinePath)) {
        throw new Error(
            `No baseline at ${baselinePath}. Write one before the change with ` +
                `'scene -- neutrality ${baselinePath} --generated --write' (compile first — this command only digests).`,
        );
    }
    const comparison = compareGeneratedDigest(
        parseDigestBaseline(readFileSync(baselinePath, "utf8")),
        lines,
    );
    const list = (label: string, paths: string[]): void => {
        if (paths.length === 0) return;
        console.log(`\n${label} (${paths.length}):`);
        const cap = 50;
        for (const path of paths.slice(0, cap)) console.log(`  ${path}`);
        if (paths.length > cap) {
            console.log(`  ... ${paths.length - cap} more`);
        }
    };
    const moved =
        comparison.added.length +
        comparison.removed.length +
        comparison.changed.length;
    console.log(
        `${comparison.unchanged} file(s) byte-identical to the baseline, ` +
            `${comparison.changed.length} changed, ${comparison.added.length} added, ` +
            `${comparison.removed.length} removed.`,
    );
    if (moved === 0) {
        console.log(
            "\nNeutral: the generated tree digests identically, so the build stamps, " +
                "binaries and measurements cannot have moved.",
        );
        return true;
    }
    list("Changed", comparison.changed);
    list("Added", comparison.added);
    list("Removed", comparison.removed);
    console.log(
        "\nA change meant to be generation-neutral moved the generated tree. " +
            "Confirm both digests followed a full 'scene -- compile all' — " +
            "but if it moves again, it is not neutral.",
    );
    return false;
}

/**
 * `scene -- validate <id|all>`: the validation bundle. Chains the
 * existing stages — compile, shaders, build, parity, the published-table
 * check — with one summary line per stage, stopping at the first failure
 * (later stages would measure the stale result of the failed one) and
 * preserving every artifact the completed stages wrote. The parity stage
 * measures every compiled backend (`measuredBackends`), both by default.
 */
async function runValidate(idOrSource: string): Promise<void> {
    // Resolve the selection (and the backend story) before any stage
    // spends time on an id that cannot mean anything.
    const scene = idOrSource === "all" ? undefined : resolveScene(idOrSource);
    requireDevelopmentPreflight({
        browser: true,
        labSound: idOrSource === "all",
        rmlUi: idOrSource === "all",
        shaders: true,
    });
    const selectedScenes = scene ? [scene] : scenes;
    const stages: Stage[] = [
        // Generation keeps its own per-scene records and `compile` skips a
        // current scene itself, so the stage carries no checkpoint.
        { name: "compile", body: () => compile(idOrSource) },
        shaderStage(selectedScenes),
        {
            name: "build",
            body: () => buildScenes(scene ? [scene] : scenes),
        },
        {
            name: `parity (${measuredBackends(undefined, "validate").join(", ")})`,
            body: () =>
                parity(
                    idOrSource,
                    parityArgumentsFrom(parseFlags([], PARITY_FLAGS, "parity")),
                    [],
                ),
        },
        {
            name: "verify-status",
            body: async () => {
                const { problems } = verifyStatus();
                // A single-scene validate answers for that scene's row;
                // other rows may be legitimately unmeasured on this
                // checkout. Both spellings the checker uses: the id
                // followed by a column name, and by a colon ("no parity
                // report").
                const relevant = scene
                    ? problems.filter(
                          (problem) =>
                              problem.includes(` ${scene.id} `) ||
                              problem.includes(` ${scene.id}:`),
                      )
                    : problems;
                if (relevant.length > 0) {
                    for (const problem of relevant) {
                        console.error(problem);
                    }
                    throw new Error(
                        `${relevant.length} published value(s) disagree with the measured reports.`,
                    );
                }
            },
        },
    ];
    const failures: string[] = [];
    for (const stage of stages) {
        if (failures.length > 0) {
            console.log(
                `validate: ${stage.name} skipped (an earlier stage failed).`,
            );
            continue;
        }
        const started = Date.now();
        const seconds = (): string =>
            ((Date.now() - started) / 1000).toFixed(1);
        try {
            await stage.body();
            console.log(`validate: ${stage.name} ok (${seconds()}s).`);
        } catch (error) {
            failures.push(stage.name);
            console.error(
                `validate: ${stage.name} FAILED (${seconds()}s): ${
                    (error as Error).message
                }`,
            );
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `validate: ${failures.join(", ")} failed; later stages skipped. ` +
                "Artifacts from the completed stages are preserved under artifacts/ and generated/ for inspection.",
        );
    }
    console.log(
        `validate: all ${stages.length} stages passed for ${idOrSource}.`,
    );
}

/**
 * `scene -- diagnose <id>`: the diagnosis ladder as one command.
 *
 * `validate` chains the validation stages; this chains the diagnosis
 * steps — the parity gate on every measured backend with the backend
 * differential, the capture pairing (`diff`) and the fragment composition
 * (`diff --compose`) — through the existing entry points, and prints one
 * summary block with each step's verdict in ladder order. A failed step
 * does not stop the later ones: the point of a diagnosis is to see where
 * the ladder breaks, and every step below a failure is more evidence, not
 * less.
 *
 * `--backend` narrows the parity step to one backend and rides into
 * `diff`; `--seek` rides into all three, and parity at a pose the golden
 * does not hold measures against a browser capture at that pose.
 */
async function runDiagnose(
    idOrSource: string,
    parsed: ParsedFlags,
): Promise<boolean> {
    const scene = resolveScene(idOrSource);
    if (!scene.parity) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    const parityDefinition = scene.parity;
    const backendFlag = parsed.values.get("--backend");
    const backend =
        backendFlag === undefined
            ? undefined
            : resolveBackend(backendFlag, "diagnose");
    const seek = flagNumber(parsed, "--seek", "diagnose");
    const pose = resolvePose(scene, seek);
    const backends = measuredBackends(backend, "diagnose");
    const steps: Array<{ name: string; verdict: string; ok: boolean }> = [];
    const heading = (name: string): void => {
        console.log("");
        console.log(`=== diagnose: ${name} ===`);
    };

    // The decisive differential (or a single-backend parity): backend
    // agreement to one LSB puts a divergence on the CPU side.
    const parityName = `parity (${backends.join(", ")})`;
    heading(parityName);
    try {
        await runParityBackends(scene, backends, {
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            attribute: false,
            recaptureReference: false,
            noFail: false,
        });
        steps.push({
            name: parityName,
            verdict: `ok${parityVerdict(
                parityOutputDirectory(
                    { ...scene, parity: parityDefinition },
                    pose,
                ),
                backends,
            )}`,
            ok: true,
        });
    } catch (error) {
        steps.push({
            name: parityName,
            verdict: `FAILED: ${(error as Error).message}`,
            ok: false,
        });
    }

    // The capture pairing, which recaptures stale evidence on its own and
    // reports value/draw/shader findings worst-first.
    heading("diff");
    let diffFindings: string[] | undefined;
    try {
        const result = await runRenderDiff(idOrSource, {
            ...(backend !== undefined ? { backend } : {}),
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            recapture: false,
        });
        diffFindings = result.findings;
        steps.push({
            name: "diff",
            verdict:
                result.findings.length === 0
                    ? "ok — no findings"
                    : `${result.findings.length} finding(s); first: ${result.findings[0]}`,
            ok: result.findings.length === 0,
        });
    } catch (error) {
        steps.push({
            name: "diff",
            verdict: `FAILED: ${(error as Error).message}`,
            ok: false,
        });
    }

    // The fragment composition against the capture diff just ensured is
    // fresh (same directory, same pose).
    heading("diff --compose");
    try {
        const { runComposeReport } = await import("./scene-compose-report.js");
        const compose = await runComposeReport(
            idOrSource,
            scenes,
            resolveScene,
            {
                ...(seek !== undefined ? { seekSeconds: seek } : {}),
            },
        );
        steps.push({
            name: "diff --compose",
            verdict:
                compose.gaps === 0
                    ? "ok — every material composes to a captured fragment"
                    : `${compose.gaps} GAP(s) — a composed fragment matches no captured one`,
            ok: compose.gaps === 0,
        });
    } catch (error) {
        steps.push({
            name: "diff --compose",
            verdict: `FAILED: ${(error as Error).message}`,
            ok: false,
        });
    }

    console.log("");
    console.log(
        `diagnose: ${scene.id}` +
            (backend !== undefined ? ` (backend ${backend})` : "") +
            (seek !== undefined ? ` (seek ${seek}s)` : ""),
    );
    for (const step of steps) {
        console.log(`  ${step.name}: ${step.verdict}`);
    }
    const ok = steps.every((step) => step.ok);
    if (ok && diffFindings !== undefined) {
        console.log(
            "  every step is clean at this pose; a remaining residual is " +
                "below these instruments (docs/debugging.md#the-ladder).",
        );
    }
    return ok;
}

/** The parity step's numbers for the diagnose summary, from the reports
 *  the step itself just wrote; empty when they cannot be read. */
function parityVerdict(
    outputDirectory: string,
    backends: readonly string[],
): string {
    try {
        if (backends.length === 2) {
            const report = JSON.parse(
                readFileSync(
                    parityReportPath(outputDirectory, "differential"),
                    "utf8",
                ),
            ) as DifferentialReportSummary;
            return (
                ` — golden vs SDL_GPU ${report.goldenVersusSdlGpu.fullMad.toFixed(3)}, ` +
                `vs Dawn ${report.goldenVersusDawn.fullMad.toFixed(3)}, ` +
                `backends vs each other ${report.sdlGpuVersusDawn.mad.toFixed(3)}`
            );
        }
        const report = JSON.parse(
            readFileSync(
                parityReportPath(
                    outputDirectory,
                    backendFileToken(backends[0] ?? "sdl_gpu"),
                ),
                "utf8",
            ),
        ) as ParityReportSummary;
        return ` — full MAD ${report.full.mad.toFixed(3)}, region ${report.region.mad.toFixed(3)}`;
    } catch {
        return "";
    }
}

/** `scene -- capture <id>`: the instrumented browser capture, the native
 *  render capture (`--native`), or the ±1-frame bracket. */
async function runCapture(
    idOrSource: string,
    parsed: ParsedFlags,
): Promise<void> {
    const native = parsed.flags.has("--native");
    const seekBracket = parsed.flags.has("--seek-bracket");
    const seek = flagNumber(parsed, "--seek", "capture");
    const skipDraw = flagNumber(parsed, "--skip-draw", "capture");
    const output = parsed.values.get("--capture");
    if (seekBracket) {
        if (native) {
            throw new Error(
                "capture: --seek-bracket brackets the browser capture; the native pose is what gets judged against the three, so it does not compose with --native.",
            );
        }
        if (skipDraw !== undefined) {
            throw new Error(
                "capture: --seek-bracket does not compose with --skip-draw; a filtered capture cannot serve as the motion baseline.",
            );
        }
    }
    // `--native` asks the same question of our renderer that the browser
    // hooks ask of Babylon Lite's, so the two captures land in one
    // directory and `diff` can pair them.
    if (native) {
        if (skipDraw !== undefined) {
            throw new Error(
                "capture: --skip-draw filters the browser capture and does not compose with --native.",
            );
        }
        const backend = resolveBackend(
            parsed.values.get("--backend"),
            "capture",
        );
        const result = runNativeCapture(idOrSource, {
            backend,
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            ...(output !== undefined ? { outputDirectory: output } : {}),
        });
        console.log(
            `Native ${result.backend} capture written to ${result.capturePath}`,
        );
        return;
    }
    for (const [flag, present] of [
        ["--backend", parsed.values.has("--backend")],
        ["--gpu-debug", parsed.flags.has("--gpu-debug")],
    ] as const) {
        if (present) {
            throw new Error(
                `capture: ${flag} selects the native renderer and needs --native beside it.`,
            );
        }
    }
    if (seekBracket) {
        await runSeekBracketCapture(idOrSource, seek, output);
        return;
    }
    const { runInstrumentedCapture } =
        await import("./capture-instrumented.js");
    await runInstrumentedCapture(idOrSource, {
        ...(seek !== undefined ? { seekSeconds: seek } : {}),
        ...(skipDraw !== undefined ? { skipDrawIndexCount: skipDraw } : {}),
        ...(output !== undefined ? { outputDirectory: output } : {}),
    });
}

/**
 * `scene -- survey <entry.ts>`: how far an external entry is from
 * compiling, before any work on it. Two readings into
 * `artifacts/survey/<directory>-<stem>/`: the compile census (`census.json`:
 * every refusal the lowering reaches, with its site, message and cascades,
 * from `bblitec --survey`; no tree is written) and the API readiness
 * (`api/report.html`: the pinned declarations the entry references, credited
 * by the collected evidence). The census exits nonzero when the survey ran
 * incomplete; the readiness report still follows.
 */
async function runSurvey(entry: string): Promise<boolean> {
    const entryPath = resolve(entry);
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
        throw new Error(`survey: no TypeScript entry at ${entryPath}.`);
    }
    const directory = resolve(
        artifactDirectory(
            "survey",
            `${basename(dirname(entryPath))}-${parse(entryPath).name}`,
        ),
    );
    mkdirSync(directory, { recursive: true });
    const census = join(directory, "census.json");
    let completed = true;
    try {
        run(process.execPath, [
            resolve("dist/src/cli.js"),
            entryPath,
            "--survey",
            census,
        ]);
    } catch (error) {
        completed = false;
        console.error(`survey: census incomplete: ${(error as Error).message}`);
    }
    const { writeProjectApiReport } = await import("./api-command.js");
    await writeProjectApiReport(entryPath, join(directory, "api"));
    console.log(`Survey: ${directory}`);
    return completed;
}

/**
 * `scene -- clean`: disk hygiene over what this checkout owns.
 *
 * `--orphans` deletes the build trees under `native/` and the top-level
 * entries under `generated/` that no registry entry owns — a corpus
 * sweep or a deregistered scene leaves trees nothing will ever build
 * again, the shader sweep still processes the generated strays, and
 * `neutrality --generated` has to list them loudly on every digest. The
 * ownership rule is the registry's, extended by the trees the registry
 * implies: a scene's `buildDirectory` and `output`; its check twin
 * (`generated/<id>-live`, `native/build-<id>-live-release`); and its
 * shipping trees (`native/build-<id>-min-sdl|-min-dawn`, the packaging
 * input `docs/development.md` names). `--all` additionally removes the
 * OWNED build trees (a full native rebuild); owned `generated/`
 * directories are never touched — they are compiler output, not build
 * state.
 *
 * `--report` lists what the deletions would touch and the duplicated
 * payloads no deletion targets by default: every build tree of this
 * checkout and of every linked worktree, the precompiled headers and the
 * DLL copies inside the owned trees, and the `artifacts/` entries no
 * tool owns (`ARTIFACT_ROOTS`). `--pch` and `--dlls` delete those duplicated payloads in
 * this checkout's `native/build-*` (the next build restores them; an
 * executable without its DLLs does not start until then); `--artifacts`
 * deletes the unowned `artifacts/` entries. Nothing outside
 * `native/build-*`, `generated/` and `artifacts/` is ever deleted, and a
 * junction or symbolic link is never followed nor removed.
 */
interface CleanOptions {
    orphans: boolean;
    all: boolean;
    report: boolean;
    dlls: boolean;
    pch: boolean;
    artifacts: boolean;
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/** Bytes under a directory, never following links; a file that vanished
 *  mid-walk counts nothing. */
function directorySize(path: string): number {
    let total = 0;
    for (const file of listFiles(path, { skipUnreadable: true })) {
        try {
            total += statSync(file).size;
        } catch {
            // Deleted by another process between the walk and the stat.
        }
    }
    return total;
}

/** Files under a directory whose name matches `test`, never following links. */
function findFiles(path: string, test: (name: string) => boolean): string[] {
    return listFiles(path, { skipUnreadable: true }).filter((file) =>
        test(basename(file)),
    );
}

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;

function buildTreesUnder(nativeRoot: string): string[] {
    if (!existsSync(nativeRoot)) return [];
    return readdirSync(nativeRoot, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                !entry.isSymbolicLink() &&
                entry.name.startsWith("build-"),
        )
        .map((entry) => resolve(nativeRoot, entry.name));
}

/** The native roots of every linked worktree, this checkout excluded. */
function worktreeNativeRoots(): string[] {
    const here = resolve(".");
    const roots: string[] = [];
    try {
        const listing = spawnSync("git", ["worktree", "list", "--porcelain"], {
            encoding: "utf8",
        });
        if (listing.status === 0) {
            for (const line of listing.stdout.split(/\r?\n/)) {
                if (!line.startsWith("worktree ")) continue;
                const path = resolve(line.slice("worktree ".length));
                if (path !== here) roots.push(resolve(path, "native"));
            }
        }
    } catch {
        // No git: only the .claude worktrees below are visible.
    }
    const claudeWorktrees = resolve(".claude", "worktrees");
    if (existsSync(claudeWorktrees)) {
        for (const entry of readdirSync(claudeWorktrees, {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory()) continue;
            const root = resolve(claudeWorktrees, entry.name, "native");
            if (!roots.includes(root)) roots.push(root);
        }
    }
    return roots.filter((root) => existsSync(root));
}

const isPchFile = (name: string): boolean => /^cmake_pch\..*\.pch$/.test(name);
const isDllFile = (name: string): boolean =>
    name.toLowerCase().endsWith(".dll");

function runClean(options: CleanOptions): void {
    if (
        !options.orphans &&
        !options.all &&
        !options.report &&
        !options.dlls &&
        !options.pch &&
        !options.artifacts
    ) {
        throw new Error(
            "clean: pass --report (list sizes, delete nothing), --orphans (delete build trees and generated/ entries " +
                "no registry entry owns), --all (also delete every owned build tree; owned generated/ directories always stay), " +
                "--pch / --dlls (delete the precompiled headers / DLL copies inside native/build-*; the next build restores them), " +
                "and/or --artifacts (delete the artifacts/ entries no tool owns).",
        );
    }
    let removed = 0;
    let removedBytes = 0;
    const removeTree = (path: string, label: string): void => {
        if (isLink(path)) {
            console.log(`clean: leaving ${label} ${path} (a link)`);
            return;
        }
        console.log(`clean: removing ${label} ${path}`);
        rmSync(path, { recursive: true, force: true });
        removed += 1;
    };
    const nativeRoot = resolve("native");
    const ownedBuilds = new Set(
        scenes.map((scene) => resolve(scene.buildDirectory)),
    );
    for (const scene of scenes) {
        for (const suffix of [
            "live-release",
            "attribution-release",
            "min-sdl",
            "min-dawn",
        ]) {
            ownedBuilds.add(resolve(nativeRoot, `build-${scene.id}-${suffix}`));
        }
    }
    for (const directory of [...ownedBuilds]) {
        for (const backend of NATIVE_BACKENDS) {
            ownedBuilds.add(
                compiledBuildDirectory(directory, compiledBackend(backend)),
            );
        }
    }
    const generatedRoot = resolve("generated");
    const ownedGenerated = new Set(
        scenes.map((scene) => resolve(scene.output)),
    );
    for (const scene of scenes)
        ownedGenerated.add(resolve(generatedRoot, `${scene.id}-live`));
    for (const scene of scenes)
        ownedGenerated.add(resolve(generatedRoot, `${scene.id}-attribution`));
    const artifactsRoot = resolve("artifacts");
    const unownedArtifacts = existsSync(artifactsRoot)
        ? readdirSync(artifactsRoot, { withFileTypes: true })
              .filter(
                  (entry) =>
                      !isOwnedArtifact(entry.name) && !entry.isSymbolicLink(),
              )
              .map((entry) => resolve(artifactsRoot, entry.name))
        : [];

    if (options.report) {
        const trees = buildTreesUnder(nativeRoot);
        let owned = 0;
        let orphan = 0;
        let pchBytes = 0;
        let pchFiles = 0;
        let dllBytes = 0;
        let dllFiles = 0;
        for (const tree of trees) {
            const size = directorySize(tree);
            if (ownedBuilds.has(tree)) owned += size;
            else orphan += size;
            for (const file of findFiles(tree, isPchFile)) {
                pchFiles += 1;
                pchBytes += statSync(file).size;
            }
            for (const file of findFiles(tree, isDllFile)) {
                dllFiles += 1;
                dllBytes += statSync(file).size;
            }
        }
        console.log(`clean --report (${resolve(".")})`);
        console.log(
            `  native/build-*: ${trees.length} tree(s), ${gigabytes(owned + orphan)} ` +
                `(owned ${gigabytes(owned)}, orphan ${gigabytes(orphan)} in ${trees.filter((tree) => !ownedBuilds.has(tree)).length})`,
        );
        console.log(
            `    precompiled headers: ${pchFiles} file(s), ${gigabytes(pchBytes)} (--pch)`,
        );
        console.log(
            `    DLL copies: ${dllFiles} file(s), ${gigabytes(dllBytes)} (--dlls)`,
        );
        for (const tree of trees.filter((tree) => !ownedBuilds.has(tree))) {
            console.log(
                `    orphan: ${tree} (${gigabytes(directorySize(tree))})`,
            );
        }
        const strays = existsSync(generatedRoot)
            ? readdirSync(generatedRoot, { withFileTypes: true })
                  .map((entry) => resolve(generatedRoot, entry.name))
                  .filter((path) => !ownedGenerated.has(path))
            : [];
        console.log(
            `  generated/: ${strays.length} stray entr${strays.length === 1 ? "y" : "ies"} (--orphans)`,
        );
        for (const stray of strays)
            console.log(
                `    stray: ${stray} (${gigabytes(directorySize(stray))})`,
            );
        for (const root of worktreeNativeRoots()) {
            const worktreeTrees = buildTreesUnder(root);
            const size = worktreeTrees.reduce(
                (total, tree) => total + directorySize(tree),
                0,
            );
            console.log(
                `  worktree ${root}: ${worktreeTrees.length} build tree(s), ${gigabytes(size)} (not touched by clean; run clean there)`,
            );
        }
        console.log(
            `  artifacts/: ${unownedArtifacts.length} unowned entr${unownedArtifacts.length === 1 ? "y" : "ies"} (--artifacts)`,
        );
        for (const entry of unownedArtifacts) {
            console.log(
                `    unowned: ${entry} (${gigabytes(directorySize(entry))})`,
            );
        }
    }
    if (options.orphans || options.all) {
        for (const tree of buildTreesUnder(nativeRoot)) {
            if (ownedBuilds.has(tree)) {
                if (options.all) removeTree(tree, "owned build tree");
                continue;
            }
            if (options.orphans) removeTree(tree, "orphan build tree");
        }
        if (options.orphans && existsSync(generatedRoot)) {
            for (const entry of readdirSync(generatedRoot, {
                withFileTypes: true,
            })) {
                const path = resolve(generatedRoot, entry.name);
                if (entry.isDirectory() && ownedGenerated.has(path)) continue;
                removeTree(path, "stray generated entry");
            }
        }
    }
    if (options.pch || options.dlls) {
        for (const tree of buildTreesUnder(nativeRoot)) {
            const files = [
                ...(options.pch ? findFiles(tree, isPchFile) : []),
                ...(options.dlls ? findFiles(tree, isDllFile) : []),
            ];
            for (const file of files) {
                removedBytes += statSync(file).size;
                rmSync(file, { force: true });
                removed += 1;
            }
        }
        if (removedBytes > 0) {
            console.log(
                `clean: removed ${gigabytes(removedBytes)} of precompiled headers and DLL copies; the next 'scene -- build' restores them.`,
            );
        }
    }
    if (options.artifacts) {
        for (const entry of unownedArtifacts)
            removeTree(entry, "unowned artifacts entry");
    }
    console.log(
        removed === 0
            ? "clean: nothing removed."
            : `clean: removed ${removed} entr${removed === 1 ? "y" : "ies"}.`,
    );
}

/**
 * `scene -- show <id> [--activation|--adaptations|--provenance]`: the
 * registry entry, or one of the records generation writes beside the
 * tree — which features are on and why, which adaptations the tree
 * carries and at what risk, which pinned symbols were lowered.
 */
function runShow(idOrSource: string, parsed: ParsedFlags): void {
    const scene = resolveScene(idOrSource);
    const views = ["--activation", "--adaptations", "--provenance"].filter(
        (flag) => parsed.flags.has(flag),
    );
    if (views.length === 0) {
        console.log(JSON.stringify(scene, null, 2));
        return;
    }
    for (const view of views) {
        if (view === "--activation") {
            console.log(
                formatFeatureActivation(
                    readFeatureActivation(scene.output, scene.id),
                ),
            );
        } else if (view === "--adaptations") {
            console.log(
                formatAdaptations(readAdaptations(scene.output, scene.id)),
            );
        } else {
            console.log(
                formatProvenance(readProvenance(scene.output, scene.id)),
            );
        }
    }
}

/**
 * `scene -- status <id> [--run]`: is the generated tree current for the
 * registry entry, is the payload beside the executable the tree's, and
 * does the binary carry the tree's build stamp — read from the binary's
 * bytes, so no window opens; `--run` renders one frame under the
 * measured-run identity gate as well.
 */
function runStatus(idOrSource: string, run: boolean): boolean {
    const scene = resolveScene(idOrSource);
    const executable = resolveNativeExecutable(undefined, scene.buildDirectory);
    const status = readSceneStatus(
        scene.output,
        compiledBuildDirectory(scene.buildDirectory),
        executable,
        generationIsCurrent(scene, compilerArguments(scene)),
    );
    console.log(formatSceneStatus(scene.id, status));
    if (run && status.executableExists) {
        const screenshot = resolve(
            artifactDirectory("status", `${scene.id}.png`),
        );
        runMeasured(executable, {
            generatedDirectory: scene.output,
            ...(scene.parity?.nativeEnvironment !== undefined
                ? { environment: scene.parity.nativeEnvironment }
                : {}),
            frame: 0,
            screenshot,
        });
        console.log(
            `  one-frame run under the identity gate: ok (${screenshot})`,
        );
    }
    return status.current;
}

/**
 * `scene -- check <check-id>`: the declared interaction check, against
 * the scene's own tree or — for a check declaring `twin: true` — the
 * byte-identical no-query twin this command generates and builds first;
 * with `--observe`, the check's browser observation instead.
 */
async function runDeclaredCheck(
    checkId: string,
    parsed: ParsedFlags,
): Promise<boolean> {
    if (parsed.flags.has("--observe")) {
        const native = ["--backend", "--phase", "--keep"].filter(
            (flag) => parsed.values.has(flag) || parsed.flags.has(flag),
        );
        if (native.length > 0) {
            throw new Error(
                `check: ${native.join(", ")} selects native phases and does not compose with --observe.`,
            );
        }
        await runDeclaredObserve(checkId, parsed);
        return true;
    }
    if (parsed.flags.has("--headed")) {
        throw new Error("check: --headed shows the browser of --observe.");
    }
    const spec = readCheckSpec(checkId);
    const scene = resolveScene(spec.scene);
    const tree = spec.twin ? twinScene(scene) : scene;
    if (spec.twin) await processTwin(tree);
    const phase = parsed.values.get("--phase");
    const verdict = await runCheck({
        checkId,
        scene,
        spec,
        target: {
            output: tree.output,
            buildDirectory: compiledBuildDirectory(tree.buildDirectory),
            executable: resolveNativeExecutable(undefined, tree.buildDirectory),
        },
        backends: measuredBackends(parsed.values.get("--backend"), "check"),
        ...(phase !== undefined ? { phase } : {}),
        keep: parsed.flags.has("--keep"),
    });
    return verdict.ok;
}

async function runDeclaredObserve(
    checkId: string,
    parsed: ParsedFlags,
): Promise<void> {
    const spec = readCheckSpec(checkId);
    if (spec.observe === undefined) {
        throw new Error(
            `check ${checkId} declares no browser observation ('observe').`,
        );
    }
    await runObserve({
        checkId,
        scene: resolveScene(spec.scene),
        spec: spec.observe,
        noQueryTwin: spec.twin === true,
        headed: parsed.flags.has("--headed"),
    });
}

/** One dispatcher command: its bare argument, flags, one-line summary,
 *  and whether it runs out of `dist/` long enough to hold the lock. */
interface CommandSpec {
    name: string;
    argument?: string;
    flags: FlagSpec;
    summary: string;
    lock: boolean;
}

const SCENE_ARGUMENT = "<id|source.ts>";
const SCENE_OR_ALL_ARGUMENT = "<id|source.ts|all>";

const COMMANDS: readonly CommandSpec[] = [
    { name: "help", flags: {}, summary: "print this usage", lock: false },
    {
        name: "doctor",
        flags: {},
        summary: "toolchain preflight report",
        lock: true,
    },
    {
        name: "setup",
        flags: {},
        summary:
            "install the vcpkg manifest and build the pinned Dawn, Tint, LabSound and RmlUi",
        lock: true,
    },
    {
        name: "list",
        flags: { boolean: ["--json"] },
        summary:
            "id, name, source and build directory of every registered scene",
        lock: false,
    },
    {
        name: "show",
        argument: SCENE_ARGUMENT,
        flags: { boolean: ["--activation", "--adaptations", "--provenance"] },
        summary:
            "the registry entry; --activation (active features and why), --adaptations (by risk), --provenance (lowered pinned symbols) read the generated tree",
        lock: false,
    },
    {
        name: "status",
        argument: SCENE_ARGUMENT,
        flags: { boolean: ["--run"] },
        summary:
            "generation record current, payload deployed, binary carries the tree's stamp (from its bytes); --run renders one frame under the identity gate",
        lock: false,
    },
    {
        name: "compile",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: { boolean: ["--cold"] },
        summary: "generate C++, WGSL, assets and manifests",
        lock: true,
    },
    {
        name: "build",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: { value: ["--backend", "--compiler"], boolean: ["--cold"] },
        summary:
            "configure, build and deploy the generated tree (--backend sdl_gpu|dawn|both, --compiler auto|clangcl|msvc)",
        lock: true,
    },
    {
        name: "process",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: {
            value: ["--backend", "--compiler", "--shader"],
            boolean: ["--cold"],
        },
        summary:
            "compile, compile shaders (--shader d3d12|vulkan|metal|all) and build",
        lock: true,
    },
    {
        name: "validate",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: { boolean: ["--cold"] },
        summary:
            "compile, shaders, build, parity on every compiled backend and the published-status check",
        lock: true,
    },
    {
        name: "clean",
        flags: {
            boolean: [
                "--report",
                "--orphans",
                "--all",
                "--pch",
                "--dlls",
                "--artifacts",
            ],
        },
        summary:
            "disk hygiene: --report sizes; --orphans unowned trees; --all owned build trees; --pch/--dlls duplicated payloads; --artifacts unowned artifacts/ entries",
        lock: true,
    },
    {
        name: "parity",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: PARITY_FLAGS,
        summary:
            "golden vs native MAD gate on both backends (--backend one) plus their differential; --seek measures another pose against its own browser capture; --runs N re-renders N times (--single-sample at one sample); --geometry the impostor copy tasks; --attribute the draw-id twin",
        lock: true,
    },
    {
        name: "memory",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: MEMORY_FLAGS,
        summary:
            "working-set trend, retired mesh/geometry records and GC nodes after warm-up under the demo's gameplay tape (all = the application demos; --replay - idles)",
        lock: true,
    },
    {
        name: "capture",
        argument: SCENE_ARGUMENT,
        flags: {
            value: [...MEASURE_FLAGS.value, "--skip-draw", "--capture"],
            boolean: [...MEASURE_FLAGS.boolean, "--native", "--seek-bracket"],
            alias: { "--out": "--capture" },
        },
        summary:
            "instrumented browser capture (--native: the native render capture; --seek-bracket: +-1 frame)",
        lock: true,
    },
    {
        name: "diff",
        argument: SCENE_OR_ALL_ARGUMENT,
        flags: {
            value: [...MEASURE_FLAGS.value, "--capture", "--size", "--module"],
            boolean: [
                ...MEASURE_FLAGS.boolean,
                "--recapture",
                "--uniforms",
                "--compose",
            ],
        },
        summary:
            "pair the browser and native captures: values, draws, shaders, palettes; --uniforms decodes browser uniform buffers (--size N, --module text); --compose composes every glTF material through the pin (all accepted)",
        lock: true,
    },
    {
        name: "diagnose",
        argument: SCENE_ARGUMENT,
        flags: MEASURE_FLAGS,
        summary: "parity, diff and diff --compose in one run",
        lock: true,
    },
    {
        name: "check",
        argument: "<check-id>",
        flags: {
            value: ["--backend", "--phase"],
            boolean: ["--keep", "--observe", "--headed"],
        },
        summary:
            "the declared interaction check (checks/<check-id>.json) on both backends; --keep reuses current phase outputs; --observe runs its browser observation instead (--headed shows it)",
        lock: true,
    },
    {
        name: "measure",
        argument: "<image.png>",
        flags: { value: ["--background"] },
        summary:
            "non-background bounding box, pixel count and channel means of a PNG",
        lock: false,
    },
    {
        name: "probe",
        argument: SCENE_ARGUMENT,
        flags: {
            value: ["--shader", "--term", "--with", "--replace-file", "--seek"],
            boolean: ["--gpu-debug"],
        },
        summary:
            "neutralize one WGSL term (or replace a file) in the deployed Dawn payload and re-render",
        lock: true,
    },
    {
        name: "neutrality",
        argument: "<baseline>",
        flags: { boolean: ["--generated", "--write"] },
        summary:
            "cell-by-cell compare of report-differential.json against a saved parity directory; --generated digests generated/ as it stands (compile first) against a baseline file, --write saves it",
        lock: true,
    },
    {
        name: "survey",
        argument: "<entry.ts>",
        flags: {},
        summary:
            "compile census and API readiness of an external entry into artifacts/survey/<directory>-<stem>/",
        lock: true,
    },
];

/** The usage text, generated from the command table so it cannot drift
 *  from what the parser accepts. */
function usage(): string {
    const lines = ["Usage: scene-command <command> [argument] [options]", ""];
    for (const command of COMMANDS) {
        const invocation = [
            command.name,
            command.argument,
            usageFromSpec(command.flags),
        ]
            .filter((part) => part !== undefined && part !== "")
            .join(" ");
        lines.push(`  ${invocation}`);
        lines.push(`      ${command.summary}`);
    }
    lines.push(
        "",
        "Backends: sdl_gpu|dawn|both in any case (gpu = sdl_gpu); artifact filenames use gpu|dawn.",
        "BBLITE_NATIVE_EXE points every measuring command at another executable.",
    );
    return lines.join("\n");
}

async function main(): Promise<void> {
    const [command, ...arguments_] = process.argv.slice(2);
    if (
        command === undefined ||
        command === "help" ||
        command === "--help" ||
        command === "-h"
    ) {
        console.log(usage());
        return;
    }
    const spec = COMMANDS.find((entry) => entry.name === command);
    if (spec === undefined) {
        throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
    }
    // Every `npm run scene` runs `npm run build` first, so any build started
    // while this one is working deletes the `dist/` it is executing from.
    // `tools/clean-dist.mjs` refuses to cross this lock; a read-only command
    // that returns at once does not hold it.
    if (spec.lock)
        holdDistLock([command, arguments_[0]].filter(Boolean).join(" "));
    let id: string | undefined;
    let rest = arguments_;
    if (spec.argument !== undefined) {
        id = arguments_[0];
        if (id === undefined || id.startsWith("--")) {
            throw new Error(
                `${command} needs ${spec.argument}.\n\n  ${command} ${spec.argument} ${usageFromSpec(spec.flags)}`,
            );
        }
        rest = arguments_.slice(1);
    }
    // One strict parse per invocation, against the command's own spec.
    const parsed = parseFlags(rest, spec.flags, command);
    if (parsed.flags.has("--gpu-debug")) enableGpuDebug();
    switch (command) {
        case "doctor":
            runDoctor();
            return;
        case "setup":
            runDevelopmentSetup();
            return;
        case "list":
            if (parsed.flags.has("--json")) {
                console.log(JSON.stringify(scenes, null, 2));
            } else {
                for (const scene of scenes) {
                    console.log(
                        `${scene.id}\t${scene.name}\t${scene.source}\t${scene.buildDirectory}`,
                    );
                }
            }
            return;
        case "show":
            runShow(id!, parsed);
            return;
        case "status":
            if (!runStatus(id!, parsed.flags.has("--run")))
                process.exitCode = 1;
            return;
        case "compile":
            await withColdBuild(parsed, () => compile(id!));
            return;
        case "build":
            await withBuildOptions("build", parsed, () => build(id!));
            return;
        case "process":
            await withBuildOptions("process", parsed, () => processScene(id!));
            return;
        case "validate":
            await withColdBuild(parsed, () => runValidate(id!));
            return;
        case "clean":
            runClean({
                orphans: parsed.flags.has("--orphans"),
                all: parsed.flags.has("--all"),
                report: parsed.flags.has("--report"),
                dlls: parsed.flags.has("--dlls"),
                pch: parsed.flags.has("--pch"),
                artifacts: parsed.flags.has("--artifacts"),
            });
            return;
        case "parity":
            await parity(id!, parityArgumentsFrom(parsed), rest);
            return;
        case "memory":
            runMemoryReport(id!, memoryArgumentsFrom(parsed));
            return;
        case "capture":
            await runCapture(id!, parsed);
            return;
        case "diff": {
            const view = diffView(id!, parsed);
            if (view === "uniforms") {
                await runUniforms(id!, parsed);
                return;
            }
            if (view === "compose") {
                const captureDirectory = parsed.values.get("--capture");
                const seekSeconds = flagNumber(parsed, "--seek", "diff");
                const { runComposeReport } =
                    await import("./scene-compose-report.js");
                const outcome = await runComposeReport(
                    id!,
                    scenes,
                    resolveScene,
                    {
                        ...(captureDirectory !== undefined
                            ? { captureDirectory }
                            : {}),
                        ...(seekSeconds !== undefined ? { seekSeconds } : {}),
                    },
                );
                if (outcome.gaps > 0) process.exitCode = 1;
                return;
            }
            const backend = parsed.values.get("--backend");
            const captureDirectory = parsed.values.get("--capture");
            const seekSeconds = flagNumber(parsed, "--seek", "diff");
            await runRenderDiff(id!, {
                ...(backend !== undefined ? { backend } : {}),
                ...(captureDirectory !== undefined ? { captureDirectory } : {}),
                ...(seekSeconds !== undefined ? { seekSeconds } : {}),
                recapture: parsed.flags.has("--recapture"),
            });
            return;
        }
        case "diagnose":
            if (!(await runDiagnose(id!, parsed))) process.exitCode = 1;
            return;
        case "check":
            if (!(await runDeclaredCheck(id!, parsed))) process.exitCode = 1;
            return;
        case "measure": {
            // The measure-the-PNG rule as a command: the non-background
            // bounding box, pixel count and per-channel means of any PNG,
            // native render or otherwise. Takes a path, not a scene id.
            const backgroundFlag = parsed.values.get("--background");
            const background =
                backgroundFlag === undefined
                    ? undefined
                    : parseRgbTriple(backgroundFlag, "--background", "measure");
            const imagePath = resolve(id!);
            if (!existsSync(imagePath)) {
                throw new Error(`measure: no image at ${imagePath}.`);
            }
            console.log(
                formatPngMeasurement(
                    imagePath,
                    measurePng(imagePath, background),
                ),
            );
            return;
        }
        case "probe":
            await runProbe(id!, parsed);
            return;
        case "neutrality": {
            const generated = parsed.flags.has("--generated");
            if (parsed.flags.has("--write") && !generated) {
                throw new Error(
                    "neutrality: --write saves a generated-tree baseline and rides --generated.",
                );
            }
            const neutral = generated
                ? runGeneratedNeutrality(id!, parsed.flags.has("--write"))
                : runNeutralityReport(id!).neutral;
            if (!neutral) process.exitCode = 1;
            return;
        }
        case "survey":
            if (!(await runSurvey(id!))) process.exitCode = 1;
            return;
        default:
            throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
    }
}

if (isMainModule(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
