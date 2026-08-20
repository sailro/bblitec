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
import { dirname, join, resolve } from "node:path";
import {
    backendFileToken,
    canonicalBackend,
    captureBuffersPath,
    captureMetaPath,
    captureNativePaths,
    captureSeekBracketDirectory,
    defaultCaptureDirectory,
    defaultExecutable,
    enableGpuDebug,
    flagNumber,
    formatPngMeasurement,
    measurePng,
    parseFlags,
    parseParityArguments,
    parseRgbTriple,
    parseStabilityArguments,
    resolveBackend,
    runSceneParity,
    runSceneParityDifferential,
    runStabilityReport,
    seekBracketPlan,
    writeReport,
} from "./parity-scene.js";
import {
    comparePayload,
    computeBuildStamp,
    deployedPayloads,
} from "./build-stamp.js";
import { runGeometryOutputDiagnostics } from "./geometry-output-diagnostics.js";
import { runInstrumentedCapture } from "./capture-instrumented.js";
import {
    runNativeCapture,
    type NativeCaptureResult,
} from "./capture-native.js";
import {
    buildRenderDiff,
    formatRenderDiff,
} from "./render-diff.js";
import {
    decodeCapturedUniforms,
    formatDecodedUniforms,
} from "./capture-uniforms.js";
import { compareImages } from "./parity.js";
import { resolveScene, scenes } from "./scene-registry.js";
import { runComposeReport } from "./scene-compose-report.js";
import { holdDistLock } from "./dist-lock.js";
import { runNeutralityReport } from "./scene-neutrality.js";
import {
    compareGeneratedDigest,
    digestGeneratedTree,
    parseDigestBaseline,
} from "./generated-tree.js";
import { verifyStatus } from "./verify-status.js";
import { readCacheConfiguration } from "./build-stamp.js";

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

function latestDirectory(root: string): string | undefined {
    if (!existsSync(root)) return undefined;
    const directories = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name))
        .sort((left, right) =>
            right.localeCompare(left, undefined, { numeric: true }));
    return directories[0];
}

function windowsNinjaEnvironment(): {
    environment: NodeJS.ProcessEnv;
    ninja: string;
} {
    const programFilesX86 =
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const vswhere = join(
        programFilesX86,
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
    );
    const vsResult = existsSync(vswhere)
        ? spawnSync(
              vswhere,
              [
                  "-latest",
                  "-products",
                  "*",
                  "-requires",
                  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                  "-property",
                  "installationPath",
              ],
              { encoding: "utf8" },
          )
        : undefined;
    const environmentVsRoot =
        process.env.VSINSTALLDIR?.replace(/[\\/]+$/, "");
    const discoveredVsRoot =
        vsResult?.status === 0 ? vsResult.stdout.trim() : "";
    const vsRoot = [environmentVsRoot, discoveredVsRoot].find(
        (candidate) =>
            !!candidate &&
            existsSync(join(candidate, "VC", "Tools", "MSVC")),
    ) ?? "";
    if (!vsRoot || !existsSync(vsRoot)) {
        throw new Error(
            "Ninja requires MSVC. Set VSINSTALLDIR or override BBLITE_CMAKE_GENERATOR.",
        );
    }
    const msvc = latestDirectory(join(vsRoot, "VC", "Tools", "MSVC"));
    const sdkRoot = join(programFilesX86, "Windows Kits", "10");
    const sdk = latestDirectory(join(sdkRoot, "Include"));
    const ninja =
        process.env.NINJA_PATH ??
        join(
            vsRoot,
            "Common7",
            "IDE",
            "CommonExtensions",
            "Microsoft",
            "CMake",
            "Ninja",
            "ninja.exe",
        );
    if (!msvc || !sdk || !existsSync(ninja)) {
        throw new Error(
            "Unable to locate MSVC, Windows SDK, or Ninja. Override BBLITE_CMAKE_GENERATOR to use another generator.",
        );
    }
    const sdkVersion = sdk.slice(dirname(sdk).length + 1);
    return {
        ninja,
        environment: {
            ...process.env,
            PATH: [
                join(msvc, "bin", "Hostx64", "x64"),
                join(sdkRoot, "bin", sdkVersion, "x64"),
                dirname(ninja),
                process.env.PATH ?? "",
            ].join(";"),
            INCLUDE: [
                join(msvc, "include"),
                join(sdk, "ucrt"),
                join(sdk, "um"),
                join(sdk, "shared"),
                join(sdk, "winrt"),
                join(sdk, "cppwinrt"),
            ].join(";"),
            LIB: [
                join(msvc, "lib", "x64"),
                join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64"),
                join(sdkRoot, "Lib", sdkVersion, "um", "x64"),
            ].join(";"),
        },
    };
}

