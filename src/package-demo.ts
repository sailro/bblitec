/**
 * Packages the shipping build of one generated application scene for the
 * desktop host: the exact, statically linked BBLITE_MINSIZE shape (full
 * development builds and dual-backend differential binaries are refused), the
 * payload of the single backend the build compiled -- SDL_GPU ships DXIL on
 * Windows, SPIR-V on Linux and Metal on macOS; Windows Dawn ships WGSL text --
 * the notices of what it links, a five-frame startup check and a receipt.
 * macOS packages merge an x86_64 and an arm64 slice into one universal
 * executable. The package ships no runtime or CRT libraries.
 *
 * `npm run package:demo` runs `main`; Android and iOS packages are built by
 * their platform scripts through `shipping-mobile.ts`.
 */
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    comparePayload,
    deployedPayloads,
    readCacheConfiguration,
} from "./build-stamp.js";
import { discoverDevelopmentTools } from "./development-tools.js";
import {
    copyPackageNotices,
    packageNotices,
    type NoticePlatform,
} from "./package-notices.js";
import {
    archivePackage,
    fileIdentity,
    newPackageOutput,
    packageFiles,
    publishPackageOutput,
    writePackageReceipt,
} from "./package-output.js";
import { findRepositoryRoot } from "./repository-root.js";
import { readShippingProfile } from "./shipping-profile.js";
import {
    compiledBackend,
    parseBackendName,
    type CompiledNativeBackend,
} from "./tooling/backends.js";
import { flagNumber, isMainModule, parseFlags } from "./tooling/flags.js";
import { readCompiledAssetSources } from "./tooling/generated-readers.js";
import { asObject } from "./gltf-document.js";

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

/** The package file name stem of `scene`'s `backend` package on `platform`. */
function desktopPackageName(
    scene: string,
    backend: CompiledNativeBackend,
    platform: ShippingPlatform,
): string {
    return `bblitec-${scene}-${backend.toLowerCase().replace("_", "-")}-${
        platform === "win32"
            ? "windows-x64"
            : platform === "darwin"
              ? "macos-universal"
              : "linux-x64"
    }`;
}

interface DesktopPackageOptions {
    scene: string;
    /** The mini build tree (macOS: the x86_64 slice). */
    buildDirectory: string;
    /** macOS: the arm64 slice. */
    arm64BuildDirectory?: string;
    expectBackend?: CompiledNativeBackend;
    outputRoot: string;
    cmake: string;
    platform?: ShippingPlatform;
    root?: string;
}

interface DesktopPackageReceipt {
    scene: string;
    backend: CompiledNativeBackend;
    platform: "windows" | "linux" | "macos";
    graphicsApi: string;
    buildDirectory: string;
    exeBytes: number;
    zipBytes: number;
    unpackedBytes: number;
    exeSha256: string;
    zipSha256: string;
    previousExeBytes: number | null;
    previousZipBytes: number | null;
    smokeFrames: number;
    smokeExit: number;
    architectures: string[];
    smokeArchitecture: string;
    buildDirectories: string[];
}

const smokeFrames = 5;
const smokeTimeoutMs = 120_000;

interface Host {
    platform: ShippingPlatform;
    name: "windows" | "linux" | "macos";
    notices: NoticePlatform;
    graphicsApi: string;
    gpuDriver: string;
    exeExtension: string;
    architectures: string[];
    architectureToken: string;
    triplets: string[];
    newline: string;
}

function host(platform: ShippingPlatform): Host {
    switch (platform) {
        case "win32":
            return {
                platform,
                name: "windows",
                notices: "windows",
                graphicsApi: "D3D12",
                gpuDriver: "direct3d12",
                exeExtension: ".exe",
                architectures: ["x64"],
                architectureToken: "x64",
                triplets: ["x64-windows-static"],
                newline: "\r\n",
            };
        case "darwin":
            return {
                platform,
                name: "macos",
                notices: "macos",
                graphicsApi: "Metal",
                gpuDriver: "metal",
                exeExtension: "",
                architectures: ["x86_64", "arm64"],
                architectureToken: "universal",
                triplets: ["x64-osx", "arm64-osx"],
                newline: "\n",
            };
        case "linux":
            return {
                platform,
                name: "linux",
                notices: "linux",
                graphicsApi: "Vulkan",
                gpuDriver: "vulkan",
                exeExtension: "",
                architectures: ["x64"],
                architectureToken: "x64",
                triplets: ["x64-linux"],
                newline: "\n",
            };
    }
}

