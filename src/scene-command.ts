#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runSceneParity } from "./parity-scene.js";
import { resolveScene, scenes } from "./scene-registry.js";

function runNode(module: string, arguments_: string[]): void {
    run(process.execPath, [resolve(module), ...arguments_]);
}

function run(command: string, arguments_: string[]): void {
    const result = spawnSync(command, arguments_, {
        stdio: "inherit",
        env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}.`);
    }
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
    const configureArguments = [
        "-S",
        "native",
        "-B",
        scene.buildDirectory,
        "-DCMAKE_BUILD_TYPE=Release",
        `-DBBLITE_GENERATED_DIR=${resolve(scene.output)}`,
    ];
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
    run(process.env.CMAKE_COMMAND ?? "cmake", configureArguments);
    run(process.env.CMAKE_COMMAND ?? "cmake", [
        "--build",
        scene.buildDirectory,
        "--config",
        "Release",
    ]);
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