async function compile(idOrSource: string): Promise<void> {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    const compilerArguments = (
        scene: (typeof scenes)[number],
    ): string[] => {
        const arguments_ = [
            resolve("dist/src/cli.js"),
            scene.source,
            "--out",
            scene.output,
            "--title",
            scene.title,
        ];
        if (
            scene.parity?.attribution?.drawIds ||
            scene.parity?.attribution?.triangleClusters
        ) {
            arguments_.push("--id-diagnostics");
        }
        return arguments_;
    };
    if (selected.length === 1) {
        run(process.execPath, compilerArguments(selected[0]!));
        return;
    }
    // Each scene is a separate Node process writing to its own output
    // directory, so there is nothing to serialize -- the sequential loop
    // spent two minutes running one interpreter at a time. Node is far
    // lighter than MSVC, so this is bounded by threads alone.
    const inFlight =
        concurrencyOverride("BBLITE_PARALLEL_COMPILES") ??
        availableParallelism();
    console.log(
        `Compiling ${selected.length} scenes, ${inFlight} at a time.`,
    );
    await runConcurrently(
        selected,
        inFlight,
        (scene) => scene.id,
        async (scene) => {
            const output: string[] = [];
            try {
                await runAsync(
                    process.execPath,
                    compilerArguments(scene),
                    process.env,
                    output,
                );
            } finally {
                if (output.length > 0) {
                    process.stdout.write(output.join(""));
                }
            }
        },
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
                `Measuring ${measured.length} scenes, ${inFlight} at a time.`,
            );
        }
        await runConcurrently(
            measured,
            inFlight,
            (scene) => scene.id,
            async (scene) => {
                const output: string[] = [];
                try {
                    await runAsync(
                        process.execPath,
                        [
                            resolve("dist/src/scene-command.js"),
                            "parity",
                            scene.id,
                            ...(differential
                                ? ["--differential"]
                                : passthrough),
                            ...(parsed.gpuDebug ? ["--gpu-debug"] : []),
                        ],
                        process.env,
                        inFlight > 1 ? output : undefined,
                    );
                } finally {
                    if (output.length > 0) {
                        process.stdout.write(output.join(""));
                    }
                    // The settle that has always followed a measured run
                    // on Windows; per worker now rather than per scene.
                    if (process.platform === "win32") {
                        await new Promise((done) =>
                            setTimeout(done, 500),
                        );
                    }
                }
            },
        );
        return;
    }
    const scene = resolveScene(idOrSource);
    if (!scene.parity) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    if (differential) {
        await runSceneParityDifferential(scene.id);
        return;
    }
    await runSceneParity([idOrSource, ...passthrough]);
}

async function build(idOrSource: string): Promise<void> {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    await buildScenes(selected);
}

/**
 * Serializes CMake configure steps while builds run in parallel.
 *
 * Configuring is where vcpkg runs, and concurrent vcpkg use is
 * unreliable -- it shares a download and binary cache across otherwise
 * independent build directories. Compiling and linking touch nothing
 * shared, so only this step needs the lock, and it is rare: a warm tree
 * skips configure entirely, so the queue is usually empty.
 */
let configureLock: Promise<unknown> = Promise.resolve();

function serializeConfigure<T>(body: () => Promise<T>): Promise<T> {
    const next = configureLock.then(body, body);
    // Keep the chain alive even when one configure fails, or every
    // configure queued behind it would inherit that rejection.
    configureLock = next.catch(() => undefined);
    return next;
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
 * Runs `body` over every item, `limit` at a time.
 *
 * A failure does not cancel the work already running: the rest is allowed
 * to finish so one broken item cannot hide the state of the others, and
 * every failure is reported together at the end. That matters most for a
 * registry-wide run, where the useful answer is which scenes failed
 * rather than which one failed first.
 */
async function runConcurrently<T>(
    items: readonly T[],
    limit: number,
    describe: (item: T) => string,
    body: (item: T) => Promise<void>,
): Promise<void> {
    const queue = [...items];
    const failures: string[] = [];
    const worker = async (): Promise<void> => {
        for (;;) {
            const item = queue.shift();
            if (item === undefined) return;
            try {
                await body(item);
            } catch (error) {
                failures.push(
                    `${describe(item)}: ${(error as Error).message}`,
                );
            }
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.max(1, Math.min(limit, queue.length)) },
            worker,
        ),
    );
    if (failures.length > 0) {
        throw new Error(
            `${failures.length} of ${items.length} failed:\n  ${failures.join("\n  ")}`,
        );
    }
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
    const previous = process.env.BBLITE_COLD_BUILD;
    process.env.BBLITE_COLD_BUILD = "1";
    try {
        // Awaited, not just called: restoring the variable in `finally`
        // while the builds were still running would unset it under them.
        await body();
    } finally {
        if (previous === undefined) {
            delete process.env.BBLITE_COLD_BUILD;
        } else {
            process.env.BBLITE_COLD_BUILD = previous;
        }
    }
}

