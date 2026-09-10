import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDevelopmentTools, discoverWindowsBuildTools, type WindowsBuildTools } from "./development-tools.js";
import { holdDistLock } from "./dist-lock.js";
import { applicationScenes, type SceneDefinition } from "./scene-registry.js";
import { runConcurrently } from "./run-concurrently.js";
import { flagNumber, isMainModule, parseFlags } from "./tooling/flags.js";
import { installVcpkgManifest, type VcpkgManifestInstall } from "./vcpkg-install.js";
import { writeJsonRecord } from "./validation-resume.js";

export interface ShippingFeatures {
    features: string[];
    codecs: string[];
    runtime: string[];
}

export function readShippingFeatures(text: string): ShippingFeatures {
    const values = new Map(text.trim().split(/\r?\n/).map(line => {
        const split = line.indexOf("=");
        if (split < 0) throw new Error("Malformed shipping profile; regenerate it.");
        return [line.slice(0, split), line.slice(split + 1)] as const;
    }));
    const list = (key: string): string[] => {
        const value = values.get(key);
        if (value === undefined || (value !== "" && !/^[a-z0-9:-]+(?:;[a-z0-9:-]+)*$/.test(value))) {
            throw new Error(`Invalid shipping profile ${key}.`);
        }
        return [...new Set(value === "" ? [] : value.split(";"))].sort();
    };
    return { features: list("features"), codecs: list("codecs"), runtime: list("runtime") };
}

export function selectShippingScenes(selection: string | undefined): readonly SceneDefinition[] {
    if (selection === undefined || selection === "all") return applicationScenes;
    const ids = selection.split(",");
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate shipping scene.");
    return ids.map(id => {
        const scene = applicationScenes.find(scene => scene.id === id);
        if (!scene) throw new Error(`Unknown application demo '${id}'. Use --scene all or registered application IDs.`);
        return scene;
    });
}

export interface ShippingScene extends ShippingFeatures {
    id: string;
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
): { scenes: ShippingScene[]; profiles: VcpkgManifestInstall[] } {
    const profiles = new Map<string, VcpkgManifestInstall>();
    const scenes = inputs.map(({ scene, reached }) => {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.id)) throw new Error(`Invalid shipping scene ID '${scene.id}'.`);
        const codecs = [...reached.codecs].sort();
        // SDL_image's static registry pulls every enabled decoder into consumers.
        // Other manifest features may share an install only within this codec set.
        const installedDirectory = resolve(installRoot, `shipping-demo-${codecs.join("-") || "core"}`);
        const previous = profiles.get(installedDirectory);
        profiles.set(installedDirectory, {
            installedDirectory, triplet: "x64-windows-static",
            features: [...new Set([...(previous?.features ?? []), ...reached.features])].sort(),
        });
        const has = (feature: string): boolean => reached.runtime.includes(feature);
        const sdl = [has("audio:engine") ? "audio" : "", has("input:gamepad") ? "gamepad" : ""].filter(Boolean);
        return {
            ...reached, id: scene.id, name: scene.name,
            output: resolve(root, scene.output),
            buildDirectory: resolve(root, `native/build-${scene.id}-min-sdl`),
            installedDirectory,
            sdlDirectory: resolve(root, `artifacts/tools/sdl-min${sdl.length ? `-${sdl.join("-")}` : ""}`),
            labSoundDirectory: resolve(root, `artifacts/tools/labsound-static${has("audio:decoded-buffer") ? "-codecs" : ""}`),
            rmlUiDirectory: resolve(root, `artifacts/tools/rmlui-static${has("ui:inline-svg") ? "-svg" : ""}`),
        };
    });
    return { scenes, profiles: [...profiles.values()] };
}

