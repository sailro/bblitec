#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
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
        if (scene.parity?.attribution) arguments_.push("--diagnostics");
        runNode("dist/src/cli.js", arguments_);
    }
}

function parity(idOrSource: string, extraArguments: string[]): void {
    const scene = resolveScene(idOrSource);
    if (!scene.parity) throw new Error(`Scene '${scene.id}' has no parity definition.`);
    runNode("dist/src/parity-scene.js", [idOrSource, ...extraArguments]);
}

function build(idOrSource: string): void {
    const scene = resolveScene(idOrSource);
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

function processScene(idOrSource: string): void {
    compile(idOrSource);
    run(process.platform === "win32" ? "pwsh.exe" : "pwsh", [
        "-File",
        "tools/compile-shaders.ps1",
        "-Scene",
        resolveScene(idOrSource).id,
    ]);
    build(idOrSource);
}

function main(): void {
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
        parity(id, rest);
        return;
    }
    throw new Error(
        "Usage: scene-command <list | show <id|source.ts> | compile <id|source.ts|all> | build <id|source.ts> | process <id|source.ts> | parity <id|source.ts> [--recapture-reference]>",
    );
}

try {
    main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
