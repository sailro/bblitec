#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import {
    cpSync,
    existsSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
    backendFileToken,
    canonicalBackend,
    captureMetaPath,
    captureNativePaths,
    captureSeekBracketDirectory,
    defaultCaptureDirectory,
    defaultExecutable,
    type DifferentialReportSummary,
    enableGpuDebug,
    flagNumber,
    formatPngMeasurement,
    measurePng,
    parityReportPath,
    type ParityReportSummary,
    parseFlags,
    parseParityArguments,
    parseRgbTriple,
    parseMemoryArguments,
    parseStabilityArguments,
    readCaptureMeta,
    readSeekMeta,
    resolveBackend,
    runSceneParity,
    runSceneParityDifferential,
    runMemoryReport,
    runStabilityReport,
    seekBracketPlan,
    withEnvironment,
    writeReport,
} from "./parity-scene.js";
import {
    computeBuildStamp,
    deployedPayloads,
    generatorWouldReconfigure,
    incompatibleCacheEntries,
    payloadOrphans,
    readCacheConfiguration,
} from "./build-stamp.js";
import {
    generationIsCurrent,
    recordGeneration,
    refreshBuildStamp,
} from "./generation-stamp.js";
import { runGeometryOutputDiagnostics } from "./geometry-output-diagnostics.js";
// The instrumented capture, the diff/uniforms readers and the compose
// report are imported per subcommand rather than here: their chains pull
// playwright-core, typescript and the pinned-module cluster, which every
// other subcommand — including each parity child of a matrix run — would
// pay at startup without using (the BU-14 lazy-import split).
import {
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
    defaultDevelopmentBackend,
    DEVELOPMENT_VCPKG_INSTALL,
    developmentVcpkgFeatures,
    hostOfflineShaderTarget,
    type OfflineShaderTarget,
} from "./build-options.js";
import { resolveBrowserPath } from "./browser-path.js";
import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
    type DevelopmentTools,
    type WindowsBuildTools,
} from "./development-tools.js";
import {
    contentFingerprint,
    hashEntries,
    readValidationCheckpoint,
    shaderDirectoryFingerprints,
    toolIdentity,
    validationShaderInput,
    writeValidationCheckpoint,
} from "./validation-resume.js";
import { runConcurrently } from "./run-concurrently.js";

