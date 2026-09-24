import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { developmentTriplet } from "./build-options.js";
import { findTintTool } from "./tint-tool.js";
import {
    artifactPatchState,
    type ArtifactPatchState,
} from "./patch-inventory.js";

import type { canonicalDevelopmentCompiler } from "./build-options.js";

type DevelopmentCompiler = ReturnType<typeof canonicalDevelopmentCompiler>;

export const clangToolsMajor = 22;

export interface ToolDiscoveryOptions {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}

export interface WindowsBuildTools {
    compiler: string;
    environment: NodeJS.ProcessEnv;
    ninja: string;
    visualStudioRoot: string;
}

/** A pinned development artifact's source and patch record against the manifest. */
export interface DependencyPatchRecord {
    library: "dawn" | "labsound" | "rmlui";
    state: ArtifactPatchState;
    /** What doctor and setup report; absent when the record is current. */
    message: string | undefined;
}

export interface DevelopmentTools {
    /** bblite-tint, the pinned Tint the offline shader compiler drives
     *  (tools/tint-sdl, built by tools/build-tint.ps1): `BBLITE_TINT_PATH`,
     *  or the build that records this checkout's sources (src/tint-tool.ts). */
    bbliteTint: string | undefined;
    ccache: string | undefined;
    cmake: string | undefined;
    cc: string | undefined;
    cxx: string | undefined;
    ninja: string | undefined;
    dawnDirectory: string;
    /** The pinned artifacts' files are present (`dependencyPatchRecords`
     *  says whether each was built from what the manifest selects). */
    dawnInstalled: boolean;
    dxc: string | undefined;
    git: string | undefined;
    labSoundDirectory: string;
    labSoundInstalled: boolean;
    powershell: string | undefined;
    rmlUiDirectory: string;
    rmlUiInstalled: boolean;
    vcpkg: string | undefined;
    vcpkgRoot: string | undefined;
    vcpkgToolchain: string | undefined;
    visualStudioRoot: string | undefined;
}

function environmentValue(
    environment: NodeJS.ProcessEnv,
    name: string,
): string | undefined {
    const key = Object.keys(environment).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? undefined : environment[key];
}

function executableNames(command: string, platform: NodeJS.Platform): string[] {
    if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) {
        return [command];
    }
    return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

/** Resolve a command exactly as a child process would, without invoking it. */
function findExecutable(
    command: string | undefined,
    options: ToolDiscoveryOptions = {},
): string | undefined {
    if (!command) return undefined;
    const cwd = options.cwd ?? process.cwd();
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const hasDirectory =
        isAbsolute(command) || command.includes("/") || command.includes("\\");
    if (hasDirectory) {
        const candidate = isAbsolute(command) ? command : resolve(cwd, command);
        return statSync(candidate, { throwIfNoEntry: false })?.isFile()
            ? candidate
            : undefined;
    }
    const path = environmentValue(environment, "PATH") ?? "";
    const pathDelimiter = platform === "win32" ? ";" : ":";
    for (const directory of path.split(pathDelimiter).filter(Boolean)) {
        for (const name of executableNames(command, platform)) {
            const candidate = resolve(
                cwd,
                directory.replace(/^"|"$/g, ""),
                name,
            );
            if (statSync(candidate, { throwIfNoEntry: false })?.isFile())
                return candidate;
        }
    }
    return undefined;
}

function latestDirectory(root: string): string | undefined {
    if (!existsSync(root)) return undefined;
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name))
        .sort((left, right) =>
            right.localeCompare(left, undefined, { numeric: true }),
        )[0];
}

function discoverVisualStudioRoot(
    options: ToolDiscoveryOptions = {},
): string | undefined {
    const environment = options.environment ?? process.env;
    const environmentRoot = environment.VSINSTALLDIR?.replace(/[\\/]+$/, "");
    if (
        environmentRoot &&
        existsSync(join(environmentRoot, "VC", "Tools", "MSVC"))
    ) {
        return environmentRoot;
    }
    const programFilesX86 =
        environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const vswhere = join(
        programFilesX86,
        "Microsoft Visual Studio",
        "Installer",
        "vswhere.exe",
    );
    if (!existsSync(vswhere)) return undefined;
    const result = spawnSync(
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
    );
    const root = result.status === 0 ? result.stdout.trim() : "";
    return root && existsSync(join(root, "VC", "Tools", "MSVC"))
        ? root
        : undefined;
}