export function shippingConfigureArguments(root: string, scene: ShippingScene, toolchain: WindowsBuildTools, vcpkgToolchain: string): string[] {
    return [
        "--fresh", "-S", resolve(root, "native"), "-B", scene.buildDirectory, "-G", "Ninja",
        `-DCMAKE_MAKE_PROGRAM=${toolchain.ninja}`, `-DCMAKE_CXX_COMPILER=${toolchain.compiler}`,
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
        `-DCMAKE_TOOLCHAIN_FILE=${vcpkgToolchain}`, "-DVCPKG_TARGET_TRIPLET=x64-windows-static",
        "-DVCPKG_MANIFEST_INSTALL=OFF", `-DVCPKG_INSTALLED_DIR=${scene.installedDirectory}`,
        "-DBBLITE_MINSIZE=ON", "-DBBLITE_BACKEND=SDL_GPU", "-DBBLITE_PCH=OFF",
        "-DBBLITE_VISUAL_CAPTURE=OFF", "-DBBLITE_AUDIO_CAPTURE=OFF",
        `-DBBLITE_GENERATED_DIR=${scene.output}`, `-DBBLITE_SDL_DIR=${scene.sdlDirectory}`,
        `-DBBLITE_LABSOUND_DIR=${scene.labSoundDirectory}`, `-DBBLITE_RMLUI_DIR=${scene.rmlUiDirectory}`,
    ];
}

/** Configure clears cached package paths; obsolete deployed payload is moved aside
 * separately because CMake's deployment merges directories. Objects remain cached. */
export function preserveShippingPayload(root: string, sceneId: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sceneId)) throw new Error(`Invalid shipping scene ID '${sceneId}'.`);
    const native = resolve(root, "native");
    const buildDirectory = resolve(native, `build-${sceneId}-min-sdl`);
    for (const ancestor of [native, buildDirectory]) {
        if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error(`Shipping build path crosses a link: ${ancestor}`);
    }
    if (!existsSync(buildDirectory)) return;
    const obsolete = readdirSync(buildDirectory).filter(name =>
        ["assets", "shaders", "bblite-shaders-deployed.stamp"].includes(name) || name.toLowerCase().endsWith(".dll"));
    if (!obsolete.length) return;
    for (const name of obsolete) {
        if (lstatSync(join(buildDirectory, name)).isSymbolicLink()) throw new Error(`Shipping payload crosses a link: ${name}`);
    }
    const previous = join(buildDirectory, `.payload-${randomUUID()}`);
    mkdirSync(previous);
    for (const name of obsolete) renameSync(join(buildDirectory, name), join(previous, name));
}

interface PackageSize {
    scene: string;
    exeBytes: number;
    zipBytes: number;
    previousExeBytes: number | null;
    previousZipBytes: number | null;
}

export function packageSizeReport(receipts: readonly PackageSize[]): string {
    const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(2);
    const delta = (current: number, previous: number | null): string => previous === null ? "New" :
        `${current >= previous ? "+" : ""}${mib(current - previous)} MiB${previous > 0 ? ` (${((current / previous - 1) * 100).toFixed(1)}%)` : ""}`;
    return [
        "# Minimal application packages", "",
        "Windows x64, MSVC, static CRT, SDL_GPU / Direct3D 12, BBLITE_MINSIZE. Capture is disabled.", "",
        "Each package passed its five-frame GPU-validation startup check. Previous packages are retained under `.replaced/`; exact bytes and SHA-256 hashes are in the package JSON receipts.", "",
        "Changes compare with the packages replaced by this run; any separate `@previous/` comparison baseline remains untouched.", "",
        "| Demo | EXE MiB | EXE change | ZIP MiB | ZIP change |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...receipts.map(row => `| ${row.scene} | ${mib(row.exeBytes)} | ${delta(row.exeBytes, row.previousExeBytes)} | ${mib(row.zipBytes)} | ${delta(row.zipBytes, row.previousZipBytes)} |`), "",
        "Sizes use MiB (1,048,576 bytes). Growth is reported without an exemption; startup checks do not establish gameplay fidelity.", "",
    ].join("\n");
}

