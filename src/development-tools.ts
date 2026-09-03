import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import type { canonicalDevelopmentCompiler } from "./build-options.js";

type DevelopmentCompiler = ReturnType<typeof canonicalDevelopmentCompiler>;

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

export interface DevelopmentTools {
    cmake: string | undefined;
    dawnDirectory: string;
    dawnInstalled: boolean;
    dxc: string | undefined;
    git: string | undefined;
    labSoundDirectory: string;
    labSoundInstalled: boolean;
    powershell: string | undefined;
    rmlUiDirectory: string;
    rmlUiInstalled: boolean;
    tint: string | undefined;
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

function executableNames(
    command: string,
    platform: NodeJS.Platform,
): string[] {
    if (platform !== "win32" || /\.[A-Za-z0-9]+$/.test(command)) {
        return [command];
    }
    return [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`];
}

/** Resolve a command exactly as a child process would, without invoking it. */
export function findExecutable(
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
        return existsSync(candidate) ? candidate : undefined;
    }
    const path = environmentValue(environment, "PATH") ?? "";
    const pathDelimiter = platform === "win32" ? ";" : delimiter;
    for (const directory of path.split(pathDelimiter).filter(Boolean)) {
        for (const name of executableNames(command, platform)) {
            const candidate = join(directory.replace(/^"|"$/g, ""), name);
            if (existsSync(candidate)) return candidate;
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
            right.localeCompare(left, undefined, { numeric: true }))[0];
}

export function discoverVisualStudioRoot(
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
            : findExecutable("ninja", options) ??
              (existsSync(bundledNinja) ? bundledNinja : undefined);
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
              join(
                  vcpkgRoot,
                  platform === "win32" ? "vcpkg.exe" : "vcpkg",
              ),
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
    const localTint = resolve(
        cwd,
        "artifacts",
        "tools",
        "tint",
        platform === "win32" ? "tint.exe" : "tint",
    );
    const localDxc = resolve(
        cwd,
        "tools",
        "shader-compiler",
        "vcpkg_installed",
        "x64-windows",
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
        /\bset\(RMLUI_SVG_PLUGIN ON\)/.test(
            readFileSync(rmlUiConfig, "utf8"),
        );

    return {
        visualStudioRoot,
        cmake,
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
        dawnInstalled: dawnFiles.every(existsSync),
        tint:
            environment.TINT_PATH !== undefined
                ? findExecutable(environment.TINT_PATH, options)
                : existsSync(localTint)
                    ? localTint
                    : findExecutable("tint", options),
        dxc:
            environment.DXC_PATH !== undefined
                ? findExecutable(environment.DXC_PATH, options)
                : existsSync(localDxc)
                    ? localDxc
                    : findExecutable("dxc", options),
        labSoundDirectory,
        labSoundInstalled:
            existsSync(join(labSoundDirectory, "lib", "LabSound.lib")) &&
            existsSync(join(labSoundDirectory, "lib", "libnyquist.lib")),
        rmlUiDirectory,
        rmlUiInstalled:
            // The package must carry the SVG-enabled option set now consumed
            // by bounded inner markup, plus the SDL platform source the UI
            // feature compiles directly.
            rmlUiHasSvg &&
            existsSync(
                join(rmlUiDirectory, "Backends", "RmlUi_Platform_SDL.cpp"),
            ),
    };
}