export function discoverWindowsBuildTools(
    requestedCompiler: DevelopmentCompiler,
    options: ToolDiscoveryOptions = {},
): WindowsBuildTools {
    const environment = options.environment ?? process.env;
    const visualStudioRoot = discoverVisualStudioRoot(options);
    if (!visualStudioRoot) {
        throw new Error(
            "Ninja requires Visual Studio C++ tools. Install the Desktop development with C++ workload or override BBLITE_CMAKE_GENERATOR.",
        );
    }
    const msvc = latestDirectory(join(visualStudioRoot, "VC", "Tools", "MSVC"));
    const programFilesX86 =
        environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const sdkRoot = join(programFilesX86, "Windows Kits", "10");
    const sdk = latestDirectory(join(sdkRoot, "Include"));
    const bundledNinja = join(
        visualStudioRoot,
        "Common7",
        "IDE",
        "CommonExtensions",
        "Microsoft",
        "CMake",
        "Ninja",
        "ninja.exe",
    );
    const ninja =
        environment.NINJA_PATH !== undefined
            ? findExecutable(environment.NINJA_PATH, options)
            : (findExecutable("ninja", options) ??
              (existsSync(bundledNinja) ? bundledNinja : undefined));
    if (!msvc || !sdk || !ninja) {
        throw new Error(
            "Unable to locate MSVC, the Windows SDK, or Ninja. Repair the Visual Studio C++ workload or override BBLITE_CMAKE_GENERATOR.",
        );
    }
    const msvcCompiler = join(msvc, "bin", "Hostx64", "x64", "cl.exe");
    const clangCompiler = join(
        visualStudioRoot,
        "VC",
        "Tools",
        "Llvm",
        "x64",
        "bin",
        "clang-cl.exe",
    );
    const compiler =
        requestedCompiler === "msvc"
            ? msvcCompiler
            : requestedCompiler === "clangcl"
              ? clangCompiler
              : existsSync(clangCompiler)
                ? clangCompiler
                : msvcCompiler;
    if (!existsSync(compiler)) {
        throw new Error(
            `The requested development compiler is not installed: ${compiler}.`,
        );
    }
    const sdkVersion = sdk.slice(dirname(sdk).length + 1);
    return {
        visualStudioRoot,
        ninja,
        compiler,
        environment: {
            ...environment,
            PATH: [
                dirname(compiler),
                join(msvc, "bin", "Hostx64", "x64"),
                join(sdkRoot, "bin", sdkVersion, "x64"),
                dirname(ninja),
                environmentValue(environment, "PATH") ?? "",
            ].join(";"),
            INCLUDE: [
                join(msvc, "include"),
                join(sdkRoot, "Include", sdkVersion, "ucrt"),
                join(sdkRoot, "Include", sdkVersion, "shared"),
                join(sdkRoot, "Include", sdkVersion, "um"),
                join(sdkRoot, "Include", sdkVersion, "winrt"),
                join(sdkRoot, "Include", sdkVersion, "cppwinrt"),
            ].join(";"),
            LIB: [
                join(msvc, "lib", "x64"),
                join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64"),
                join(sdkRoot, "Lib", sdkVersion, "um", "x64"),
            ].join(";"),
        },
    };
}

function explicitOrDiscovered(
    explicit: string | undefined,
    command: string,
    fallback: string | undefined,
    options: ToolDiscoveryOptions,
): string | undefined {
    if (explicit !== undefined) return findExecutable(explicit, options);
    return findExecutable(command, options) ?? fallback;
}