/** Runs a host tool that must succeed, returning its standard output. */
function checked(
    command: string,
    args: readonly string[],
    failure: string,
): string {
    const result = spawnSync(command, [...args], {
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${failure}: ${result.stdout}${result.stderr}`.trim());
    return result.stdout;
}

const samePath = (left: string, right: string, platform: ShippingPlatform) =>
    platform === "win32"
        ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
        : resolve(left) === resolve(right);

interface Slice {
    buildDirectory: string;
    cache: Record<string, string>;
    executable: string;
    generatedDirectory: string;
    backend: CompiledNativeBackend;
}

/** Refuses a build tree that is not the exact mini shape of `scene`. */
function readSlice(
    scene: string,
    buildDirectory: string,
    index: number,
    options: DesktopPackageOptions,
    target: Host,
    root: string,
    first: Slice | undefined,
    architectureOf: (executable: string) => string,
): Slice {
    const cache = readCacheConfiguration(buildDirectory);
    const cacheFile = join(buildDirectory, "CMakeCache.txt");
    if (!cache)
        throw new Error(
            `CMake cache not found: ${cacheFile}. Configure and build the exact mini tree described in docs/development.md#minimal-size-shipping-builds.`,
        );
    if (target.platform === "darwin") {
        if (cache.CMAKE_OSX_ARCHITECTURES !== target.architectures[index])
            throw new Error(
                `Expected CMAKE_OSX_ARCHITECTURES=${target.architectures[index]} in ${cacheFile}.`,
            );
        for (const key of [
            "BBLITE_AUDIO_CAPTURE",
            "BBLITE_VISUAL_CAPTURE",
            "CMAKE_OSX_DEPLOYMENT_TARGET",
        ]) {
            if (first && cache[key] !== first.cache[key])
                throw new Error(`Universal build slices disagree on ${key}.`);
        }
    }
    const recorded = cache.BBLITE_BACKEND;
    if (recorded === undefined)
        throw new Error(
            `BBLITE_BACKEND is not recorded in ${cacheFile}. Reconfigure the exact mini tree with the current toolchain.`,
        );
    const selection = parseBackendName(
        recorded,
        `BBLITE_BACKEND in ${cacheFile}`,
        true,
    );
    if (selection === "both")
        throw new Error(
            `Shipping requires a single backend; ${buildDirectory} was configured with BBLITE_BACKEND=BOTH.`,
        );
    const backend = compiledBackend(selection);
    if (options.expectBackend && backend !== options.expectBackend)
        throw new Error(
            `Build directory ${buildDirectory} was configured with BBLITE_BACKEND=${backend}, not ${options.expectBackend}.`,
        );
    if (target.platform !== "win32" && backend !== "SDL_GPU")
        throw new Error(
            `${target.name} shipping requires SDL_GPU with ${target.graphicsApi}.`,
        );
    if (cache.BBLITE_MINSIZE !== "ON")
        throw new Error(
            "Shipping requires BBLITE_MINSIZE=ON; configure the exact mini build before packaging.",
        );
    const triplet = target.triplets[index]!;
    if (cache.VCPKG_TARGET_TRIPLET !== triplet)
        throw new Error(
            `Shipping requires VCPKG_TARGET_TRIPLET=${triplet}; got '${cache.VCPKG_TARGET_TRIPLET ?? ""}'.`,
        );
    const runtime = cache.CMAKE_MSVC_RUNTIME_LIBRARY ?? "";
    if (
        target.platform === "win32" &&
        !/^MultiThreaded(?:Debug)?(?:\$<.*>)?$/.test(runtime)
    )
        throw new Error(
            `Shipping requires the static MSVC runtime (CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded); got '${runtime}'.`,
        );
    // Every per-scene read (features, the deployed payload) must describe the
    // generated tree the executable was built from.
    const generatedDirectory = cache.BBLITE_GENERATED_DIR;
    if (!generatedDirectory)
        throw new Error(
            `BBLITE_GENERATED_DIR is not recorded in ${cacheFile}. Reconfigure the exact mini tree with the current toolchain.`,
        );
    const expected = join(root, "generated", scene);
    if (!samePath(generatedDirectory, expected, target.platform))
        throw new Error(
            `Build directory ${buildDirectory} was configured against ${resolve(generatedDirectory)}, not ${expected}. Reconfigure the mini tree for the packaged scene.`,
        );
    const name = `bblite_native${target.exeExtension}`;
    const executable = [
        join(buildDirectory, name),
        join(buildDirectory, "Release", name),
    ].find((candidate) => existsSync(candidate));
    if (!executable)
        throw new Error(
            `Required shipping executable not found under: ${buildDirectory}`,
        );
    const runtimeDirectory = dirname(executable);
    if (!existsSync(join(runtimeDirectory, "shaders")))
        throw new Error(
            `Required shipping input not found: ${join(runtimeDirectory, "shaders")}`,
        );
    // The deploy merges rather than mirrors, so a reused tree can hold files
    // the current generation no longer owns, or stale copies: a package ships
    // only what the generated tree owns (the measured-run guard's comparison).
    for (const payload of deployedPayloads(
        runtimeDirectory,
        generatedDirectory,
    )) {
        const mismatches = comparePayload(payload);
        if (mismatches.length > 0)
            throw new Error(
                `Deployed ${payload.label} beside ${executable} differ from ${payload.source}: ${mismatches
                    .slice(0, 5)
                    .map((mismatch) => `${mismatch.path} (${mismatch.reason})`)
                    .join(
                        ", ",
                    )}. Rebuild the mini tree (the deploy merges rather than mirrors; delete obsolete files first).`,
            );
    }
    if (target.platform === "darwin") {
        const architecture = architectureOf(executable);
        if (architecture !== target.architectures[index])
            throw new Error(
                `Expected a thin ${target.architectures[index]} executable: ${executable}; got ${architecture}.`,
            );
    }
    return {
        buildDirectory,
        cache,
        executable,
        generatedDirectory,
        backend,
    };
}

/** The DLL names a PE image imports (empty for a non-PE file). */
export function importedLibraries(bytes: Buffer): string[] {
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return [];
    const pe = bytes.readInt32LE(0x3c);
    if (pe < 0 || bytes.length < pe + 24 || bytes.readUInt32LE(pe) !== 0x4550)
        return [];
    const sectionCount = bytes.readUInt16LE(pe + 6);
    const optionalSize = bytes.readUInt16LE(pe + 20);
    const optional = pe + 24;
    // The import directory is data-directory entry 1, after the optional
    // header's fixed part: 96 bytes for PE32, 112 for PE32+.
    const importEntry =
        optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96) + 8;
    const importRva = bytes.readUInt32LE(importEntry);
    if (importRva === 0) return [];
    const sections = Array.from({ length: sectionCount }, (_, index) => {
        const header = optional + optionalSize + index * 40;
        return {
            rva: bytes.readUInt32LE(header + 12),
            size: bytes.readUInt32LE(header + 8),
            raw: bytes.readUInt32LE(header + 20),
        };
    });
    const offset = (rva: number): number => {
        const section = sections.find(
            (entry) =>
                rva >= entry.rva && rva < entry.rva + Math.max(entry.size, 1),
        );
        return section ? section.raw + (rva - section.rva) : -1;
    };
    const names: string[] = [];
    for (
        let descriptor = offset(importRva);
        descriptor >= 0 && descriptor + 20 <= bytes.length;
        descriptor += 20
    ) {
        const nameRva = bytes.readUInt32LE(descriptor + 12);
        if (nameRva === 0) break;
        const start = offset(nameRva);
        if (start < 0) break;
        const end = bytes.indexOf(0, start);
        names.push(
            bytes.toString("ascii", start, end < 0 ? bytes.length : end),
        );
    }
    return names;
}

