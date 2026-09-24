import { randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    discoverDevelopmentTools,
    discoverWindowsBuildTools,
    type WindowsBuildTools,
} from "./development-tools.js";
import {
    developmentTriplet,
    hostOfflineShaderTarget,
} from "./build-options.js";
import { holdDistLock } from "./dist-lock.js";
import { applicationScenes, type SceneDefinition } from "./scene-registry.js";
import { runConcurrently } from "./run-concurrently.js";
import { flagNumber, isMainModule, parseFlags } from "./tooling/flags.js";
import {
    installVcpkgManifest,
    type VcpkgManifestInstall,
} from "./vcpkg-install.js";
import { writeJsonRecord } from "./tooling/records.js";
import { runLoggedProcess } from "./tooling/logged-process.js";

export type ShippingPlatform = "win32" | "linux" | "darwin";

export function shippingPlatform(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): ShippingPlatform {
    if (
        (platform !== "win32" &&
            platform !== "linux" &&
            platform !== "darwin") ||
        (arch !== "x64" && !(platform === "darwin" && arch === "arm64"))
    ) {
        throw new Error(
            "Minimal demo shipping supports Windows/Linux x64 and macOS x64/arm64 hosts.",
        );
    }
    return platform;
}

export interface ShippingFeatures {
    features: string[];
    codecs: string[];
    runtime: string[];
}

export function readShippingFeatures(text: string): ShippingFeatures {
    const values = new Map(
        text
            .trim()
            .split(/\r?\n/)
            .map((line) => {
                const split = line.indexOf("=");
                if (split < 0)
                    throw new Error(
                        "Malformed shipping profile; regenerate it.",
                    );
                return [line.slice(0, split), line.slice(split + 1)] as const;
            }),
    );
    const list = (key: string): string[] => {
        const value = values.get(key);
        if (
            value === undefined ||
            (value !== "" && !/^[a-z0-9:-]+(?:;[a-z0-9:-]+)*$/.test(value))
        ) {
            throw new Error(`Invalid shipping profile ${key}.`);
        }
        return [...new Set(value === "" ? [] : value.split(";"))].sort();
    };
    return {
        features: list("features"),
        codecs: list("codecs"),
        runtime: list("runtime"),
    };
}

export function selectShippingScenes(
    selection: string | undefined,
): readonly SceneDefinition[] {
    if (selection === undefined || selection === "all")
        return applicationScenes;
    const ids = selection.split(",");
    if (new Set(ids).size !== ids.length)
        throw new Error("Duplicate shipping scene.");
    return ids.map((id) => {
        const scene = applicationScenes.find((scene) => scene.id === id);
        if (!scene)
            throw new Error(
                `Unknown application demo '${id}'. Use --scene all or registered application IDs.`,
            );
        return scene;
    });
}

export interface ShippingScene extends ShippingFeatures {
    id: string;
    platform: ShippingPlatform;
    macArchitecture?: "x86_64" | "arm64" | undefined;
    triplet: string;
    name: string;
    output: string;
    buildDirectory: string;
    sdlDirectory: string;
    labSoundDirectory: string;
    rmlUiDirectory: string;
    installedDirectory: string;
}