export function discoverClangTool(
    command: "clang-format" | "clang-tidy",
    options: ToolDiscoveryOptions = {},
): string | undefined {
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const override =
        environment[command === "clang-format" ? "CLANG_FORMAT" : "CLANG_TIDY"];
    if (override !== undefined) return findExecutable(override, options);
    const installed =
        findExecutable(`${command}-${clangToolsMajor}`, options) ??
        findExecutable(command, options);
    if (installed || platform !== "win32") return installed;
    const visualStudioRoot = discoverVisualStudioRoot(options);
    return visualStudioRoot
        ? findExecutable(
              join(
                  visualStudioRoot,
                  "VC",
                  "Tools",
                  "Llvm",
                  "x64",
                  "bin",
                  `${command}.exe`,
              ),
              options,
          )
        : undefined;
}

/** Locate every reusable tool/artifact in the full development profile. */
export function discoverDevelopmentTools(
    options: ToolDiscoveryOptions = {},
): DevelopmentTools {
    const cwd = options.cwd ?? process.cwd();
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const visualStudioRoot =
        platform === "win32" ? discoverVisualStudioRoot(options) : undefined;
    const bundledCmake = visualStudioRoot
        ? join(
              visualStudioRoot,
              "Common7",
              "IDE",
              "CommonExtensions",
              "Microsoft",
              "CMake",
              "CMake",
              "bin",
              "cmake.exe",
          )
        : undefined;
    const cmake = explicitOrDiscovered(
        environment.CMAKE_COMMAND,
        "cmake",
        bundledCmake && existsSync(bundledCmake) ? bundledCmake : undefined,
        options,
    );

    const pathVcpkg = findExecutable("vcpkg", options);
    const bundledVcpkgRoot = visualStudioRoot
        ? join(visualStudioRoot, "VC", "vcpkg")
        : undefined;
    const vcpkgRootCandidates = environment.VCPKG_ROOT
        ? [environment.VCPKG_ROOT]
        : [bundledVcpkgRoot, pathVcpkg ? dirname(pathVcpkg) : undefined];
    const vcpkgRoot = vcpkgRootCandidates.find(
        (candidate): candidate is string =>
            !!candidate &&
            existsSync(
                join(candidate, "scripts", "buildsystems", "vcpkg.cmake"),
            ),
    );
    const vcpkg = vcpkgRoot
        ? findExecutable(
              join(vcpkgRoot, platform === "win32" ? "vcpkg.exe" : "vcpkg"),
              options,
          )
        : undefined;

    const dawnDirectory = resolve(
        cwd,
        environment.BBLITE_DAWN_DIR ?? join("artifacts", "tools", "dawn"),
    );
    const labSoundDirectory = resolve(
        cwd,
        environment.BBLITE_LABSOUND_DIR ??
            join("artifacts", "tools", "labsound"),
    );
    const rmlUiDirectory = resolve(
        cwd,
        environment.BBLITE_RMLUI_DIR ?? join("artifacts", "tools", "rmlui"),
    );
    const localDxc = resolve(
        cwd,
        "tools",
        "shader-compiler",
        "vcpkg_installed",
        developmentTriplet(platform),
        "tools",
        "directx-dxc",
        platform === "win32" ? "dxc.exe" : "dxc",
    );
    const dawnFiles = [
        join(dawnDirectory, "lib", "cmake", "Dawn"),
        ...(platform === "win32"
            ? [
                  join(dawnDirectory, "bin", "webgpu_dawn.dll"),
                  join(dawnDirectory, "bin", "dxcompiler.dll"),
                  join(dawnDirectory, "bin", "dxil.dll"),
              ]
            : platform === "linux"
              ? [join(dawnDirectory, "lib", "libwebgpu_dawn.so")]
              : platform === "darwin"
                ? [join(dawnDirectory, "lib", "libwebgpu_dawn.dylib")]
                : []),
    ];
    const rmlUiConfig = join(
        rmlUiDirectory,
        "lib",
        "cmake",
        "RmlUi",
        "RmlUiConfig.cmake",
    );
    const rmlUiHasSvg =
        existsSync(rmlUiConfig) &&
        /\bset\(RMLUI_SVG_PLUGIN ON\)/.test(readFileSync(rmlUiConfig, "utf8"));
    const dawnBuilt = dawnFiles.every(existsSync);
    const labSoundBuilt =
        existsSync(
            join(
                labSoundDirectory,
                "lib",
                platform === "win32" ? "LabSound.lib" : "libLabSound.a",
            ),
        ) &&
        existsSync(
            join(
                labSoundDirectory,
                "lib",
                platform === "win32" ? "libnyquist.lib" : "liblibnyquist.a",
            ),
        ) &&
        existsSync(
            join(labSoundDirectory, "include", "libnyquist", "Decoders.h"),
        );
    const rmlUiBuilt =
        // The package must carry the SVG-enabled option set now consumed
        // by bounded inner markup, plus the SDL platform source the UI
        // feature compiles directly.
        rmlUiHasSvg &&
        existsSync(join(rmlUiDirectory, "Backends", "RmlUi_Platform_SDL.cpp"));

    return {
        bbliteTint:
            environment.BBLITE_TINT_PATH !== undefined
                ? findExecutable(environment.BBLITE_TINT_PATH, options)
                : findTintTool(resolve(cwd), platform),
        ccache:
            environment.CCACHE_PATH !== undefined
                ? findExecutable(environment.CCACHE_PATH, options)
                : (findExecutable(
                      resolve(
                          cwd,
                          "artifacts/tools/ccache",
                          platform === "win32" ? "ccache.exe" : "ccache",
                      ),
                      options,
                  ) ?? findExecutable("ccache", options)),
        visualStudioRoot,
        cmake,
        cc:
            platform === "win32"
                ? undefined
                : findExecutable(environment.CC ?? "clang", options),
        cxx:
            platform === "win32"
                ? undefined
                : findExecutable(environment.CXX ?? "clang++", options),
        ninja: findExecutable(environment.NINJA_PATH ?? "ninja", options),
        powershell: findExecutable(
            platform === "win32" ? "pwsh.exe" : "pwsh",
            options,
        ),
        git: findExecutable("git", options),
        vcpkgRoot,
        vcpkg,
        vcpkgToolchain: vcpkgRoot
            ? join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake")
            : undefined,
        dawnDirectory,
        dawnInstalled: dawnBuilt,
        dxc:
            environment.DXC_PATH !== undefined
                ? findExecutable(environment.DXC_PATH, options)
                : existsSync(localDxc)
                  ? localDxc
                  : findExecutable("dxc", options),
        labSoundDirectory,
        labSoundInstalled: labSoundBuilt,
        rmlUiDirectory,
        rmlUiInstalled: rmlUiBuilt,
    };
}