/**
 * Refuses a staged package whose binaries import a library the toolchain
 * provides (it sits beside the built executable) but the package omits: the
 * loader would fail the process before main with STATUS_DLL_NOT_FOUND.
 * System libraries resolve from the operating system.
 */
function verifyWindowsImports(
    packageDirectory: string,
    runtimeDirectory: string,
): void {
    const staged = readdirSync(packageDirectory).filter((name) =>
        [".dll", ".exe"].includes(extname(name).toLowerCase()),
    );
    const stagedNames = new Set(staged.map((name) => name.toLowerCase()));
    const missing = new Map<string, string>();
    for (const binary of staged) {
        for (const library of importedLibraries(
            readFileSync(join(packageDirectory, binary)),
        )) {
            if (stagedNames.has(library.toLowerCase())) continue;
            if (!existsSync(join(runtimeDirectory, library))) continue;
            missing.set(library, binary);
        }
    }
    if (missing.size > 0)
        throw new Error(
            `Package would not start: missing runtime libraries the toolchain provides: ${[
                ...missing,
            ]
                .map(
                    ([library, binary]) => `${library} (imported by ${binary})`,
                )
                .join(", ")}`,
        );
}

/** The host libraries a Unix executable links, refusing a project library. */
function unixRuntimeLibraries(
    executable: string,
    target: Host,
    root: string,
): string[] {
    if (target.platform === "linux") {
        // Resolve without the developer's loader search overrides.
        const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
        delete environment.LD_LIBRARY_PATH;
        delete environment.LD_PRELOAD;
        const result = spawnSync("ldd", [executable], {
            encoding: "utf8",
            env: environment,
        });
        const lines = `${result.stdout}${result.stderr}`
            .split(/\r?\n/)
            .filter(Boolean);
        if (result.status !== 0 || lines.some((line) => /not found/.test(line)))
            throw new Error(
                `Unresolved Linux dependencies: ${lines.join("\n")}`,
            );
        for (const line of lines) {
            if (
                /lib(?:SDL3|RmlUi|rmlui|LabSound|webgpu_dawn)/.test(line) ||
                line.includes(root)
            )
                throw new Error(
                    `Shipping requires static project libraries, but the executable imports: ${line}`,
                );
        }
        return lines;
    }
    return target.architectures.flatMap((architecture) => {
        const lines = checked(
            "otool",
            ["-arch", architecture, "-L", executable],
            "Unable to inspect Mach-O dependencies",
        )
            .split(/\r?\n/)
            .filter(Boolean);
        for (const line of lines.slice(1)) {
            if (!/^(?:\/usr\/lib\/|\/System\/Library\/)/.test(line.trim()))
                throw new Error(
                    `Shipping requires static project libraries and system frameworks, but imports: ${line}`,
                );
        }
        return lines;
    });
}