export function shippingPlan(
    root: string,
    inputs: readonly { scene: SceneDefinition; reached: ShippingFeatures }[],
    installRoot = resolve(root, "artifacts/vcpkg-installed"),
    platform: ShippingPlatform = shippingPlatform(),
): { scenes: ShippingScene[]; profiles: VcpkgManifestInstall[] } {
    const profiles = new Map<string, VcpkgManifestInstall>();
    const architectures =
        platform === "darwin" ? (["x86_64", "arm64"] as const) : [undefined];
    const scenes = inputs.flatMap(({ scene, reached }) =>
        architectures.map((macArchitecture) => {
            const triplet =
                platform === "win32"
                    ? "x64-windows-static"
                    : developmentTriplet(
                          platform,
                          macArchitecture === "arm64" ? "arm64" : "x64",
                      );
            const suffix = macArchitecture ? `-${macArchitecture}` : "";
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.id))
                throw new Error(`Invalid shipping scene ID '${scene.id}'.`);
            const codecs = [...reached.codecs].sort();
            // SDL_image's static registry pulls every enabled decoder into consumers.
            // Other manifest features may share an install only within this codec set.
            const installedDirectory = resolve(
                installRoot,
                `shipping-demo-${codecs.join("-") || "core"}${suffix}`,
            );
            const previous = profiles.get(installedDirectory);
            profiles.set(installedDirectory, {
                installedDirectory,
                triplet,
                features: [
                    ...new Set([
                        ...(previous?.features ?? []),
                        ...reached.features,
                    ]),
                ].sort(),
            });
            const has = (feature: string): boolean =>
                reached.runtime.includes(feature);
            const sdl = [
                has("audio:engine") ? "audio" : "",
                has("input:gamepad") ? "gamepad" : "",
            ].filter(Boolean);
            return {
                ...reached,
                id: scene.id,
                name: scene.name,
                platform,
                macArchitecture,
                triplet,
                output: resolve(root, scene.output),
                buildDirectory: resolve(
                    root,
                    `native/build-${scene.id}-min-sdl${suffix}`,
                ),
                installedDirectory,
                sdlDirectory: resolve(
                    root,
                    `artifacts/tools/sdl-min${sdl.length ? `-${sdl.join("-")}` : ""}${suffix}`,
                ),
                labSoundDirectory: resolve(
                    root,
                    `artifacts/tools/labsound-static${has("audio:decoded-buffer") ? "-codecs" : ""}${suffix}`,
                ),
                rmlUiDirectory: resolve(
                    root,
                    `artifacts/tools/rmlui-static${has("ui:inline-svg") ? "-svg" : ""}${suffix}`,
                ),
            };
        }),
    );
    return { scenes, profiles: [...profiles.values()] };
}

export function shippingConfigureArguments(
    root: string,
    scene: ShippingScene,
    toolchain: Pick<WindowsBuildTools, "compiler" | "ninja">,
    vcpkgToolchain: string,
): string[] {
    return [
        "--fresh",
        "-S",
        resolve(root, "native"),
        "-B",
        scene.buildDirectory,
        "-G",
        "Ninja",
        `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`,
        `-DCMAKE_CXX_COMPILER=${toolchain.compiler}`,
        "-DCMAKE_BUILD_TYPE=Release",
        ...(scene.macArchitecture
            ? [`-DCMAKE_OSX_ARCHITECTURES=${scene.macArchitecture}`]
            : []),
        ...(scene.platform === "win32"
            ? ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]
            : ["-DCMAKE_SKIP_RPATH=ON"]),
        `-DCMAKE_TOOLCHAIN_FILE=${vcpkgToolchain}`,
        `-DVCPKG_TARGET_TRIPLET=${scene.triplet}`,
        "-DVCPKG_MANIFEST_INSTALL=OFF",
        `-DVCPKG_INSTALLED_DIR=${scene.installedDirectory}`,
        "-DBBLITE_MINSIZE=ON",
        "-DBBLITE_BACKEND=SDL_GPU",
        "-DBBLITE_PCH=OFF",
        "-DBBLITE_VISUAL_CAPTURE=OFF",
        "-DBBLITE_AUDIO_CAPTURE=OFF",
        `-DBBLITE_GENERATED_DIR=${scene.output}`,
        `-DBBLITE_SDL_DIR=${scene.sdlDirectory}`,
        `-DBBLITE_LABSOUND_DIR=${scene.labSoundDirectory}`,
        `-DBBLITE_RMLUI_DIR=${scene.rmlUiDirectory}`,
    ];
}

