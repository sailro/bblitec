#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runSceneParity } from "./parity-scene.js";
import { resolveScene, scenes } from "./scene-registry.js";

function runNode(module: string, arguments_: string[]): void {
    run(process.execPath, [resolve(module), ...arguments_]);
}

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

function compile(idOrSource: string): void {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    for (const scene of selected) {
        const arguments_ = [
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
        runNode("dist/src/cli.js", arguments_);
    }
}

async function parity(
    idOrSource: string,
    extraArguments: string[],
): Promise<void> {
    if (idOrSource === "all") {
        for (const scene of scenes) {
            if (scene.parity) {
                await runSceneParity([scene.id, ...extraArguments]);
            }
        }
        return;
    }
    const scene = resolveScene(idOrSource);
    if (!scene.parity) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    await runSceneParity([idOrSource, ...extraArguments]);
}

function build(idOrSource: string): void {
    const selected = idOrSource === "all" ? scenes : [resolveScene(idOrSource)];
    for (const scene of selected) {
        buildScene(scene);
    }
}

function buildScene(scene: (typeof scenes)[number]): void {
    const generator = process.env.BBLITE_CMAKE_GENERATOR ?? "Ninja";
    const ninja =
        process.platform === "win32" && generator === "Ninja"
            ? windowsNinjaEnvironment()
            : undefined;
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
    run(
        process.env.CMAKE_COMMAND ?? "cmake",
        configureArguments,
        environment,
    );
    run(
        process.env.CMAKE_COMMAND ?? "cmake",
        [
            "--build",
            scene.buildDirectory,
            "--config",
            "Release",
            "--parallel",
        ],
        environment,
    );
}

function compileShaders(sceneId?: string): void {
    const arguments_ = ["-File", "tools/compile-shaders.ps1"];
    if (sceneId) arguments_.push("-Scene", sceneId);
    run(process.platform === "win32" ? "pwsh.exe" : "pwsh", arguments_);
}

function processScene(idOrSource: string): void {
    if (idOrSource === "all") {
        compile("all");
        compileShaders();
        for (const scene of scenes) buildScene(scene);
        return;
    }
    compile(idOrSource);
    compileShaders(resolveScene(idOrSource).id);
    build(idOrSource);
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
        compile(id);
        return;
    }
    if (command === "build" && id) {
        build(id);
        return;
    }
    if (command === "process" && id) {
        processScene(id);
        return;
    }
    if (command === "parity" && id) {
        await parity(id, rest);
        return;
    }
    throw new Error(
        "Usage: scene-command <list | show <id|source.ts> | compile|build|process|parity <id|source.ts|all> [parity options]>",
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