/** The README a desktop package carries. */
function readme(
    scene: string,
    backend: CompiledNativeBackend,
    exeName: string,
    target: Host,
    root: string,
): string {
    const pin = asObject(
        JSON.parse(
            readFileSync(join(root, "upstream", "babylon-lite.json"), "utf8"),
        ),
    );
    const field = (key: string): string => {
        const value = pin?.[key];
        if (typeof value !== "string")
            throw new Error(`upstream/babylon-lite.json lacks ${key}.`);
        return value;
    };
    const fidelity: string[] = [];
    for (const [file, label] of [
        ["report-gpu.json", "SDL_GPU"],
        ["report-dawn.json", "Dawn"],
    ] as const) {
        const path = join(root, "artifacts", "parity", scene, file);
        if (!existsSync(path)) continue;
        const report = asObject(JSON.parse(readFileSync(path, "utf8")));
        const mad = (key: "full" | "region"): string => {
            const number = asObject(report?.[key])?.mad;
            if (typeof number !== "number")
                throw new Error(`${path} records no ${key} MAD.`);
            return String(Math.round(number * 1000) / 1000);
        };
        fidelity.push(
            `  ${label}: full-image MAD ${mad("full")}, foreground MAD ${mad("region")}`,
        );
    }
    const requirements =
        target.platform === "win32"
            ? "Windows 10/11 and a Direct3D 12 GPU"
            : target.platform === "darwin"
              ? "macOS on Intel or Apple silicon, with a Metal GPU and an active desktop session"
              : "Linux x64 with a Vulkan GPU/driver and an X11 or Wayland session";
    const notes = [
        "  - Keep the assets and shaders directories beside the executable.",
        ...(backend === "DAWN"
            ? [
                  "  - Shaders compile through the Windows D3D compiler (d3dcompiler_47.dll), resolved from System32.",
              ]
            : []),
        ...(target.platform === "linux"
            ? [
                  "  - Built for the host Linux system ABI; see RUNTIME-LIBRARIES.txt for linked system libraries.",
                  "  - Install Fontconfig and fonts for text/UI. Audio requires a working host audio service.",
              ]
            : []),
        ...(target.platform === "darwin"
            ? [
                  "  - Built for the configured macOS deployment target; see RUNTIME-LIBRARIES.txt for system frameworks/libraries.",
                  "  - Ad-hoc signed for local use; this package is not Developer ID signed or notarized.",
              ]
            : []),
    ];
    const lines = [
        `bblitec ${scene} shipping demo (${target.name} ${target.architectureToken})`,
        "================================================",
        "",
        `Backend: ${
            backend === "SDL_GPU"
                ? `SDL_GPU over ${target.graphicsApi} with offline-compiled shaders`
                : "Dawn (Chrome's WebGPU) over Direct3D 12, compiling WGSL at startup"
        }`,
        "",
        "Run:",
        `  ${target.platform === "win32" ? `Double-click ${exeName}. Its console window shows startup errors.` : `Run ./${exeName} from a terminal in this directory.`}`,
        "",
        "Controls:",
        "  Scene-defined keyboard and pointer input remains available to the demo.",
        "  Where an ArcRotate camera is attached, left drag orbits,",
        "  right/middle drag pans, and the mouse wheel zooms. Camera controls do not",
        "  consume keyboard input.",
        "",
        "Troubleshooting:",
        `  - Requires ${requirements}. bblitec renders only`,
        "    on a GPU; there is no software path, so a device that cannot be",
        "    brought up is an error rather than a slower picture.",
        ...notes,
        "",
        ...(fidelity.length > 0
            ? [
                  `Current development ${target.graphicsApi} fidelity baseline (versus the pinned browser reference):`,
                  ...fidelity,
                  "",
              ]
            : []),
        "Compiler source:",
        "  https://github.com/sailro/bblitec",
        `  ${field("package")} ${field("version")}`,
        `  Pinned upstream commit: ${field("sourceVersion")}`,
        "",
        "Third-party notices are included in the licenses directory.",
    ];
    return `${lines.join(target.newline)}${target.newline}`;
}