function readPackageSize(path: string): PackageSize {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (typeof value !== "object" || value === null ||
        !("scene" in value) || typeof value.scene !== "string" ||
        !("exeBytes" in value) || typeof value.exeBytes !== "number" ||
        !("zipBytes" in value) || typeof value.zipBytes !== "number" ||
        !("previousExeBytes" in value) || (typeof value.previousExeBytes !== "number" && value.previousExeBytes !== null) ||
        !("previousZipBytes" in value) || (typeof value.previousZipBytes !== "number" && value.previousZipBytes !== null)) {
        throw new Error(`Invalid package size receipt: ${path}`);
    }
    return { scene: value.scene, exeBytes: value.exeBytes, zipBytes: value.zipBytes,
        previousExeBytes: value.previousExeBytes, previousZipBytes: value.previousZipBytes };
}

async function main(): Promise<void> {
    const flags = parseFlags(process.argv.slice(2), {
        value: ["--scene", "--output", "--workers", "--jobs"], boolean: ["--plan", "--help"],
    }, "shipping-demos");
    if (flags.flags.has("--help")) {
        console.log("npm run demos:release -- [--scene all|id,id] [--output directory] [--workers N] [--jobs N] [--plan]\n--plan reads existing generated features without building or packaging.");
        return;
    }
    if (process.platform !== "win32") throw new Error("Minimal demo shipping currently requires Windows x64 and MSVC.");
    const positive = (name: string, fallback: number): number => {
        const value = flagNumber(flags, name, "shipping-demos") ?? fallback;
        if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
        return value;
    };
    const selected = selectShippingScenes(flags.values.get("--scene"));
    const budget = Math.max(1, Math.floor(Math.min(availableParallelism(), totalmem() / 2e9)));
    const workers = positive("--workers", Math.max(1, Math.min(selected.length, 6, Math.floor(budget / positive("--jobs", 1)))));
    const jobs = positive("--jobs", Math.max(1, Math.floor(budget / workers)));
    const root = process.cwd();
    const output = resolve(root, flags.values.get("--output") ?? "artifacts/releases");
    const tools = discoverDevelopmentTools();
    const { cmake, vcpkg, vcpkgToolchain, powershell } = tools;
    if (!cmake || !vcpkg || !vcpkgToolchain || !powershell) throw new Error("Shipping requires CMake, vcpkg and PowerShell; run npm run doctor.");
    const toolchain = discoverWindowsBuildTools("msvc");
    holdDistLock("shipping-demos");
    const environment = { ...process.env, ...toolchain.environment,
        CMAKE_COMMAND: cmake, VCPKG_ROOT: tools.vcpkgRoot,
        VSINSTALLDIR: toolchain.visualStudioRoot, BBLITE_BACKEND: "SDL_GPU" };
    const logs = resolve(root, "artifacts/shipping", `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`);
    mkdirSync(logs, { recursive: true });
    const results: { stage: string; id: string; exit: number; log: string }[] = [];
    const run = async (stage: string, id: string, command: string, args: string[]): Promise<void> => {
        const log = join(logs, `${stage}-${id}.log`);
        const fd = openSync(log, "w");
        console.log(`${stage} ${id}: running`);
        let exit = 1;
        try {
            exit = await new Promise<number>((done, fail) => {
                const child = spawn(command, args, { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", fd, fd] });
                child.once("error", fail);
                child.once("close", code => done(code ?? 1));
            });
        } finally {
            closeSync(fd);
            results.push({ stage, id, exit, log });
            writeJsonRecord(join(logs, "results.json"), results);
        }
        if (exit !== 0) throw new Error(`${stage} ${id} exited ${exit}; see ${log}`);
        console.log(`${stage} ${id}: PASS`);
    };
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    if (!flags.flags.has("--plan")) {
        await runConcurrently(selected, workers, scene => scene.id, scene => run("generate", scene.id, process.execPath,
            [join(moduleDirectory, "scene-command.js"), "compile", scene.id]));
    }
    const inputs: { scene: SceneDefinition; reached: ShippingFeatures }[] = [];
    for (const scene of selected) {
        const profilePath = join(logs, `${scene.id}.profile`);
        await run("profile", scene.id, cmake, [`-DBBLITE_GENERATED_DIR=${resolve(scene.output)}`,
            `-DBBLITE_PROFILE_OUTPUT=${profilePath}`, "-P", resolve("tools/shipping-profile.cmake")]);
        inputs.push({ scene, reached: readShippingFeatures(readFileSync(profilePath, "utf8")) });
    }
    const plan = shippingPlan(root, inputs, resolve(root, process.env.BBLITE_VCPKG_INSTALLED_ROOT ?? "artifacts/vcpkg-installed"));
    writeJsonRecord(join(logs, "plan.json"), plan);
    if (flags.flags.has("--plan")) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    for (const profile of plan.profiles) installVcpkgManifest(vcpkg, profile, environment);
    const prepared = new Set<string>();
    const prepare = async (directory: string, script: string, args: string[]): Promise<void> => {
        if (prepared.has(directory)) return;
        await run("dependency", basename(directory), powershell,
            ["-NoProfile", "-File", resolve("tools", script), "-OutputDirectory", directory, ...args]);
        prepared.add(directory);
    };
    for (const scene of plan.scenes) {
        const has = (feature: string): boolean => scene.runtime.includes(feature);
        await prepare(scene.sdlDirectory, "build-sdl-min.ps1", [
            ...(has("audio:engine") ? ["-EnableAudio"] : []), ...(has("input:gamepad") ? ["-EnableGamepad"] : []),
        ]);
        if (has("audio:engine")) await prepare(scene.labSoundDirectory, "build-labsound.ps1", [
            "-StaticRuntime", ...(has("audio:decoded-buffer") ? ["-EnableCodecs"] : []),
        ]);
        if (has("ui:rml")) await prepare(scene.rmlUiDirectory, "build-rmlui.ps1", [
            "-StaticRuntime", "-FreetypeRoot", join(scene.installedDirectory, "x64-windows-static"),
            ...(has("ui:inline-svg") ? ["-EnableSvg"] : []),
        ]);
    }
    const shaderLog = join(logs, "shaders-all.log");
    let shaderExit = 1;
    try {
        const { compileOfflineShaders, formatShaderCompilation, generatedShaderDirectories } = await import("./compile-shaders.js");
        const summary = formatShaderCompilation(compileOfflineShaders({
            directories: [...new Set(plan.scenes.flatMap(scene => generatedShaderDirectories(root, scene.id)))],
            target: "d3d12", tools, environment,
        }));
        writeFileSync(shaderLog, summary + "\n");
        console.log(summary);
        shaderExit = 0;
    } catch (error) {
        writeFileSync(shaderLog, error instanceof Error ? error.stack ?? error.message : String(error));
        throw error;
    } finally {
        results.push({ stage: "shaders", id: "all", exit: shaderExit, log: shaderLog });
        writeJsonRecord(join(logs, "results.json"), results);
    }
    await runConcurrently(plan.scenes, workers, scene => scene.id, async scene => {
        preserveShippingPayload(root, scene.id);
        await run("configure", scene.id, cmake, shippingConfigureArguments(root, scene, toolchain, vcpkgToolchain));
        await run("build", scene.id, cmake, ["--build", scene.buildDirectory, "--config", "Release", "--parallel", String(jobs)]);
    }, { completed: "built" });
    const receipts: PackageSize[] = [];
    for (const scene of plan.scenes) {
        await run("package", scene.id, powershell, ["-NoProfile", "-File", resolve("tools/package-demo.ps1"),
            "-Scene", scene.id, "-BuildDirectory", scene.buildDirectory, "-ExpectBackend", "SDL_GPU", "-OutputRoot", output]);
        receipts.push(readPackageSize(join(output, `bblitec-${scene.id}-sdl-gpu-windows-x64.json`)));
    }
    const report = packageSizeReport(receipts);
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