/** Configure clears cached package paths; obsolete deployed payload is moved aside
 * separately because CMake's deployment merges directories. Objects remain cached. */
export function preserveShippingPayload(
    root: string,
    sceneId: string,
    macArchitecture?: "x86_64" | "arm64",
): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sceneId))
        throw new Error(`Invalid shipping scene ID '${sceneId}'.`);
    if (
        macArchitecture !== undefined &&
        !["x86_64", "arm64"].includes(macArchitecture)
    )
        throw new Error("Invalid macOS architecture.");
    const native = resolve(root, "native");
    const buildDirectory = resolve(
        native,
        `build-${sceneId}-min-sdl${macArchitecture ? `-${macArchitecture}` : ""}`,
    );
    for (const ancestor of [native, buildDirectory]) {
        if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
            throw new Error(`Shipping build path crosses a link: ${ancestor}`);
    }
    if (!existsSync(buildDirectory)) return;
    const obsolete = readdirSync(buildDirectory).filter(
        (name) =>
            ["assets", "shaders", "bblite-shaders-deployed.stamp"].includes(
                name,
            ) || name.toLowerCase().endsWith(".dll"),
    );
    if (!obsolete.length) return;
    for (const name of obsolete) {
        if (lstatSync(join(buildDirectory, name)).isSymbolicLink())
            throw new Error(`Shipping payload crosses a link: ${name}`);
    }
    const previous = join(buildDirectory, `.payload-${randomUUID()}`);
    mkdirSync(previous);
    for (const name of obsolete)
        renameSync(join(buildDirectory, name), join(previous, name));
}

interface PackageSize {
    scene: string;
    exeBytes: number;
    zipBytes: number;
    previousExeBytes: number | null;
    previousZipBytes: number | null;
}

export function packageSizeReport(
    receipts: readonly PackageSize[],
    platform: ShippingPlatform = shippingPlatform(),
): string {
    const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(2);
    const delta = (current: number, previous: number | null): string =>
        previous === null
            ? "New"
            : `${current >= previous ? "+" : ""}${mib(current - previous)} MiB${previous > 0 ? ` (${((current / previous - 1) * 100).toFixed(1)}%)` : ""}`;
    return [
        "# Minimal application packages",
        "",
        platform === "win32"
            ? "Windows x64, MSVC, static CRT, SDL_GPU / Direct3D 12, BBLITE_MINSIZE. Capture is disabled."
            : `${platform === "darwin" ? "macOS universal (x86_64 + arm64), SDL_GPU / Metal" : "Linux x64, SDL_GPU / Vulkan"}, static project libraries, BBLITE_MINSIZE. Capture is disabled.`,
        "",
        "Each package passed its five-frame GPU-validation startup check. Previous packages are retained under `.replaced/`; exact bytes and SHA-256 hashes are in the package JSON receipts.",
        "",
        "Changes compare with the packages replaced by this run; any separate `@previous/` comparison baseline remains untouched.",
        "",
        "| Demo | EXE MiB | EXE change | ZIP MiB | ZIP change |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...receipts.map(
            (row) =>
                `| ${row.scene} | ${mib(row.exeBytes)} | ${delta(row.exeBytes, row.previousExeBytes)} | ${mib(row.zipBytes)} | ${delta(row.zipBytes, row.previousZipBytes)} |`,
        ),
        "",
        "Sizes use MiB (1,048,576 bytes). Growth is reported without an exemption; startup checks do not establish gameplay fidelity.",
        "",
    ].join("\n");
}