/**
 * The shader files a package of `backend` carries: SDL_GPU loads .dxil,
 * .spv or Metal .msl plus the .slots sidecars naming each pinned variant's
 * register order; Dawn compiles the .native.wgsl text in-process. Other
 * intermediates are development artifacts.
 */
export function desktopShaderSuffixes(
    backend: CompiledNativeBackend,
    platform: ShippingPlatform,
): string[] {
    if (backend === "DAWN") return [".native.wgsl"];
    return [
        platform === "win32"
            ? ".dxil"
            : platform === "darwin"
              ? ".msl"
              : ".spv",
        ".slots",
    ];
}

/**
 * The build trees a desktop package of `options.scene` merges (macOS: the
 * x86_64 and arm64 slices), each refused unless it is the exact mini shape
 * of the scene. `architectureOf` names a thin executable's architecture.
 */
export function validateDesktopBuilds(
    options: DesktopPackageOptions,
    architectureOf: (executable: string) => string = (executable) =>
        checked(
            "lipo",
            ["-archs", executable],
            `Unable to read the architectures of ${executable}`,
        ).trim(),
): Slice[] {
    const root =
        options.root ??
        findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
    const target = host(options.platform ?? shippingPlatform());
    const { scene } = options;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(scene))
        throw new Error(
            `Shipping requires a generated scene id made from lowercase letters, digits, and interior hyphens; got '${scene}'.`,
        );
    if (options.arm64BuildDirectory && target.platform !== "darwin")
        throw new Error("An arm64 slice requires macOS.");
    const buildDirectories = [
        resolve(root, options.buildDirectory),
        ...(target.platform === "darwin"
            ? [
                  resolve(
                      root,
                      options.arm64BuildDirectory ??
                          `native/build-${scene}-min-sdl-arm64`,
                  ),
              ]
            : []),
    ];
    const slices: Slice[] = [];
    for (const [index, buildDirectory] of buildDirectories.entries())
        slices.push(
            readSlice(
                scene,
                buildDirectory,
                index,
                options,
                target,
                root,
                slices[0],
                architectureOf,
            ),
        );
    return slices;
}

