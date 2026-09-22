import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { jsonObject, jsonRecords } from "./json.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import {
    cppFunction,
    cppRecord,
    cppSection,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = discoverDevelopmentTools();

test(
    "the Android surface-loss patch applies to the pinned Dawn sources",
    {
        skip: !existsSync(
            ".cache/tint/dawn/src/dawn/native/vulkan/SwapChainVk.cpp",
        ),
    },
    () => {
        execFileSync(
            "git",
            [
                "-C",
                ".cache/tint/dawn",
                "apply",
                "--cached",
                "--check",
                resolve("tools/patches/dawn-android-surface-loss.patch"),
            ],
            { stdio: "pipe", windowsHide: true },
        );
    },
);

test(
    "Android CMake admits both renderers while requiring static Dawn and API 29 for system fonts",
    { skip: !tools.cmake },
    (t) => {
        mkdirSync("artifacts", { recursive: true });
        const directory = mkdtempSync(resolve("artifacts/android-configure-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const cmake = readFileSync("native/CMakeLists.txt", "utf8");
        const script = join(directory, "guard.cmake");
        writeFileSync(
            script,
            `set(ANDROID TRUE)
${cppSection(cmake, "if(ANDROID)", "if(IOS)")}
${cppSection(cmake, 'if(BBLITE_BACKEND STREQUAL "SDL_GPU")', "# One authority")}
if(BBLITE_BACKEND_DAWN)
${cppSection(cmake, "    if(ANDROID AND NOT BBLITE_DAWN_LIBRARY_TYPE", '    if(BBLITE_DAWN_LIBRARY_TYPE STREQUAL "SHARED_LIBRARY")')}
endif()
`,
        );
        const configure = (
            backend: string,
            api = 28,
            features = "",
            library = "STATIC_LIBRARY",
        ) =>
            spawnSync(
                tools.cmake!,
                [
                    `-DBBLITE_BACKEND=${backend}`,
                    `-DANDROID_PLATFORM_LEVEL=${api}`,
                    `-DBBLITE_RUNTIME_FEATURES=${features}`,
                    `-DBBLITE_DAWN_LIBRARY_TYPE=${library}`,
                    "-P",
                    script,
                ],
                { encoding: "utf8", windowsHide: true },
            );
        for (const backend of ["SDL_GPU", "DAWN", "BOTH"]) {
            const result = configure(backend);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(configure(backend, 29, "ui:rml").status, 0);
            assert.match(
                configure(backend, 28, "ui:rml").stderr,
                /requires API 29/,
            );
            if (backend !== "SDL_GPU")
                assert.match(
                    configure(backend, 28, "", "SHARED_LIBRARY").stderr,
                    /monolithic static Dawn/,
                );
        }
        assert.match(configure("invalid").stderr, /BBLITE_BACKEND must be/);
    },
);

test(
    "Android Dawn cross-build uses the target ABI, static Vulkan and no host DXC or desktop surfaces",
    { skip: !tools.powershell },
    (t) => {
        mkdirSync("artifacts", { recursive: true });
        const directory = mkdtempSync(resolve("artifacts/android-dawn-tools-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const ndk = join(directory, "NDK with spaces");
        mkdirSync(join(ndk, "build/cmake"), { recursive: true });
        writeFileSync(join(ndk, "build/cmake/android.toolchain.cmake"), "");
        const script = join(directory, "build.ps1"),
            cmake = join(directory, "cmake.ps1");
        const quote = (text: string): string => text.replaceAll("'", "''");
        const source = readFileSync("tools/build-dawn.ps1", "utf8").replace(
            'Import-Module (Join-Path $PSScriptRoot "bblite-tools.psm1") -Force',
            `Import-Module '${quote(resolve("tools/bblite-tools.psm1"))}' -Force
function Sync-PinnedCheckout([string]$Path, [string]$Repository, [string]$Commit, [string]$Label) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Set-Content (Join-Path $Path 'LICENSE') 'fixture license'
}
function Get-PosixCompilerArguments { throw 'Android must not select the host compiler.' }
function git { $global:LASTEXITCODE = 0 }
`,
        );
        writeFileSync(script, source);
        writeFileSync(
            cmake,
            `
Add-Content (Join-Path $PSScriptRoot 'commands.jsonl') (ConvertTo-Json -InputObject @($args) -Compress)
$global:LASTEXITCODE = 0
`,
        );
        for (const abi of ["arm64-v8a", "x86_64"]) {
            const output = join(directory, abi);
            const args = [
                "-NoProfile",
                "-File",
                script,
                "-AndroidAbi",
                abi,
                "-AndroidNdk",
                ndk,
                "-Workspace",
                join(directory, `workspace-${abi}`),
                "-OutputDirectory",
                output,
                "-CMake",
                cmake,
                "-Jobs",
                "2",
            ];
            const result = spawnSync(tools.powershell!, args, {
                encoding: "utf8",
                windowsHide: true,
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const commands = readFileSync(
                join(directory, "commands.jsonl"),
                "utf8",
            )
                .trim()
                .split(/\r?\n/)
                .slice(-3)
                .map((line) => {
                    const value: unknown = JSON.parse(line);
                    assert.ok(
                        Array.isArray(value) &&
                            value.every(
                                (argument) => typeof argument === "string",
                            ),
                    );
                    return value;
                });
            const configure = commands[0]!;
            for (const required of [
                `-DANDROID_ABI=${abi}`,
                "-DANDROID_PLATFORM=android-28",
                "-DANDROID_STL=c++_shared",
                `-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake`,
                "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
                "-DDAWN_BUILD_MONOLITHIC_LIBRARY=STATIC",
                "-DDAWN_ENABLE_VULKAN=ON",
                "-DDAWN_ENABLE_D3D12=OFF",
                "-DDAWN_ENABLE_METAL=OFF",
                "-DDAWN_USE_BUILT_DXC=OFF",
                "-DDAWN_USE_X11=OFF",
                "-DDAWN_USE_WAYLAND=OFF",
            ]) {
                assert.ok(
                    configure.includes(required),
                    `Missing ${required}: ${configure.join(" ")}`,
                );
            }
            assert.deepEqual(
                commands[1]!.filter(
                    (argument) =>
                        argument === "webgpu_dawn" ||
                        argument === "dxcompiler" ||
                        argument === "copy_dxil_dll",
                ),
                ["webgpu_dawn"],
            );
            assert.ok(existsSync(join(output, "LICENSE.txt")));
            const provenance: unknown = JSON.parse(
                readFileSync(join(output, "provenance.json"), "utf8"),
            );
            assert.ok(
                provenance &&
                    typeof provenance === "object" &&
                    "patches" in provenance &&
                    Array.isArray(provenance.patches),
            );
            assert.deepEqual(
                jsonRecords(provenance.patches).map((patch) => patch.file),
                ["dawn-android-surface-loss.patch"],
            );
            const incompatible = spawnSync(
                tools.powershell!,
                [...args, "-IosSdk", "iphoneos", "-IosArchitecture", "arm64"],
                { encoding: "utf8", windowsHide: true },
            );
            assert.notEqual(incompatible.status, 0);
            assert.match(incompatible.stderr, /cannot be combined/);
        }
    },
);

test(
    "Android workflow scripts parse and release planning preserves the selected backend",
    { skip: !tools.powershell },
    () => {
        execFileSync(
            tools.powershell!,
            [
                "-NoProfile",
                "-Command",
                `
$ErrorActionPreference = 'Stop'
foreach ($file in @('tools/android.ps1', 'tools/package-android.ps1', 'tools/package-demo.ps1')) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}`,
            ],
            { windowsHide: true, stdio: "pipe" },
        );
        for (const backend of ["sdl_gpu", "dawn"]) {
            const plan: unknown = JSON.parse(
                execFileSync(
                    process.execPath,
                    [
                        "dist/src/shipping-demos.js",
                        "--platform",
                        "android",
                        "--scene",
                        "torus-states",
                        "--backend",
                        backend,
                        "--plan",
                    ],
                    { encoding: "utf8" },
                ),
            );
            assert.ok(Array.isArray(plan));
            assert.equal(plan.length, 1);
            const args = jsonObject(plan[0]).args;
            assert.ok(Array.isArray(args));
            assert.equal(
                args[args.indexOf("-ExpectBackend") + 1],
                backend.toUpperCase(),
            );
        }
    },
);

test("Dawn Android surfaces negotiate worker formats and retain native windows across same-size resume", (t) => {
    const native = optionalNativeFixtureTools(false);
    const dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!native || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("A native compiler and pinned Dawn headers are required.");
        return;
    }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/android-dawn-surface-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const shared = readFileSync("native/src/pal_dawn_shared.hpp", "utf8");
    writeFileSync(
        join(directory, "surface-under-test.hpp"),
        "#define __ANDROID__ 1\n" +
            cppFunction(
                readFileSync("native/src/pal_dawn_device.hpp", "utf8"),
                "    void release_surface()",
            ).replace(
                "void release_surface()",
                "void DawnDevice::release_surface()",
            ) +
            "\n" +
            cppFunction(
                shared,
                "inline void select_dawn_surface_configuration",
            ) +
            "\n" +
            cppFunction(shared, "inline bool refresh_dawn_android_surface") +
            "\n" +
            cppFunction(shared, "inline void configure_dawn_surface") +
            "\n" +
            cppSection(
                shared,
                "inline bool resize_dawn_surface",
                "inline void create_dawn_device",
            ) +
            "\n" +
            cppRecord(
                readFileSync("native/src/pal_dawn_offscreen.hpp", "utf8"),
                "struct DawnOffscreenImage",
            ) +
            "\n" +
            cppFunction(
                readFileSync("native/src/pal_window.hpp", "utf8"),
                "inline SDL_WindowFlags run_window_flags",
            ) +
            "\n",
    );
    const executable = join(directory, "check.exe");
    for (const [sdl, dawn] of [
        [0, 1],
        [1, 1],
        [1, 0],
    ]) {
        runNativeFixtureCompiler(native, [
            "/nologo",
            "/std:c++20",
            "/EHsc",
            "/W4",
            "/WX",
            `/DBBLITE_HAS_DAWN=${dawn}`,
            `/DBBLITE_HAS_SDL_GPU=${sdl}`,
            `/I${resolve("native/include")}`,
            `/I${resolve("native/src")}`,
            `/I${dawnInclude}`,
            `/I${directory}`,
            resolve("test/fixtures/dawn-surface-check.cpp"),
            `/Fe:${executable}`,
            `/Fo:${join(directory, "check.obj")}`,
        ]);
        const result = spawnSync(executable, [], {
            encoding: "utf8",
            windowsHide: true,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /immediate presentation is unavailable/);
    }
});