/**
 * The source/patch records of the pinned development artifacts present,
 * checked by native/patch-identity.cmake: Dawn for the variants this
 * platform applies, LabSound for the variants it recorded, RmlUi for none.
 * Empty without CMake, which doctor reports first.
 */
export function dependencyPatchRecords(
    tools: DevelopmentTools,
    platform: NodeJS.Platform = process.platform,
): DependencyPatchRecord[] {
    const cmake = tools.cmake;
    if (!cmake) return [];
    return (
        [
            [
                tools.dawnInstalled,
                "dawn",
                tools.dawnDirectory,
                platform === "darwin" ? ["metal"] : [],
            ],
            [
                tools.labSoundInstalled,
                "labsound",
                tools.labSoundDirectory,
                undefined,
            ],
            [tools.rmlUiInstalled, "rmlui", tools.rmlUiDirectory, []],
        ] as const
    )
        .filter(([built]) => built)
        .map(([, library, directory, require]) => {
            const state = artifactPatchState(
                cmake,
                library,
                directory,
                require,
            );
            return {
                library,
                state,
                message:
                    state.state === "current"
                        ? undefined
                        : `${library} at ${directory} ${state.detail}; ${state.state === "stale" ? "setup rebuilds it" : "rebuild it to record one"}.`,
            };
        });
}