/**
 * The generator, toolchain environment and backend selection every scene
 * shares. Resolving it per scene meant running `vswhere` and rebuilding
 * the MSVC environment 58 times for one answer, and the backend
 * validation only reported a bad `BBLITE_BACKEND` once the first scene
 * reached it.
 */
interface SharedBuildSetup {
    generator: string;
    ninja: ReturnType<typeof windowsNinjaEnvironment> | undefined;
    backend: string;
}

let sharedBuildSetup: SharedBuildSetup | undefined;

function buildSetup(): SharedBuildSetup {
    if (sharedBuildSetup) return sharedBuildSetup;
    const generator = process.env.BBLITE_CMAKE_GENERATOR ?? "Ninja";
    const ninja =
        process.platform === "win32" && generator === "Ninja"
            ? windowsNinjaEnvironment()
            : undefined;
    // Backend selection: BOTH (the dual-backend differential binary)
    // whenever the pinned Dawn library is installed
    // (tools/build-dawn.ps1), SDL_GPU otherwise. Set
    // BBLITE_BACKEND=SDL_GPU|DAWN|BOTH to override;
    // BBLITE_GPU_BACKEND still selects at runtime in BOTH builds.
    const dawnInstalled = existsSync(
        resolve("artifacts", "tools", "dawn", "lib", "cmake", "Dawn"),
    );
    const requestedBackend = process.env.BBLITE_BACKEND;
    if (
        requestedBackend !== undefined &&
        !["SDL_GPU", "DAWN", "BOTH"].includes(requestedBackend)
    ) {
        throw new Error(
            `BBLITE_BACKEND must be SDL_GPU, DAWN, or BOTH (got '${requestedBackend}').`,
        );
    }
    if (
        (requestedBackend === "DAWN" || requestedBackend === "BOTH") &&
        !dawnInstalled
    ) {
        throw new Error(
            `BBLITE_BACKEND=${requestedBackend} requires the pinned Dawn library; run pwsh -File tools/build-dawn.ps1 first.`,
        );
    }
    sharedBuildSetup = {
        generator,
        ninja,
        backend:
            requestedBackend ?? (dawnInstalled ? "BOTH" : "SDL_GPU"),
    };
    return sharedBuildSetup;
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
 * `comparePayload` decides what an orphan is, so the prune and the guard that
 * reports one cannot disagree about it.
 */
function pruneDeployedOrphans(scene: (typeof scenes)[number]): void {
    for (const { source, deployed } of deployedPayloads(
        resolve(scene.buildDirectory),
        resolve(scene.output),
    )) {
        for (const mismatch of comparePayload(source, deployed)) {
            if (mismatch.reason !== "unexpected") continue;
            rmSync(resolve(deployed, mismatch.path), { force: true });
        }
    }
}

async function runSceneBuild(
    scene: (typeof scenes)[number],
    jobsPerScene: number | undefined,
    captureOutput: boolean,
): Promise<void> {
    const { generator, ninja, backend } = buildSetup();
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
    configureArguments.push(`-DBBLITE_BACKEND=${backend}`);
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
    if (ninja) {
        configureArguments.push(
            `-DCMAKE_MAKE_PROGRAM=${ninja.ninja}`,
        );
    }
    const vcpkgRoot = process.env.VCPKG_ROOT;
    if (vcpkgRoot) {
        configureArguments.push(
            `-DCMAKE_TOOLCHAIN_FILE=${join(
                vcpkgRoot,
                "scripts",
                "buildsystems",
                "vcpkg.cmake",
            )}`,
        );
    }
    const environment = ninja?.environment ?? process.env;
    // Configure only when the cache does not already hold exactly what
    // this invocation would set. The generator re-runs CMake itself when
    // CMakeLists.txt or features.cmake change, so a matching cache means
    // the configure step has nothing to do -- but a changed BBLITE_BACKEND
    // or generated directory has to reconfigure, or the build would
    // silently produce the previous configuration.
    const cmake = process.env.CMAKE_COMMAND ?? "cmake";
    const output: string[] = [];
    try {
        if (
            !cacheMatchesConfiguration(
                scene.buildDirectory,
                configureArguments,
            )
        ) {
            await serializeConfigure(() =>
                runAsync(
                    cmake,
                    configureArguments,
                    environment,
                    captureOutput ? output : undefined,
                ),
            );
        }
        pruneDeployedOrphans(scene);
        await runAsync(
            cmake,
            [
                "--build",
                scene.buildDirectory,
                "--config",
                "Release",
                "--parallel",
                // Without a count ninja takes the whole machine, which is
                // wrong once scenes run beside each other.
                ...(jobsPerScene === undefined
                    ? []
                    : [String(jobsPerScene)]),
            ],
            environment,
            captureOutput ? output : undefined,
        );
    } finally {
        if (captureOutput && output.length > 0) {
            process.stdout.write(
                `--- ${scene.id}\n${output.join("")}`,
            );
        }
    }
}

function compileShaders(sceneId?: string): void {
    const arguments_ = ["-File", "tools/compile-shaders.ps1"];
    if (sceneId) arguments_.push("-Scene", sceneId);
    run(process.platform === "win32" ? "pwsh.exe" : "pwsh", arguments_);
}

async function processScene(idOrSource: string): Promise<void> {
    if (idOrSource === "all") {
        await compile("all");
        compileShaders();
        await buildScenes(scenes);
        return;
    }
    await compile(idOrSource);
    compileShaders(resolveScene(idOrSource).id);
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
): Promise<void> {
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
        ["sdl_gpu", "dawn"],
        "diff",
    );
    const token = backendFileToken(backend);
    const captureDirectory = resolve(
        parsed.values.get("--capture") ??
            defaultCaptureDirectory(scene.id),
    );
    const recapture = parsed.flags.has("--recapture");
    const seek = flagNumber(parsed, "--seek", "diff");
    // The effective seek is what the capture modules themselves resolve:
    // the explicit flag, else the registry pose. A capture on disk is only
    // reusable when it was taken at this pose — diffing across poses is the
    // stale-evidence class this command exists to prevent.
    const wantSeek =
        seek ?? scene.parity?.referenceTimeSeconds ?? null;
    const recordedSeek = (metaPath: string): number | null | undefined => {
        // `null` = captured with no seek; `undefined` = no provenance (a
        // pre-meta capture), which reads as unknown and forces a recapture.
        if (!existsSync(metaPath)) return undefined;
        try {
            const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
                seekSeconds?: number | null;
            };
            return meta.seekSeconds ?? null;
        } catch {
            return undefined;
        }
    };
    const browserReason = !existsSync(captureBuffersPath(captureDirectory))
        ? "missing"
        : recordedSeek(captureMetaPath(captureDirectory)) !==
                wantSeek
            ? "was captured at a different seek (or carries no provenance)"
            : undefined;
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
    // The current filename token first; the pre-token `native-sdl_gpu.*`
    // spelling is accepted for one transition so captures taken before
    // the rename stay reusable. A recapture always writes the current
    // spelling. Both spellings come from the one shared helper the
    // native-capture writer uses, so reader and writer cannot drift.
    const currentPaths = captureNativePaths(captureDirectory, token);
    const legacyPaths = captureNativePaths(captureDirectory, backend);
    const nativePaths =
        !existsSync(currentPaths.capture) &&
        legacyPaths.capture !== currentPaths.capture &&
        existsSync(legacyPaths.capture)
            ? legacyPaths
            : currentPaths;
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
        if (recordedSeek(nativePaths.meta) !== wantSeek) {
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
    const frameRate = scene.parity?.referenceFrameRate ?? 60;
    const plan = seekBracketPlan(
        explicitSeek ?? scene.parity?.referenceTimeSeconds,
        frameRate,
    );
    const captureDirectory = resolve(
        outputDirectory ?? defaultCaptureDirectory(scene.id),
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
 * Dawn-only by construction: SDL_GPU consumes the offline `.dxil`/`.spv`
 * beside the WGSL, which only `tools/compile-shaders.ps1` refreshes, so
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
        canonicalBackend(backendFlag, ["sdl_gpu", "dawn"], "probe-variants") !==
            "dawn"
    ) {
        throw new Error(
            "probe-variants: the probe is Dawn-only — Dawn compiles the deployed " +
                ".native.wgsl at startup, while SDL_GPU consumes the offline .dxil/.spv " +
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
    const previousOverride = process.env.BBLITE_GPU_SHADER_DIR;
    let after: NativeCaptureResult;
    try {
        writeFileSync(shaderPath, edited);
        // The deliberate edit would (rightly) fail the deployed-payload
        // staleness check. Naming the deployed directory as the explicit
        // shader dir routes the runtime to the same files while telling
        // that check this run's shader payload is chosen on purpose; the
        // executable's build-stamp identity check still runs.
        process.env.BBLITE_GPU_SHADER_DIR = resolve(deployedDirectory);
        after = runNativeCapture(idOrSource, {
            backend: "dawn",
            ...(seek !== undefined ? { seekSeconds: seek } : {}),
            outputDirectory: join(probeDirectory, "after"),
        });
    } finally {
        if (previousOverride === undefined) {
            delete process.env.BBLITE_GPU_SHADER_DIR;
        } else {
            process.env.BBLITE_GPU_SHADER_DIR = previousOverride;
        }
        rmSync(deployedDirectory, { recursive: true, force: true });
        renameSync(backupDirectory, deployedDirectory);
        console.log(`Deployed shaders restored: ${deployedDirectory}`);
    }
    const beforeMeasurement = measurePng(before.screenshotPath);
    const afterMeasurement = measurePng(after.screenshotPath);
    const delta = compareImages(after.screenshotPath, before.screenshotPath);
    const goldenPath = scene.parity
        ? resolve(scene.parity.reference.path)
        : undefined;
    const golden =
        goldenPath !== undefined && existsSync(goldenPath)
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
    const differential = buildSetup().backend === "BOTH";
    const stages: Array<{ name: string; body: () => Promise<void> }> = [
        { name: "compile", body: () => compile(idOrSource) },
        {
            name: "shaders",
            body: async () => compileShaders(scene?.id),
        },
        { name: "build", body: () => build(idOrSource) },
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

async function main(): Promise<void> {
    const [command, id, ...rest] = process.argv.slice(2);
    // Every `npm run scene` runs `npm run build` first, so any build started
    // while this one is working deletes the `dist/` it is executing from.
    // `tools/clean-dist.mjs` refuses to cross this lock.
    holdDistLock([command, id].filter(Boolean).join(" "));
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
        parseFlags(rest, {}, "compile");
        await compile(id);
        return;
    }
    if (command === "build" && id) {
        parseFlags(rest, { boolean: ["--cold"] }, "build");
        await withColdBuild(rest, () => build(id));
        return;
    }
    if (command === "process" && id) {
        parseFlags(rest, { boolean: ["--cold"] }, "process");
        await withColdBuild(rest, () => processScene(id));
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
                value: ["--backend", "--seek"],
                boolean: ["--recapture-reference"],
            },
            "geometry",
        );
        const backend = parsed.values.get("--backend");
        const seek = flagNumber(parsed, "--seek", "geometry");
        await runGeometryOutputDiagnostics(id, {
            recaptureReference: parsed.flags.has("--recapture-reference"),
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
        const decoded = decodeCapturedUniforms(directory, {
            ...(sizes !== undefined
                ? { sizes: sizes.split(",").map((value) => Number(value)) }
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
                ["sdl_gpu", "dawn"],
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
        await runComposeReport(id, scenes, resolveScene, captureDirectory);
        return;
    }
    if (command === "stability" && id) {
        runStabilityReport(id, parseStabilityArguments(rest));
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
        "Usage: scene-command <list | show <id|source.ts> | " +
            "compile|build|process|parity|compose|validate <id|source.ts|all> [options] | " +
            "geometry|capture|uniforms|diff|stability <id|source.ts> [options] | " +
            "probe-variants <id|source.ts> --shader <name> (--term <text> --with <replacement> | --replace-file <path>) | " +
            "measure <image.png> [--background r,g,b] | " +
            "neutrality <baseline-parity-directory> | " +
            "neutrality-generated <baseline.txt> [--write] (digests generated/ as it stands; compile first)>",
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