function readPackageSize(path: string): PackageSize {
    const value: unknown = JSON.parse(
        readFileSync(path, "utf8").replace(/^\uFEFF/, ""),
    );
    if (
        typeof value !== "object" ||
        value === null ||
        !("scene" in value) ||
        typeof value.scene !== "string" ||
        !("exeBytes" in value) ||
        typeof value.exeBytes !== "number" ||
        !("zipBytes" in value) ||
        typeof value.zipBytes !== "number" ||
        !("previousExeBytes" in value) ||
        (typeof value.previousExeBytes !== "number" &&
            value.previousExeBytes !== null) ||
        !("previousZipBytes" in value) ||
        (typeof value.previousZipBytes !== "number" &&
            value.previousZipBytes !== null)
    ) {
        throw new Error(`Invalid package size receipt: ${path}`);
    }
    return {
        scene: value.scene,
        exeBytes: value.exeBytes,
        zipBytes: value.zipBytes,
        previousExeBytes: value.previousExeBytes,
        previousZipBytes: value.previousZipBytes,
    };
}

async function main(): Promise<void> {
    const flags = parseFlags(
        process.argv.slice(2),
        {
            value: [
                "--scene",
                "--output",
                "--workers",
                "--jobs",
                "--platform",
                "--sdk",
                "--device",
                "--abi",
                "--backend",
            ],
            boolean: ["--plan", "--help"],
        },
        "shipping-demos",
    );
    if (flags.flags.has("--help")) {
        console.log(
            "npm run demos:release -- [--scene all|id,id] [--output directory] [--workers N] [--jobs N] [--plan]\nAndroid: --platform android --sdk directory --device serial [--abi arm64-v8a|x86_64] [--backend sdl_gpu|dawn].\niOS: --platform ios on macOS with DEVELOPER_DIR selecting Xcode/iOS SDK 16.4+. Produces unsigned, trimmed ARM64 iPhone/iPad SDL_GPU bundles; no device startup qualification.\nMobile packages run sequentially (--workers 1).\n--plan generates the selected scenes (skipped when current) and describes the packages without building dependencies or packaging.",
        );
        return;
    }
    const requestedPlatform = flags.values.get("--platform") ?? "host";
    if (
        requestedPlatform !== "host" &&
        requestedPlatform !== "android" &&
        requestedPlatform !== "ios"
    )
        throw new Error("--platform must be host, android or ios.");
    if (requestedPlatform !== "host") {
        const { runMobilePackages } = await import("./shipping-mobile.js");
        await runMobilePackages(
            requestedPlatform,
            selectShippingScenes(flags.values.get("--scene")),
            flags.values,
            flags.flags.has("--plan"),
        );
        return;
    }
    if (flags.values.has("--backend"))
        throw new Error(
            "--backend selects Android packages; host shipping uses SDL_GPU.",
        );
    const platform = shippingPlatform();
    const positive = (name: string, fallback: number): number => {
        const value = flagNumber(flags, name, "shipping-demos") ?? fallback;
        if (!Number.isInteger(value) || value < 1)
            throw new Error(`${name} must be a positive integer.`);
        return value;
    };
    const selected = selectShippingScenes(flags.values.get("--scene"));
    const budget = Math.max(
        1,
        Math.floor(Math.min(availableParallelism(), totalmem() / 2e9)),
    );
    const workers = positive(
        "--workers",
        Math.max(
            1,
            Math.min(
                selected.length,
                6,
                Math.floor(budget / positive("--jobs", 1)),
            ),
        ),
    );
    const jobs = positive("--jobs", Math.max(1, Math.floor(budget / workers)));
    const root = process.cwd();
    const output = resolve(
        root,
        flags.values.get("--output") ?? "artifacts/releases",
    );
    const tools = discoverDevelopmentTools();
    const { cmake, vcpkg, vcpkgToolchain, powershell } = tools;
    if (!cmake || !vcpkg || !vcpkgToolchain || !powershell)
        throw new Error(
            "Shipping requires CMake, vcpkg and PowerShell; run npm run doctor.",
        );
    const windows =
        platform === "win32" ? discoverWindowsBuildTools("msvc") : undefined;
    if (!windows && (!tools.cxx || !tools.ninja))
        throw new Error(
            "Unix shipping requires Clang and Ninja; run npm run doctor.",
        );
    const toolchain = windows ?? { compiler: tools.cxx!, ninja: tools.ninja! };
    holdDistLock("shipping-demos");
    const environment = {
        ...process.env,
        ...windows?.environment,
        CMAKE_COMMAND: cmake,
        VCPKG_ROOT: tools.vcpkgRoot,
        VSINSTALLDIR: windows?.visualStudioRoot,
        BBLITE_BACKEND: "SDL_GPU",
    };
    const logs = resolve(
        root,
        "artifacts/shipping",
        `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`,
    );
    mkdirSync(logs, { recursive: true });
    const results: { stage: string; id: string; exit: number; log: string }[] =
        [];
    const run = async (
        stage: string,
        id: string,
        command: string,
        args: string[],
    ): Promise<void> => {
        const log = join(logs, `${stage}-${id}.log`);
        console.log(`${stage} ${id}: running`);
        let exit = 1;
        try {
            exit = await runLoggedProcess(command, args, log, {
                cwd: root,
                env: environment,
            });
        } finally {
            results.push({ stage, id, exit, log });
            writeJsonRecord(join(logs, "results.json"), results);
        }
        if (exit !== 0)
            throw new Error(`${stage} ${id} exited ${exit}; see ${log}`);
        console.log(`${stage} ${id}: PASS`);
    };
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    // The plan reads each scene's generated features, so --plan generates too:
    // a current tree costs a stamp check, and a missing or stale one would
    // describe packages the build would not make.
    await runConcurrently(
        selected,
        workers,
        (scene) => scene.id,
        (scene) =>
            run("generate", scene.id, process.execPath, [
                join(moduleDirectory, "scene-command.js"),
                "compile",
                scene.id,
            ]),
    );
    const inputs: { scene: SceneDefinition; reached: ShippingFeatures }[] = [];
    for (const scene of selected) {
        const profilePath = join(logs, `${scene.id}.profile`);
        await run("profile", scene.id, cmake, [
            `-DBBLITE_GENERATED_DIR=${resolve(scene.output)}`,
            `-DBBLITE_PROFILE_OUTPUT=${profilePath}`,
            "-P",
            resolve("tools/shipping-profile.cmake"),
        ]);
        inputs.push({
            scene,
            reached: readShippingFeatures(readFileSync(profilePath, "utf8")),
        });
    }
    const plan = shippingPlan(
        root,
        inputs,
        resolve(
            root,
            process.env.BBLITE_VCPKG_INSTALLED_ROOT ??
                "artifacts/vcpkg-installed",
        ),
    );
    writeJsonRecord(join(logs, "plan.json"), plan);
    if (flags.flags.has("--plan")) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    for (const profile of plan.profiles)
        installVcpkgManifest(vcpkg, profile, environment);
    const prepared = new Set<string>();
    const prepare = async (
        scene: ShippingScene,
        directory: string,
        script: string,
        args: string[],
    ): Promise<void> => {
        if (prepared.has(directory)) return;
        await run("dependency", basename(directory), powershell, [
            "-NoProfile",
            "-File",
            resolve("tools", script),
            "-OutputDirectory",
            directory,
            ...(scene.macArchitecture
                ? [
                      "-MacArchitecture",
                      scene.macArchitecture,
                      "-Workspace",
                      resolve(root, ".cache/shipping", basename(directory)),
                  ]
                : []),
            ...args,
        ]);
        prepared.add(directory);
    };
    for (const scene of plan.scenes) {
        const has = (feature: string): boolean =>
            scene.runtime.includes(feature);
        await prepare(scene, scene.sdlDirectory, "build-sdl-min.ps1", [
            ...(has("audio:engine") ? ["-EnableAudio"] : []),
            ...(has("input:gamepad") ? ["-EnableGamepad"] : []),
        ]);
        if (has("audio:engine"))
            await prepare(
                scene,
                scene.labSoundDirectory,
                "build-labsound.ps1",
                [
                    platform === "win32" ? "-StaticRuntime" : "-MinSize",
                    ...(has("audio:decoded-buffer") ? ["-EnableCodecs"] : []),
                ],
            );
        if (has("ui:rml"))
            await prepare(scene, scene.rmlUiDirectory, "build-rmlui.ps1", [
                platform === "win32" ? "-StaticRuntime" : "-MinSize",
                "-FreetypeRoot",
                join(scene.installedDirectory, scene.triplet),
                ...(has("ui:inline-svg") ? ["-EnableSvg"] : []),
            ]);
    }
    const shaderLog = join(logs, "shaders-all.log");
    let shaderExit = 1;
    try {
        const {
            compileOfflineShaders,
            formatShaderCompilation,
            generatedShaderDirectories,
        } = await import("./compile-shaders.js");
        const summary = formatShaderCompilation(
            compileOfflineShaders({
                directories: [
                    ...new Set(
                        plan.scenes.flatMap((scene) =>
                            generatedShaderDirectories(root, scene.id),
                        ),
                    ),
                ],
                target: hostOfflineShaderTarget(platform),
                tools,
                environment,
            }),
        );
        writeFileSync(shaderLog, summary + "\n");
        console.log(summary);
        shaderExit = 0;
    } catch (error) {
        writeFileSync(
            shaderLog,
            error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
        );
        throw error;
    } finally {
        results.push({
            stage: "shaders",
            id: "all",
            exit: shaderExit,
            log: shaderLog,
        });
        writeJsonRecord(join(logs, "results.json"), results);
    }
    const buildId = (scene: ShippingScene): string =>
        `${scene.id}${scene.macArchitecture ? `-${scene.macArchitecture}` : ""}`;
    await runConcurrently(
        plan.scenes,
        workers,
        buildId,
        async (scene) => {
            preserveShippingPayload(root, scene.id, scene.macArchitecture);
            await run(
                "configure",
                buildId(scene),
                cmake,
                shippingConfigureArguments(
                    root,
                    scene,
                    toolchain,
                    vcpkgToolchain,
                ),
            );
            await run("build", buildId(scene), cmake, [
                "--build",
                scene.buildDirectory,
                "--config",
                "Release",
                "--parallel",
                String(jobs),
            ]);
        },
        { completed: "built" },
    );
    const receipts: PackageSize[] = [];
    for (const scene of plan.scenes.filter(
        (scene) => scene.macArchitecture !== "arm64",
    )) {
        const arm = plan.scenes.find(
            (candidate) =>
                candidate.id === scene.id &&
                candidate.macArchitecture === "arm64",
        );
        await run("package", scene.id, powershell, [
            "-NoProfile",
            "-File",
            resolve("tools/package-demo.ps1"),
            "-Scene",
            scene.id,
            "-BuildDirectory",
            scene.buildDirectory,
            ...(arm ? ["-Arm64BuildDirectory", arm.buildDirectory] : []),
            "-ExpectBackend",
            "SDL_GPU",
            "-OutputRoot",
            output,
        ]);
        receipts.push(
            readPackageSize(
                join(
                    output,
                    `bblitec-${scene.id}-sdl-gpu-${platform === "win32" ? "windows-x64" : platform === "darwin" ? "macos-universal" : "linux-x64"}.json`,
                ),
            ),
        );
    }
    const report = packageSizeReport(receipts, platform);
    const reportPath = join(output, "SIZE-COMPARISON.md");
    if (existsSync(reportPath)) {
        const previous = join(output, ".replaced", `sizes-${Date.now()}`);
        mkdirSync(previous, { recursive: true });
        renameSync(reportPath, join(previous, "SIZE-COMPARISON.md"));
    }
    writeFileSync(reportPath, report);
    console.log(`${report}\nLogs: ${logs}\nPackages: ${output}`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
