#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    runSceneParity,
    runSceneParityDifferential,
} from "./parity-scene.js";
import { runGeometryOutputDiagnostics } from "./geometry-output-diagnostics.js";
import { runInstrumentedCapture } from "./capture-instrumented.js";
import { resolveScene, scenes } from "./scene-registry.js";
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
        if (scene.parity?.attribution?.diagnostics) {
            arguments_.push("--pbr-diagnostics");
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
    const differential = extraArguments.includes("--differential");
    const passthrough = extraArguments.filter(
        (argument) => argument !== "--differential",
    );
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

async function main(): Promise<void> {
    const [command, id, ...rest] = process.argv.slice(2);
    if (command === "list") {
        for (const scene of scenes) {
            console.log(
                `${scene.id}\t${scene.name}\t${scene.source}\t${scene.buildDirectory}`,
            );
        }
        return;
    }
    if (command === "show" && id) {
        console.log(JSON.stringify(resolveScene(id), null, 2));
        return;
    }
    if (command === "compile" && id) {
        await compile(id);
        return;
    }
    if (command === "build" && id) {
        await withColdBuild(rest, () => build(id));
        return;
    }
    if (command === "process" && id) {
        await withColdBuild(rest, () => processScene(id));
        return;
    }
    if (command === "parity" && id) {
        await parity(id, rest);
        return;
    }
    if (command === "geometry" && id) {
        await runGeometryOutputDiagnostics(
            id,
            rest.includes("--recapture-reference"),
        );
        return;
    }
    if (command === "capture" && id) {
        const argument = (name: string): string | undefined => {
            const index = rest.indexOf(name);
            return index >= 0 ? rest[index + 1] : undefined;
        };
        const seek = argument("--seek");
        const skipDraw = argument("--skip-draw");
        const output = argument("--out");
        await runInstrumentedCapture(id, {
            ...(seek !== undefined
                ? { seekSeconds: Number(seek) }
                : {}),
            ...(skipDraw !== undefined
                ? { skipDrawIndexCount: Number(skipDraw) }
                : {}),
            ...(output !== undefined
                ? { outputDirectory: output }
                : {}),
        });
        return;
    }
    throw new Error(
        "Usage: scene-command <list | show <id|source.ts> | compile|build|process|parity|geometry|capture <id|source.ts|all> [options]>",
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