/** Packages, qualifies and publishes the desktop demo; returns its receipt. */
export function packageDesktopDemo(
    options: DesktopPackageOptions,
): DesktopPackageReceipt {
    const root =
        options.root ??
        findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
    const target = host(options.platform ?? shippingPlatform());
    const { scene } = options;
    const slices = validateDesktopBuilds({ ...options, root });
    const buildDirectories = slices.map((slice) => slice.buildDirectory);
    const first = slices[0]!;
    const backend = first.backend;
    const runtimeDirectory = dirname(first.executable);
    const outputRoot = resolve(root, options.outputRoot);
    const name = desktopPackageName(scene, backend, target.platform);
    const previousExe = join(
        outputRoot,
        name,
        `bblitec-${scene}${target.exeExtension}`,
    );
    const previousZip = join(outputRoot, `${name}.zip`);
    const plan = newPackageOutput(outputRoot, name);
    const packageDirectory = join(plan.staging, name);
    const exeName = `bblitec-${scene}${target.exeExtension}`;
    const staged = join(packageDirectory, exeName);
    mkdirSync(join(packageDirectory, "shaders"), { recursive: true });
    mkdirSync(join(packageDirectory, "assets"), { recursive: true });

    if (target.platform === "darwin") {
        checked(
            "lipo",
            [
                "-create",
                ...slices.map((slice) => slice.executable),
                "-output",
                staged,
            ],
            "Unable to combine the macOS executable slices",
        );
        checked(
            "lipo",
            [staged, "-verify_arch", "x86_64", "arm64"],
            "The staged executable is not universal",
        );
    } else {
        copyFileSync(first.executable, staged);
    }
    if (target.platform !== "win32") {
        const strip = first.cache.CMAKE_STRIP;
        if (!strip || !existsSync(strip))
            throw new Error("CMAKE_STRIP must name the native strip tool.");
        checked(
            strip,
            [target.platform === "darwin" ? "-x" : "--strip-unneeded", staged],
            "Unable to strip the staged executable",
        );
        chmodSync(staged, 0o755);
        if (target.platform === "darwin") {
            checked(
                "codesign",
                ["--force", "--sign", "-", staged],
                "Unable to ad-hoc sign the staged executable",
            );
            checked(
                "codesign",
                ["--verify", "--strict", "--all-architectures", staged],
                "Unable to verify both signed executable slices",
            );
        }
    }
    // Statically linked builds carry SDL (and Windows Dawn) inside the executable.
    if (
        existsSync(join(runtimeDirectory, "SDL3.dll")) ||
        (backend === "DAWN" &&
            existsSync(join(runtimeDirectory, "webgpu_dawn.dll")))
    )
        throw new Error(
            `Shipping requires the fully static mini dependencies; runtime DLLs were found beside ${first.executable}.`,
        );
    const assets = join(runtimeDirectory, "assets");
    if (existsSync(assets))
        cpSync(assets, join(packageDirectory, "assets"), { recursive: true });
    // The runtime reads only its compiled backend's shader formats: SDL_GPU
    // loads .dxil/.spv or Metal .msl plus the .slots sidecars naming each
    // pinned variant's register order; Dawn compiles the .native.wgsl text
    // in-process. Other intermediates are development artifacts.
    const suffixes = desktopShaderSuffixes(backend, target.platform);
    const shaderSource = join(runtimeDirectory, "shaders");
    const shaders = readdirSync(shaderSource, { withFileTypes: true }).filter(
        (entry) =>
            entry.isFile() &&
            suffixes.some((suffix) => entry.name.endsWith(suffix)),
    );
    if (shaders.length === 0)
        throw new Error(
            `No shader payload matched ${suffixes.join(", ")} under ${shaderSource}.`,
        );
    for (const shader of shaders)
        copyFileSync(
            join(shaderSource, shader.name),
            join(packageDirectory, "shaders", shader.name),
        );

    const profile = readShippingProfile(
        options.cmake,
        first.generatedDirectory,
    );
    copyPackageNotices(
        packageNotices({
            platform: target.notices,
            cache: first.cache,
            runtime: profile.runtime,
            codecs: profile.codecs,
        }),
        join(packageDirectory, "licenses"),
    );
    writeFileSync(
        join(packageDirectory, "README.txt"),
        readme(scene, backend, exeName, target, root),
    );
    const sources = [
        ...new Set(
            readCompiledAssetSources(first.generatedDirectory, scene).filter(
                (source) => /^https?:\/\//.test(source),
            ),
        ),
    ].sort();
    if (sources.length > 0)
        writeFileSync(
            join(packageDirectory, "ASSET-SOURCES.txt"),
            `${sources.join(target.newline)}${target.newline}`,
        );

    if (target.platform === "win32") {
        verifyWindowsImports(packageDirectory, runtimeDirectory);
        // The shipped executable is not long-path aware: a payload file whose
        // full path reaches MAX_PATH fails to open at startup.
        const tooLong = packageFiles(packageDirectory)
            .map((file) => join(packageDirectory, file))
            .filter((path) => path.length >= 260)
            .sort((left, right) => right.length - left.length);
        if (tooLong.length > 0)
            throw new Error(
                `Staged payload paths reach Windows' 260-character limit (${tooLong.length} files; longest ${tooLong[0]!.length}: ${tooLong[0]!}). Choose a shorter output root.`,
            );
    } else {
        writeFileSync(
            join(packageDirectory, "RUNTIME-LIBRARIES.txt"),
            `${unixRuntimeLibraries(staged, target, root).join("\n")}\n`,
        );
    }

    const smoke = smokeRun(staged, packageDirectory, plan.staging, target);
    archivePackage(plan, options.cmake);
    const exe = fileIdentity(staged);
    const zip = fileIdentity(join(plan.staging, `${name}.zip`));
    const receipt: DesktopPackageReceipt = {
        scene,
        backend,
        platform: target.name,
        graphicsApi: target.graphicsApi,
        buildDirectory: first.buildDirectory,
        exeBytes: exe.bytes,
        zipBytes: zip.bytes,
        unpackedBytes: packageFiles(packageDirectory).reduce(
            (sum, file) => sum + statSync(join(packageDirectory, file)).size,
            0,
        ),
        exeSha256: exe.sha256,
        zipSha256: zip.sha256,
        previousExeBytes: existsSync(previousExe)
            ? statSync(previousExe).size
            : null,
        previousZipBytes: existsSync(previousZip)
            ? statSync(previousZip).size
            : null,
        smokeFrames,
        smokeExit: smoke.exit,
        architectures: target.architectures,
        smokeArchitecture: smoke.architecture,
        buildDirectories,
    };
    writePackageReceipt(plan, { ...receipt });
    publishPackageOutput(plan);
    return receipt;
}