function run(
    command: string,
    arguments_: string[],
    environment: NodeJS.ProcessEnv = process.env,
): void {
    const result = spawnSync(command, arguments_, {
        stdio: "inherit",
        env: environment,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}.`);
    }
}

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
): Promise<void> {
    return new Promise((resolve_, reject) => {
        const child = spawn(command, arguments_, {
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
            env: environment,
        });
        child.stdout?.on("data", (chunk: Buffer) =>
            capture?.push(chunk.toString()),
        );
        child.stderr?.on("data", (chunk: Buffer) =>
            capture?.push(chunk.toString()),
        );
        child.on("error", reject);
        child.on("close", (status) => {
            if (status === 0) {
                resolve_();
                return;
            }
            reject(
                new Error(
                    `${command} exited with status ${status}.`,
                ),
            );
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
            process.stdout.write(
                `${options.label ?? ""}${output.join("")}`,
            );
        }
        if (options.settleMs !== undefined) {
            await new Promise((done) =>
                setTimeout(done, options.settleMs),
            );
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
    ];
    if (scene.parity?.referenceSearch !== undefined) {
        arguments_.push("--search", scene.parity.referenceSearch);
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
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
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
    await runConcurrently(
        stale,
        inFlight,
        (scene) => scene.id,
        (scene) =>
            runBuffered({ buffer: stale.length > 1 }, async (run) => {
                const arguments_ = compilerArguments(scene);
                const startedAt = Date.now();
                await run(process.execPath, arguments_);
                recordGeneration(scene, arguments_, startedAt);
            }),
        { completed: "compiled" },
    );
}

async function parity(
    idOrSource: string,
    extraArguments: string[],
): Promise<void> {
    // One strict parse up front: a mistyped flag or an impossible
    // combination fails here, before any child process or build-stamp
    // check spends time on it.
    const parsed = parseParityArguments(extraArguments);
    if (parsed.sceneId !== undefined) {
        // The scene id was already consumed from the command line; a
        // second bare argument is a mistake, not a selection.
        throw new Error(
            `Unexpected parity argument '${parsed.sceneId}'.`,
        );
    }
    const differential = parsed.differential;
    // `--differential` and `--gpu-debug` are consumed here, not forwarded:
    // the differential path spawns its own per-backend processes, and
    // `--gpu-debug` acts through the environment (`enableGpuDebug`), which
    // the children inherit. The fan-out below re-adds both per child.
    const passthrough = extraArguments.filter(
        (argument) =>
            argument !== "--differential" && argument !== "--gpu-debug",
    );
    if (parsed.gpuDebug) enableGpuDebug();
    if (idOrSource === "all") {
        const measured = scenes.filter((scene) => scene.parity);
        const audioScenes: SceneDefinition[] = [];
        const parallelScenes: SceneDefinition[] = [];
        for (const scene of measured) {
            (sceneUsesNativeFeature(scene, "audio:engine")
                ? audioScenes
                : parallelScenes
            ).push(scene);
        }
        // One child process per scene, not one promise.
        //
        // A differential run selects its backend through
        // `BBLITE_GPU_BACKEND`, which is process-global: two scenes
        // sharing an interpreter would race on it and measure one
        // backend twice, writing plausible numbers for a comparison that
        // never happened. Separate processes each own their environment,
        // and a scene that loses its GPU device takes only itself down.
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
        const inFlight =
            concurrencyOverride("BBLITE_PARALLEL_PARITY") ?? 8;
        if (inFlight > 1) {
            console.log(
                `Measuring ${measured.length} scenes, ${inFlight} at a time ` +
                    `(${audioScenes.length} audio scenes serialized).`,
            );
        }
        // The children are scene-command.js processes themselves; the
        // marker tells their holdDistLock that this parent already holds
        // the dist lock, so the first finished child cannot unlink it
        // from under the rest of the matrix run.
        const childEnvironment: NodeJS.ProcessEnv = {
            ...process.env,
            BBLITE_DIST_LOCK_HELD: "1",
        };
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
                            run(
                                process.execPath,
                                [
                                    resolve("dist/src/scene-command.js"),
                                    "parity",
                                    scene.id,
                                    ...(differential
                                        ? ["--differential"]
                                        : passthrough),
                                    ...(parsed.gpuDebug
                                        ? ["--gpu-debug"]
                                        : []),
                                ],
                                childEnvironment,
                            ),
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
    if (!scene.parity) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    if (differential) {
        await runSceneParityDifferential(idOrSource);
        return;
    }
    await runSceneParity([idOrSource, ...passthrough]);
}

async function build(idOrSource: string): Promise<void> {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    const reachesAudio =
        idOrSource === "all" ||
        selected.some((scene) =>
            sceneUsesNativeFeature(scene, "audio:engine"),
        );
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
        existsSync(features) &&
        readFileSync(features, "utf8").includes(feature)
    );
}

/** One vcpkg manifest install: where it lands, for which triplet, with
 *  which of the manifest's features. */
interface VcpkgManifestInstall {
    installedDirectory: string;
    triplet: string;
    features: readonly string[];
}

/**
 * The install every development tree links against: the full manifest
 * feature set (`developmentVcpkgFeatures`) under the shared root.
 */
function developmentVcpkgInstall(): VcpkgManifestInstall {
    return {
        installedDirectory: resolve(
            process.env.BBLITE_VCPKG_INSTALLED_ROOT ??
                join("artifacts", "vcpkg-installed"),
            DEVELOPMENT_VCPKG_INSTALL,
        ),
        triplet: "x64-windows",
        features: developmentVcpkgFeatures(
            readFileSync(resolve("native", "vcpkg.json"), "utf8"),
        ),
    };
}

/**
 * The one vcpkg run a population build makes.
 *
 * Every development tree consumes the same install, so the manifest is
 * installed there once -- before any tree configures, and only when what
 * it is built from moved -- and each configure is then told not to run
 * vcpkg at all (`VCPKG_MANIFEST_INSTALL=OFF`). A configure no longer
 * touches anything shared, so trees configure beside each other instead
 * of through a lock: the serialized manifest check was what made a cold
 * population, or a `CMakeLists.txt` edit, cost 229 vcpkg invocations one
 * after another. The install is keyed on its inputs rather than
 * re-verified per tree: the manifest, the registry configuration, the
 * overlay ports, the feature set, the triplet and the vcpkg executable.
 */
function installVcpkgManifest(
    vcpkgExecutable: string,
    install: VcpkgManifestInstall,
    environment: NodeJS.ProcessEnv,
): void {
    const stampPath = join(install.installedDirectory, ".bblite-install-stamp");
    const stamp = hashEntries([
        "vcpkg-install v1",
        `triplet ${install.triplet}`,
        `features ${install.features.join(";")}`,
        `vcpkg ${toolIdentity(vcpkgExecutable)}`,
        `manifest ${contentFingerprint([
            resolve("native", "vcpkg.json"),
            resolve("native", "vcpkg-configuration.json"),
            resolve("native", "vcpkg-overlay-ports"),
        ])}`,
    ]);
    if (
        existsSync(stampPath) &&
        readFileSync(stampPath, "utf8").trim() === stamp
    ) {
        return;
    }
    run(
        vcpkgExecutable,
        [
            "install",
            `--x-manifest-root=${resolve("native")}`,
            `--x-install-root=${install.installedDirectory}`,
            `--triplet=${install.triplet}`,
            ...install.features.map((feature) => `--x-feature=${feature}`),
        ],
        environment,
    );
    writeFileSync(stampPath, `${stamp}\n`);
}

/** A positive-integer environment override, rejected loudly if malformed. */
function concurrencyOverride(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
            `${name} must be a positive integer (got '${value}').`,
        );
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
    const { vcpkg, tools, environment } = buildSetup();
    if (vcpkg) installVcpkgManifest(tools.vcpkg!, vcpkg.install, environment);
    if (selected.length === 1) {
        await runSceneBuild(selected[0]!, undefined, false);
        return;
    }
    const { scenes: inFlight, jobsPerScene } = buildConcurrency();
    console.log(
        `Building ${selected.length} scenes, ${inFlight} at a time ` +
            `(${jobsPerScene} jobs each).`,
    );
    await runConcurrently(
        selected,
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
    if (
        generator !== undefined &&
        cache.CMAKE_GENERATOR !== generator
    ) {
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
        if (
            resolve(cached).toLowerCase() !==
                resolve(value).toLowerCase() &&
            cached !== value
        ) {
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
    rest: string[],
    body: () => Promise<void>,
): Promise<void> {
    if (!rest.includes("--cold")) {
        await body();
        return;
    }
    await withEnvironment("BBLITE_COLD_BUILD", "1", body);
}

/** Build/process flags which shape the compiled tree, not the runtime. */
async function withBuildOptions(
    command: "build" | "process",
    rest: string[],
    body: () => Promise<void>,
): Promise<void> {
    const parsed = parseFlags(
        rest,
        {
            value:
                command === "process"
                    ? ["--backend", "--compiler", "--shader"]
                    : ["--backend", "--compiler"],
            boolean: ["--cold"],
        },
        command,
    );
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
        withCompiler(() => withShader(() => withColdBuild(rest, body))),
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
    backend: string;
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
        canonicalDevelopmentCompiler(
            process.env.BBLITE_DEV_COMPILER ?? "auto",
        ),
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
            "CMake was not found. Install the Visual Studio CMake component or set CMAKE_COMMAND.",
        );
    }
    // Backend selection: BOTH (the dual-backend differential binary) for
    // development. A missing pinned Dawn install is an incomplete dev setup,
    // not a reason to silently reduce validation to SDL_GPU. Set
    // BBLITE_BACKEND=SDL_GPU|DAWN|BOTH to override;
    // BBLITE_GPU_BACKEND still selects at runtime in BOTH builds.
    const requestedBackend = process.env.BBLITE_BACKEND;
    if (
        requestedBackend !== undefined &&
        !["SDL_GPU", "DAWN", "BOTH"].includes(requestedBackend)
    ) {
        throw new Error(
            `BBLITE_BACKEND must be SDL_GPU, DAWN, or BOTH (got '${requestedBackend}').`,
        );
    }
    const backend =
        requestedBackend ?? defaultDevelopmentBackend(process.platform);
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
    const vcpkg =
        !needsVcpkg
            ? undefined
            : {
                  root: tools.vcpkgRoot!,
                  toolchain: tools.vcpkgToolchain!,
                  install: developmentVcpkgInstall(),
              };
    const environment: NodeJS.ProcessEnv = {
        ...(windows?.environment ?? process.env),
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

function developmentChecks(scope: PreflightScope): DevelopmentCheck[] {
    const tools = currentDevelopmentTools();
    const checks: DevelopmentCheck[] = [
        { label: "Node.js", path: process.execPath },
        {
            label: "CMake",
            ...(tools.cmake
                ? { path: tools.cmake }
                : { problem: "not found (install the Visual Studio CMake component or set CMAKE_COMMAND)" }),
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
    const backend =
        process.env.BBLITE_BACKEND ?? defaultDevelopmentBackend(process.platform);
    if (!["SDL_GPU", "DAWN", "BOTH"].includes(backend)) {
        checks.push({
            label: "backend",
            problem: `BBLITE_BACKEND must be SDL_GPU, DAWN, or BOTH (got '${backend}')`,
        });
    } else if (backend === "DAWN" || backend === "BOTH") {
        checks.push({
            label: "Dawn",
            ...(tools.dawnInstalled
                ? { path: tools.dawnDirectory }
                : { problem: `not built at ${tools.dawnDirectory}` }),
        });
    }
    if (scope.shaders) {
        checks.push({
            label: "PowerShell",
            ...(tools.powershell
                ? { path: tools.powershell }
                : { problem: "pwsh was not found" }),
        });
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
                : { problem: `not built at ${tools.labSoundDirectory}` }),
        });
    }
    if (scope.rmlUi) {
        checks.push({
            label: "RmlUi",
            ...(tools.rmlUiInstalled
                ? { path: tools.rmlUiDirectory }
                : { problem: `not built at ${tools.rmlUiDirectory}` }),
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
    const checks = developmentChecks({
        browser: true,
        labSound: true,
        rmlUi: true,
        shaders: true,
    });
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
    };
}

function runDevelopmentSetup(): void {
    if (process.platform !== "win32") {
        throw new Error(
            "dev:setup currently provisions the pinned Windows development toolchain; install the documented host tools manually on this platform and run 'npm run doctor'.",
        );
    }
    const tools = discoverDevelopmentTools();
    const bootstrapMissing = [
        ["CMake", tools.cmake],
        ["vcpkg", tools.vcpkg],
        ["PowerShell", tools.powershell],
        ["git", tools.git],
    ].filter((entry) => !entry[1]);
    if (bootstrapMissing.length > 0) {
        throw new Error(
            `dev:setup needs ${bootstrapMissing.map(([label]) => label).join(", ")}. Install the Visual Studio C++/CMake/vcpkg components and PowerShell first.`,
        );
    }
    const environment = setupEnvironment(tools);
    installVcpkgManifest(tools.vcpkg!, developmentVcpkgInstall(), environment);
    const pinnedDxc = resolve(
        "tools",
        "shader-compiler",
        "vcpkg_installed",
        "x64-windows",
        "tools",
        "directx-dxc",
        "dxc.exe",
    );
    if (!existsSync(pinnedDxc)) {
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
                "--triplet=x64-windows",
            ],
            environment,
        );
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
    for (const { source, deployed } of deployedPayloads(
        resolve(scene.buildDirectory),
        resolve(scene.output),
    )) {
        for (const path of payloadOrphans(source, deployed)) {
            rmSync(resolve(deployed, path), { force: true });
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
        `-DBBLITE_DAWN_DIR=${tools.dawnDirectory}`,
    );
    // An SDL3 install to use instead of the toolchain's. Forwarded like
    // BBLITE_BACKEND so a whole-matrix run can be pointed at one build,
    // and included in the cache comparison below so switching it always
    // reconfigures rather than silently keeping the previous SDL3.
    const sdlDirectory = process.env.BBLITE_SDL_DIR;
    if (sdlDirectory) {
        configureArguments.push(
            `-DBBLITE_SDL_DIR=${resolve(sdlDirectory)}`,
        );
    }
    if (windows) {
        configureArguments.push(
            `-DCMAKE_MAKE_PROGRAM=${windows.ninja}`,
            `-DCMAKE_CXX_COMPILER=${windows.compiler}`,
        );
    }
    if (vcpkg) {
        configureArguments.push(
            `-DCMAKE_TOOLCHAIN_FILE=${vcpkg.toolchain}`,
            `-DVCPKG_INSTALLED_DIR=${vcpkg.install.installedDirectory}`,
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
                generatorWouldReconfigure(
                    scene.buildDirectory,
                    scene.output,
                )
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

function compileShaders(sceneId?: string): void {
    const setup = buildSetup();
    const target = shaderTarget();
    const arguments_ = [
        "-File",
        "tools/compile-shaders.ps1",
        "-Target",
        target,
    ];
    if (sceneId) arguments_.push("-Scene", sceneId);
    run(
        setup.tools.powershell ??
            (process.platform === "win32" ? "pwsh.exe" : "pwsh"),
        arguments_,
        setup.environment,
    );
}

/** One validation stage: the work, and optionally the record that lets a
 *  repeat skip it. */
interface Stage {
    name: string;
    body: () => Promise<void>;
    reusable?: () => boolean;
    record?: () => void;
}

/** Runs a stage unless its record says the work is already done; returns
 *  whether it was skipped. A finished stage records itself. */
async function runStage(stage: Stage): Promise<boolean> {
    if (stage.reusable?.()) return true;
    await stage.body();
    stage.record?.();
    return false;
}

/** The one offline shader format this host compiles, or the override. */
function shaderTarget(): OfflineShaderTarget {
    return hostOfflineShaderTarget(
        process.platform,
        process.env["BBLITE_SHADER_TARGET"],
    );
}

function validationCheckpointPath(sceneId: string | undefined): string {
    return resolve("artifacts", "validate", `${sceneId ?? "all"}.json`);
}

/**
 * The shader stage, shared by `process` and `validate`: it runs
 * `tools/compile-shaders.ps1` over the WGSL generation wrote, and is
 * skipped when that WGSL, the target, the tools and the script are what
 * the record was written from and its products are still on disk. Keyed on
 * the shader sources rather than the whole generated tree, so a build-stamp
 * refresh after a PAL edit does not re-run it.
 */
function shaderStage(selected: readonly SceneDefinition[]): Stage {
    const setup = buildSetup();
    const single = selected.length === 1 ? selected[0]! : undefined;
    const checkpointPath = validationCheckpointPath(single?.id);
    // The digests `reusable` took, reused by `record`: the sources are
    // generation's outputs and cannot move while the shader compiler runs.
    let input: string | undefined;
    const digest = (): { input: string; products: string } => {
        const { sources, products } = shaderDirectoryFingerprints(selected);
        return {
            input: validationShaderInput(sources, shaderTarget(), setup.tools),
            products,
        };
    };
    return {
        name: "shaders",
        reusable: (): boolean => {
            if (coldBuild()) return false;
            const current = digest();
            input = current.input;
            const checkpoint = readValidationCheckpoint(checkpointPath);
            return (
                checkpoint.shaders?.input === current.input &&
                checkpoint.shaders.output === current.products
            );
        },
        body: async () => compileShaders(single?.id),
        record: (): void => {
            const checkpoint = readValidationCheckpoint(checkpointPath);
            checkpoint.shaders = {
                input: input ?? digest().input,
                output: shaderDirectoryFingerprints(selected).products,
            };
            writeValidationCheckpoint(checkpointPath, checkpoint);
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
    const selected =
        idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    await compile(idOrSource);
    if (await runStage(shaderStage(selected))) {
        console.log("shaders: up to date (sources, tools and products unchanged).");
    }
    if (idOrSource === "all") {
        await buildScenes(scenes);
        return;
    }
    await build(idOrSource);
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
    rest: string[],
): Promise<{ findings: string[]; reportPath: string }> {
    const parsed = parseFlags(
        rest,
        {
            value: ["--backend", "--capture", "--seek"],
            boolean: ["--recapture", "--gpu-debug"],
        },
        "diff",
    );
    const scene = resolveScene(idOrSource);
    if (parsed.flags.has("--gpu-debug")) enableGpuDebug();
    const backend = resolveBackend(
        parsed.values.get("--backend"),
        "diff",
    );
    const token = backendFileToken(backend);
    const captureDirectory = resolve(
        parsed.values.get("--capture") ??
            defaultCaptureDirectory(scene.id),
    );
    const recapture = parsed.flags.has("--recapture");
    const seek = flagNumber(parsed, "--seek", "diff");
    const { browserCaptureStaleness, runInstrumentedCapture } =
        await import("./capture-instrumented.js");
    // The effective seek is what the capture modules themselves resolve:
    // the explicit flag, else the registry pose. A capture on disk is only
    // reusable when it was taken at this pose, from the scene module as it
    // stands — diffing across poses, or against evidence from a scene
    // source or pinned package that has since moved, is the stale-evidence
    // class this command exists to prevent.
    const wantSeek =
        seek ?? scene.parity?.referenceTimeSeconds ?? null;
    const browserReason = browserCaptureStaleness(
        scene,
        captureDirectory,
        { requireSeek: wantSeek },
    );
    if (recapture || browserReason !== undefined) {
        if (!recapture && browserReason !== "missing") {
            console.log(
                `Browser capture ${browserReason}; recapturing.`,
            );
        }
        await runInstrumentedCapture(idOrSource, {
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            outputDirectory: captureDirectory,
        });
    }
    // One shared spelling with the native-capture writer, so reader and
    // writer cannot drift.
    const nativePaths = captureNativePaths(captureDirectory, token);
    let nativeCapturePath = nativePaths.capture;
    const nativeReason = ((): string | undefined => {
        if (!existsSync(nativeCapturePath)) return "missing";
        // The capture embeds the stamp of the generated tree it was built
        // from; a tree that moved since makes the capture describe a build
        // that no longer exists.
        try {
            const capture = JSON.parse(
                readFileSync(nativeCapturePath, "utf8"),
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
        if (readSeekMeta(nativePaths.meta) !== wantSeek) {
            return "was captured at a different seek (or carries no provenance)";
        }
        return undefined;
    })();
    if (recapture || nativeReason !== undefined) {
        if (!recapture && nativeReason !== "missing") {
            console.log(`Native capture ${nativeReason}; recapturing.`);
        }
        const result = runNativeCapture(idOrSource, {
            backend,
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            outputDirectory: captureDirectory,
        });
        nativeCapturePath = result.capturePath;
    }
    const { buildRenderDiff, formatRenderDiff } = await import(
        "./render-diff.js"
    );
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
 * `scene -- capture <id> --seek-bracket`: rung 6's ±1-frame recipe as a
 * command. Three browser captures — the exact seek, one frame before,
 * one frame after — and the MAD between the exact frame and each
 * neighbour, which is the scale of one frame of motion. A residual is
 * then judged against that scale instead of against intuition.
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
        explicitSeek ?? scene.parity?.referenceTimeSeconds,
        frameRate,
    );
    const captureDirectory = resolve(
        outputDirectory ?? defaultCaptureDirectory(scene.id),
    );
    const { runInstrumentedCapture } = await import(
        "./capture-instrumented.js"
    );
    // The exact-seek capture keeps its byte-identity check against the
    // committed golden — of the three, it is the one whose pose the
    // golden was captured at.
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
            // A draw filter that can match no draw: it perturbs nothing
            // (the hook skips only positive matches) while marking the
            // capture as filtered, which suppresses its byte-identity
            // check against the golden. That check belongs to the
            // exact-seek capture alone — these two are one frame away
            // from the golden's pose by design, and "DIFFERS from the
            // committed golden" would be alarm about the experiment
            // working.
            skipDrawIndexCount: -1,
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
            "judge a residual against that scale (docs/debugging.md rung 6).",
    );
    console.log(`Report: ${reportPath}`);
}

/**
 * `scene -- probe-variants <id>`: rung 6's single-shader-arm probe as a
 * command.
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
 * artifact beside the WGSL, which only `tools/compile-shaders.ps1` refreshes, so
 * an SDL_GPU run would measure the unedited compiled artifacts.
 */
async function runProbeVariants(
    idOrSource: string,
    rest: string[],
): Promise<void> {
    const parsed = parseFlags(
        rest,
        {
            value: [
                "--shader",
                "--term",
                "--with",
                "--replace-file",
                "--seek",
                "--backend",
            ],
            boolean: ["--gpu-debug"],
        },
        "probe-variants",
    );
    const scene = resolveScene(idOrSource);
    if (parsed.flags.has("--gpu-debug")) enableGpuDebug();
    const backendFlag = parsed.values.get("--backend");
    if (
        backendFlag !== undefined &&
        canonicalBackend(backendFlag, "probe-variants") !==
            "dawn"
    ) {
        throw new Error(
            "probe-variants: the probe is Dawn-only — Dawn compiles the deployed " +
                ".native.wgsl at startup, while SDL_GPU consumes its selected offline artifact " +
                "beside it, which only tools/compile-shaders.ps1 refreshes " +
                "(docs/debugging.md rung 6).",
        );
    }
    const shader = parsed.values.get("--shader");
    if (shader === undefined) {
        throw new Error(
            "probe-variants: --shader names the deployed shader to probe " +
                "(a *.native.wgsl file in the scene's build shaders directory, " +
                "with or without the suffix).",
        );
    }
    const term = parsed.values.get("--term");
    const replacement = parsed.values.get("--with");
    const replaceFile = parsed.values.get("--replace-file");
    if ((term === undefined) === (replaceFile === undefined)) {
        throw new Error(
            "probe-variants: pass exactly one of --term <text> --with <replacement> " +
                "(literal substitution inside the shader) or --replace-file <path> " +
                "(the whole file's content).",
        );
    }
    if (term !== undefined && replacement === undefined) {
        throw new Error(
            "probe-variants: --term requires --with <replacement>; there is no " +
                "safe default neutralization, and a guessed one measures a " +
                "different experiment than the one named.",
        );
    }
    if (term === undefined && replacement !== undefined) {
        throw new Error("probe-variants: --with rides --term.");
    }
    const seek = flagNumber(parsed, "--seek", "probe-variants");

    const executable = defaultExecutable(scene.buildDirectory);
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
            `probe-variants: no deployed shader '${shader}' in ${deployedDirectory}. ` +
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
            throw new Error(
                `probe-variants: '${term}' appears nowhere in ${fileName}.`,
            );
        }
        edited = original.split(term).join(replacement!);
    } else {
        const source = resolve(replaceFile!);
        if (!existsSync(source)) {
            throw new Error(
                `probe-variants: no replacement file at ${source}.`,
            );
        }
        edited = readFileSync(source, "utf8");
    }
    const backupDirectory = `${deployedDirectory}.probe-backup`;
    if (existsSync(backupDirectory)) {
        throw new Error(
            `probe-variants: ${backupDirectory} already exists — a previous probe ` +
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
    // would print golden MADs comparing two different poses — the exact
    // pair `parity --seek` refuses — so those columns are suppressed and
    // say why. `--seek` at the registry pose keeps them.
    const goldenComparable =
        seek === undefined ||
        seek === scene.parity?.referenceTimeSeconds;
    const goldenPath = scene.parity
        ? resolve(scene.parity.reference.path)
        : undefined;
    const golden =
        goldenComparable &&
        goldenPath !== undefined &&
        existsSync(goldenPath)
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
    } else if (!goldenComparable) {
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
            seekSeconds: seek ?? scene.parity?.referenceTimeSeconds ?? null,
            before: {
                screenshot: before.screenshotPath,
                measurement: beforeMeasurement,
            },
            after: {
                screenshot: after.screenshotPath,
                measurement: afterMeasurement,
            },
            afterVsBefore: { mad: delta.mad, maxDiff: delta.maxDiff },
            ...(goldenComparable
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
 * `scene -- neutrality-generated <baseline.txt> [--write]`: the
 * compile-and-digest half of the neutrality proof. Digests every
 * registry-owned file under `generated/` (sha1, `generated/<path>\t<hash>`
 * lines) and writes or compares the baseline file. It never compiles —
 * run `scene -- compile all` before each invocation, or the digest
 * describes whatever tree the last compile left. Stray top-level
 * directories no registry scene owns are listed loudly and excluded,
 * because hashing a corpus-sweep leftover silently is how two identical
 * compiles digest differently.
 */
function runGeneratedNeutrality(
    baselinePath: string,
    write: boolean,
): void {
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
        return;
    }
    if (!existsSync(baselinePath)) {
        throw new Error(
            `No baseline at ${baselinePath}. Write one before the change with ` +
                `'scene -- neutrality-generated ${baselinePath} --write' (compile first — this command only digests).`,
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
        return;
    }
    list("Changed", comparison.changed);
    list("Added", comparison.added);
    list("Removed", comparison.removed);
    console.log(
        "\nA change meant to be generation-neutral moved the generated tree. " +
            "Confirm both digests followed a full 'scene -- compile all' — " +
            "but if it moves again, it is not neutral.",
    );
    process.exitCode = 1;
}

/**
 * `scene -- validate <id|all>`: the validation bundle. Chains the
 * existing stages — compile, shaders, build, parity, the published-table
 * check — with one summary line per stage, stopping at the first failure
 * (later stages would measure the stale result of the failed one) and
 * preserving every artifact the completed stages wrote. The parity stage
 * runs `--differential` when the pinned Dawn library is installed,
 * mirroring `scenes:parity`.
 */
async function runValidate(idOrSource: string): Promise<void> {
    // Resolve the selection (and the backend story) before any stage
    // spends time on an id that cannot mean anything.
    const scene =
        idOrSource === "all" ? undefined : resolveScene(idOrSource);
    requireDevelopmentPreflight({
        browser: true,
        labSound: idOrSource === "all",
        rmlUi: idOrSource === "all",
        shaders: true,
    });
    const setup = buildSetup();
    const differential = setup.backend === "BOTH";
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
            name: `parity${differential ? " --differential" : ""}`,
            body: () =>
                parity(idOrSource, differential ? ["--differential"] : []),
        },
        {
            name: "verify-status",
            body: async () => {
                const problems = verifyStatus();
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
            if (await runStage(stage)) {
                console.log(
                    `validate: ${stage.name} resumed (inputs and outputs unchanged).`,
                );
                continue;
            }
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
 * rungs — the backend differential (rung 1), the capture pairing
 * (`diff`, rung 3) and the fragment composition (`compose`, rung 4) —
 * through the existing entry points, and prints one summary block with
 * each rung's verdict in ladder order. A failed rung does not stop the
 * later ones: the point of a diagnosis is to see where the ladder
 * breaks, and every rung below a failure is more evidence, not less.
 *
 * `--backend` narrows the parity rung to a single backend (the
 * differential needs both built) and rides into `diff`; `--seek` rides
 * into `diff` and `compose`, and skips the parity rung at a pose other
 * than the registry's — the golden holds the registry pose, so parity
 * there would compare two different poses.
 */
async function runDiagnose(
    idOrSource: string,
    rest: string[],
): Promise<void> {
    const parsed = parseFlags(
        rest,
        {
            value: ["--backend", "--seek"],
            boolean: ["--gpu-debug"],
        },
        "diagnose",
    );
    const scene = resolveScene(idOrSource);
    if (!scene.parity) {
        throw new Error(`Scene '${scene.id}' has no parity definition.`);
    }
    if (parsed.flags.has("--gpu-debug")) enableGpuDebug();
    const backendFlag = parsed.values.get("--backend");
    const backend =
        backendFlag === undefined
            ? undefined
            : canonicalBackend(backendFlag, "diagnose");
    const seek = flagNumber(parsed, "--seek", "diagnose");
    const poseComparable =
        seek === undefined ||
        seek === scene.parity.referenceTimeSeconds;
    const outputDirectory = resolve(scene.parity.outputDirectory);
    const rungs: Array<{ name: string; verdict: string; ok: boolean }> =
        [];
    const heading = (name: string): void => {
        console.log("");
        console.log(`=== diagnose: ${name} ===`);
    };

    // Ladder rung 2 — the decisive differential (or a single-backend
    // parity): backend agreement to one LSB puts a divergence on the CPU
    // side.
    const differential =
        backend === undefined && buildSetup().backend === "BOTH";
    const parityName = differential
        ? "parity --differential"
        : `parity${backend !== undefined ? ` --backend ${backend}` : ""}`;
    if (!poseComparable) {
        rungs.push({
            name: parityName,
            verdict: `skipped — parity measures against the registry-pose golden, and --seek ${seek} is another pose`,
            ok: true,
        });
    } else {
        heading(parityName);
        try {
            if (differential) {
                await runSceneParityDifferential(idOrSource);
            } else {
                await runSceneParity([
                    idOrSource,
                    ...(backend !== undefined
                        ? ["--backend", backend]
                        : []),
                ]);
            }
            rungs.push({
                name: parityName,
                verdict: `ok${parityVerdict(
                    outputDirectory,
                    differential,
                    backend,
                )}`,
                ok: true,
            });
        } catch (error) {
            rungs.push({
                name: parityName,
                verdict: `FAILED: ${(error as Error).message}`,
                ok: false,
            });
        }
    }

    // Ladder rung 3 — the capture pairing, which recaptures stale evidence
    // on its own and reports value/draw/shader findings worst-first.
    heading("diff");
    const diffArguments = [
        ...(backend !== undefined ? ["--backend", backend] : []),
        ...(seek !== undefined ? ["--seek", String(seek)] : []),
    ];
    let diffFindings: string[] | undefined;
    try {
        const result = await runRenderDiff(idOrSource, diffArguments);
        diffFindings = result.findings;
        rungs.push({
            name: "diff",
            verdict:
                result.findings.length === 0
                    ? "ok — no findings"
                    : `${result.findings.length} finding(s); first: ${result.findings[0]}`,
            ok: result.findings.length === 0,
        });
    } catch (error) {
        rungs.push({
            name: "diff",
            verdict: `FAILED: ${(error as Error).message}`,
            ok: false,
        });
    }

    // Ladder rung 7 — the fragment composition against the capture diff
    // just ensured is fresh (same directory, same pose).
    heading("compose");
    try {
        const { runComposeReport } = await import(
            "./scene-compose-report.js"
        );
        const compose = await runComposeReport(
            idOrSource,
            scenes,
            resolveScene,
            {
                ...(seek !== undefined ? { seekSeconds: seek } : {}),
            },
        );
        rungs.push({
            name: "compose",
            verdict:
                compose.gaps === 0
                    ? "ok — every material composes to a captured fragment"
                    : `${compose.gaps} GAP(s) — a composed fragment matches no captured one`,
            ok: compose.gaps === 0,
        });
    } catch (error) {
        rungs.push({
            name: "compose",
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
    for (const rung of rungs) {
        console.log(`  ${rung.name}: ${rung.verdict}`);
    }
    if (rungs.some((rung) => !rung.ok)) {
        process.exitCode = 1;
    } else if (diffFindings !== undefined) {
        console.log(
            "  every rung is clean at this pose; a remaining residual is " +
                "below these instruments (docs/debugging.md, rungs 5+).",
        );
    }
}

/** The parity rung's numbers for the diagnose summary, from the report
 *  the rung itself just wrote; empty when it cannot be read. */
function parityVerdict(
    outputDirectory: string,
    differential: boolean,
    backend: string | undefined,
): string {
    try {
        if (differential) {
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
        const token = backendFileToken(backend ?? "sdl_gpu");
        const report = JSON.parse(
            readFileSync(
                parityReportPath(outputDirectory, token),
                "utf8",
            ),
        ) as ParityReportSummary;
        return ` — full MAD ${report.full.mad.toFixed(3)}, region ${report.region.mad.toFixed(3)}`;
    } catch {
        return "";
    }
}

/**
 * `scene -- clean --orphans [--all]`: delete what no registry entry
 * owns.
 *
 * A corpus sweep or a deregistered scene leaves build trees under
 * `native/` and top-level entries under `generated/` that nothing will
 * ever build again — the shader sweep still processes the generated
 * strays, and `neutrality-generated` has to list them loudly on every
 * digest. The ownership rule is the registry's own: a build tree is
 * owned when some scene's `buildDirectory` names it, and a `generated/`
 * top-level entry is owned when it is a directory some scene's `output`
 * names — the same stray rule `digestGeneratedTree` applies, so this
 * cannot delete anything the digest counts. `--all` additionally
 * removes the OWNED build trees (a full native rebuild); the owned
 * `generated/` directories are never touched — they are compiler
 * output, not build state.
 */
function runClean(orphans: boolean, all: boolean): void {
    if (!orphans && !all) {
        throw new Error(
            "clean: pass --orphans (delete build trees and generated/ entries " +
                "no registry entry owns) and/or --all (also delete every owned " +
                "build tree; owned generated/ directories always stay).",
        );
    }
    let removed = 0;
    const removeTree = (path: string, label: string): void => {
        console.log(`clean: removing ${label} ${path}`);
        rmSync(path, { recursive: true, force: true });
        removed += 1;
    };
    const nativeRoot = resolve("native");
    const ownedBuilds = new Set(
        scenes.map((scene) => resolve(scene.buildDirectory)),
    );
    if (existsSync(nativeRoot)) {
        for (const entry of readdirSync(nativeRoot, {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory() || !entry.name.startsWith("build-")) {
                continue;
            }
            const path = resolve(nativeRoot, entry.name);
            if (ownedBuilds.has(path)) {
                if (all) removeTree(path, "owned build tree");
                continue;
            }
            removeTree(path, "orphan build tree");
        }
    }
    const generatedRoot = resolve("generated");
    const ownedGenerated = new Set(
        scenes.map((scene) => resolve(scene.output)),
    );
    if (existsSync(generatedRoot)) {
        for (const entry of readdirSync(generatedRoot, {
            withFileTypes: true,
        })) {
            const path = resolve(generatedRoot, entry.name);
            if (entry.isDirectory() && ownedGenerated.has(path)) {
                continue;
            }
            removeTree(path, "stray generated entry");
        }
    }
    console.log(
        removed === 0
            ? "clean: nothing to remove."
            : `clean: removed ${removed} entr${removed === 1 ? "y" : "ies"}.`,
    );
}

async function main(): Promise<void> {
    const [command, id, ...rest] = process.argv.slice(2);
    // Every `npm run scene` runs `npm run build` first, so any build started
    // while this one is working deletes the `dist/` it is executing from.
    // `tools/clean-dist.mjs` refuses to cross this lock.
    holdDistLock([command, id].filter(Boolean).join(" "));
    if (command === "doctor") {
        parseFlags(
            [id, ...rest].filter(
                (argument): argument is string => argument !== undefined,
            ),
            {},
            "doctor",
        );
        runDoctor();
        return;
    }
    if (command === "setup") {
        parseFlags(
            [id, ...rest].filter(
                (argument): argument is string => argument !== undefined,
            ),
            {},
            "setup",
        );
        runDevelopmentSetup();
        return;
    }
    if (command === "list") {
        parseFlags(
            [id, ...rest].filter(
                (argument): argument is string => argument !== undefined,
            ),
            {},
            "list",
        );
        for (const scene of scenes) {
            console.log(
                `${scene.id}\t${scene.name}\t${scene.source}\t${scene.buildDirectory}`,
            );
        }
        return;
    }
    if (command === "show" && id) {
        parseFlags(rest, {}, "show");
        console.log(JSON.stringify(resolveScene(id), null, 2));
        return;
    }
    if (command === "compile" && id) {
        parseFlags(rest, { boolean: ["--cold"] }, "compile");
        await withColdBuild(rest, () => compile(id));
        return;
    }
    if (command === "build" && id) {
        await withBuildOptions("build", rest, () => build(id));
        return;
    }
    if (command === "process" && id) {
        await withBuildOptions("process", rest, () => processScene(id));
        return;
    }
    if (command === "parity" && id) {
        await parity(id, rest);
        return;
    }
    if (command === "geometry" && id) {
        const parsed = parseFlags(
            rest,
            {
                value: ["--backend", "--seek", "--exe"],
                boolean: ["--recapture-reference", "--gpu-debug"],
            },
            "geometry",
        );
        const backend = parsed.values.get("--backend");
        const seek = flagNumber(parsed, "--seek", "geometry");
        const executable = parsed.values.get("--exe");
        await runGeometryOutputDiagnostics(id, {
            recaptureReference: parsed.flags.has("--recapture-reference"),
            gpuDebug: parsed.flags.has("--gpu-debug"),
            ...(executable !== undefined ? { executable } : {}),
            ...(backend !== undefined ? { backend } : {}),
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
        });
        return;
    }
    if (command === "uniforms" && id) {
        const parsed = parseFlags(
            rest,
            { value: ["--capture", "--size", "--module"] },
            "uniforms",
        );
        const scene = resolveScene(id);
        const directory =
            parsed.values.get("--capture") ??
            defaultCaptureDirectory(scene.id);
        const sizes = parsed.values.get("--size");
        const module = parsed.values.get("--module");
        // The same staleness discipline diff applies before trusting a
        // capture: a capture from a scene module that has since moved
        // decodes plausible values for a scene that no longer exists.
        // The pose is informational rather than refused — the decoded
        // uploads are evidence at whatever pose they were taken, and
        // this reader takes no --seek to express another intent.
        const { browserCaptureStaleness } = await import(
            "./capture-instrumented.js"
        );
        const staleness = browserCaptureStaleness(scene, directory, {});
        if (staleness !== undefined && staleness !== "missing") {
            throw new Error(
                `uniforms: the capture at ${resolve(directory)} ${staleness}. ` +
                    `Recapture with 'scene -- capture ${scene.id}' ` +
                    "(or 'scene -- diff', which recaptures on its own).",
            );
        }
        const meta = readCaptureMeta(
            captureMetaPath(resolve(directory)),
        );
        const registryPose =
            scene.parity?.referenceTimeSeconds ?? null;
        if (meta && meta.seekSeconds !== registryPose) {
            console.warn(
                `uniforms: capture pose is ${meta.seekSeconds ?? "unseeked"}` +
                    ` (registry pose ${registryPose ?? "unseeked"}) — ` +
                    "the values below describe that pose.",
            );
        }
        const { decodeCapturedUniforms, formatDecodedUniforms } =
            await import("./capture-uniforms.js");
        const decoded = decodeCapturedUniforms(directory, {
            ...(sizes !== undefined
                ? {
                      sizes: sizes.split(",").map((value) => {
                          const numeric = Number(value);
                          if (!Number.isFinite(numeric)) {
                              // A NaN here used to filter every buffer
                              // out silently — the tool answered "no
                              // buffers" to a mistyped size.
                              throw new Error(
                                  `uniforms: --size must be comma-separated numbers (got '${value}').`,
                              );
                          }
                          return numeric;
                      }),
                  }
                : {}),
            ...(module !== undefined ? { module } : {}),
        });
        console.log(formatDecodedUniforms(decoded));
        return;
    }
    if (command === "capture" && id) {
        const parsed = parseFlags(
            rest,
            {
                value: ["--seek", "--skip-draw", "--capture", "--backend"],
                boolean: ["--native", "--gpu-debug", "--seek-bracket"],
                alias: { "--out": "--capture" },
            },
            "capture",
        );
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
        // `--native` asks the same question of our renderer that the
        // browser hooks ask of Babylon Lite's, so the two captures land
        // in one directory and `diff` can pair them.
        if (native) {
            if (skipDraw !== undefined) {
                throw new Error(
                    "capture: --skip-draw filters the browser capture and does not compose with --native.",
                );
            }
            if (parsed.flags.has("--gpu-debug")) enableGpuDebug();
            const backend = resolveBackend(
                parsed.values.get("--backend"),
                "capture",
            );
            const result = runNativeCapture(id, {
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
            await runSeekBracketCapture(id, seek, output);
            return;
        }
        const { runInstrumentedCapture } = await import(
            "./capture-instrumented.js"
        );
        await runInstrumentedCapture(id, {
            ...(seek !== undefined
                ? { seekSeconds: seek }
                : {}),
            ...(skipDraw !== undefined
                ? { skipDrawIndexCount: skipDraw }
                : {}),
            ...(output !== undefined
                ? { outputDirectory: output }
                : {}),
        });
        return;
    }
    if (command === "diff" && id) {
        await runRenderDiff(id, rest);
        return;
    }
    if (command === "probe-variants" && id) {
        await runProbeVariants(id, rest);
        return;
    }
    if (command === "measure" && id) {
        // The measure-the-PNG rule as a command: the non-background
        // bounding box, pixel count and per-channel means of any PNG,
        // native render or otherwise. Takes a path, not a scene id.
        const parsed = parseFlags(
            rest,
            { value: ["--background"] },
            "measure",
        );
        const backgroundFlag = parsed.values.get("--background");
        const background =
            backgroundFlag === undefined
                ? undefined
                : parseRgbTriple(backgroundFlag, "--background", "measure");
        const imagePath = resolve(id);
        if (!existsSync(imagePath)) {
            throw new Error(`measure: no image at ${imagePath}.`);
        }
        console.log(
            formatPngMeasurement(imagePath, measurePng(imagePath, background)),
        );
        return;
    }
    if (command === "compose" && id) {
        const parsed = parseFlags(
            rest,
            { value: ["--capture"] },
            "compose",
        );
        const captureDirectory = parsed.values.get("--capture");
        if (captureDirectory !== undefined && id === "all") {
            throw new Error(
                "compose: --capture names one scene's capture directory and does not compose with 'all'.",
            );
        }
        const { runComposeReport } = await import(
            "./scene-compose-report.js"
        );
        await runComposeReport(id, scenes, resolveScene, {
            ...(captureDirectory !== undefined
                ? { captureDirectory }
                : {}),
        });
        return;
    }
    if (command === "diagnose" && id) {
        await runDiagnose(id, rest);
        return;
    }
    if (command === "clean") {
        const parsed = parseFlags(
            [id, ...rest].filter(
                (argument): argument is string => argument !== undefined,
            ),
            { boolean: ["--orphans", "--all"] },
            "clean",
        );
        runClean(
            parsed.flags.has("--orphans"),
            parsed.flags.has("--all"),
        );
        return;
    }
    if (command === "stability" && id) {
        runStabilityReport(id, parseStabilityArguments(rest));
        return;
    }
    if (command === "memory" && id) {
        runMemoryReport(id, parseMemoryArguments(rest));
        return;
    }
    if (command === "validate" && id) {
        parseFlags(rest, {}, "validate");
        await runValidate(id);
        return;
    }
    if (command === "neutrality" && id) {
        parseFlags(rest, {}, "neutrality");
        runNeutralityReport(id);
        return;
    }
    if (command === "neutrality-generated" && id) {
        const parsed = parseFlags(
            rest,
            { boolean: ["--write"] },
            "neutrality-generated",
        );
        runGeneratedNeutrality(id, parsed.flags.has("--write"));
        return;
    }
    throw new Error(
        "Usage: scene-command <doctor | setup | list | show <id|source.ts> | " +
            "compile|build|process|parity|compose|validate <id|source.ts|all> [options] | " +
            "geometry|capture|uniforms|diff|stability|diagnose <id|source.ts> [options] | " +
            "memory <id|source.ts|all (the application demos)> [--frames N] [--max-growth-mb M] [--replay <tape> | --replay-file <path>] [--backend b] | " +
            "probe-variants <id|source.ts> --shader <name> (--term <text> --with <replacement> | --replace-file <path>) | " +
            "measure <image.png> [--background r,g,b] | " +
            "clean --orphans [--all] | " +
            "neutrality <baseline-parity-directory> (compares report-differential.json only — " +
            "a single-backend sweep produces nothing comparable) | " +
            "neutrality-generated <baseline.txt> [--write] (digests generated/ as it stands; compile first)>",
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