/**
 * The staged package must start: it runs from the package directory for a
 * few frames (BBLITE_MAX_FRAMES, the run limit every backend's loop honours)
 * with GPU validation and must exit cleanly. A shader the payload lacks, a
 * device the trimmed dependencies cannot bring up or a library the loader
 * cannot resolve fails here, before the archive exists, with the tail of the
 * program's output.
 */
function smokeRun(
    staged: string,
    packageDirectory: string,
    staging: string,
    target: Host,
): { exit: number; architecture: string } {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (
            key.toUpperCase().startsWith("BBLITE_") ||
            (target.platform === "linux" &&
                ["LD_LIBRARY_PATH", "LD_PRELOAD"].includes(key)) ||
            (target.platform === "darwin" && key.startsWith("DYLD_"))
        )
            continue;
        environment[key] = value;
    }
    Object.assign(environment, {
        BBLITE_MAX_FRAMES: String(smokeFrames),
        BBLITE_GPU_DEBUG: "1",
        BBLITE_TEST_PASS: "1",
        BBLITE_LOCAL_STORAGE_ROOT: join(staging, "smoke-storage"),
        SDL_GPU_DRIVER: target.gpuDriver,
        SDL_ASSERT: "abort",
    });
    // macOS selects the native host slice explicitly, even when the tools run
    // under Rosetta; the receipt names the architecture actually tested.
    // Named as the receipt's `architectures` entries name the slices.
    const architecture =
        target.platform !== "darwin"
            ? "x64"
            : process.arch === "arm64"
              ? "arm64"
              : "x86_64";
    const [command, args] =
        target.platform === "darwin"
            ? ["/usr/bin/arch", [`-${architecture}`, staged]]
            : [staged, []];
    const result = spawnSync(command, args, {
        cwd: packageDirectory,
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        timeout: smokeTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
    });
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        .split(/\r?\n/)
        .filter((line) => line !== "");
    writeFileSync(join(staging, "smoke-output.txt"), `${log.join("\n")}\n`);
    const tail = log.slice(-40).join("\n");
    const exeName = basename(staged);
    if (result.error)
        throw new Error(
            `Package smoke run did not complete: ${exeName}: ${result.error.message} (${smokeTimeoutMs / 1000} s bound, ${smokeFrames} frames). Output tail:\n${tail}`,
        );
    if (result.status !== 0)
        throw new Error(
            `Package smoke run failed: ${exeName} exited with ${result.status ?? result.signal} after at most ${smokeFrames} frames. Output tail:\n${tail}`,
        );
    console.log(
        `Smoke run: ${exeName} rendered ${smokeFrames} frames and exited 0.`,
    );
    return { exit: result.status, architecture };
}

/** `npm run package:demo`: one desktop package, or a mobile one through its platform script. */
async function main(): Promise<void> {
    const parsed = parseFlags(
        process.argv.slice(2),
        {
            value: [
                "--scene",
                "--build-directory",
                "--arm64-build-directory",
                "--backend",
                "--output",
                "--platform",
                "--sdk",
                "--device",
                "--abi",
                "--jobs",
            ],
        },
        "package:demo",
    );
    const scene = parsed.values.get("--scene");
    if (!scene)
        throw new Error(
            "package:demo --scene <id> [--build-directory <dir>] [--arm64-build-directory <dir>] [--backend sdl_gpu|dawn] [--output <dir>]\n" +
                "Android: --platform android --sdk <sdk> --device <serial> [--abi arm64-v8a|x86_64] [--backend sdl_gpu|dawn] [--jobs N]\n" +
                "iOS: --platform ios [--jobs N]",
        );
    const platform = parsed.values.get("--platform") ?? "host";
    if (platform === "android" || platform === "ios") {
        const [{ runMobilePackages }, { selectShippingScenes }] =
            await Promise.all([
                import("./shipping-mobile.js"),
                import("./shipping-demos.js"),
            ]);
        const values = new Map(parsed.values);
        values.delete("--platform");
        values.delete("--scene");
        await runMobilePackages(
            platform,
            selectShippingScenes(scene),
            values,
            false,
        );
        return;
    }
    if (platform !== "host")
        throw new Error("--platform must be host, android or ios.");
    for (const flag of ["--sdk", "--device", "--abi"])
        if (parsed.values.has(flag))
            throw new Error(`${flag} applies to Android packages.`);
    if (flagNumber(parsed, "--jobs", "package:demo") !== undefined)
        throw new Error("--jobs applies to mobile packages.");
    const backend = parsed.values.get("--backend");
    const expectBackend =
        backend === undefined
            ? undefined
            : compiledBackend(parseBackendName(backend, "--backend", false));
    const cmake = discoverDevelopmentTools().cmake;
    if (!cmake)
        throw new Error("Packaging requires CMake; run npm run doctor.");
    const target = shippingPlatform();
    const arm64 = parsed.values.get("--arm64-build-directory");
    const receipt = packageDesktopDemo({
        scene,
        buildDirectory:
            parsed.values.get("--build-directory") ??
            `native/build-${scene}-min-sdl${target === "darwin" ? "-x86_64" : ""}`,
        ...(arm64 !== undefined ? { arm64BuildDirectory: arm64 } : {}),
        ...(expectBackend !== undefined ? { expectBackend } : {}),
        outputRoot: parsed.values.get("--output") ?? "artifacts/releases",
        cmake,
    });
    console.log(
        `Created ${join(resolve(parsed.values.get("--output") ?? "artifacts/releases"), `${desktopPackageName(scene, receipt.backend, target)}.zip`)} (${receipt.backend} payload)`,
    );
}

if (isMainModule(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
