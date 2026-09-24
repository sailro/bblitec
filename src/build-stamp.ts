// Build identity for a generated scene.
//
// The matrix is only trustworthy if the executable it measures was built
// from the inputs currently on disk. Three things determine what a run
// renders, and each is verified separately because each fails
// differently:
//
//   * the compiled inputs (generated C++ plus the handwritten native
//     sources) -- digested here and embedded in the executable, so a
//     binary built from older sources reports a different stamp;
//   * the deployed payload (the compiled renderers' shaders and the
//     assets copied beside the executable) -- compared file by file,
//     because a failed shader step leaves the previous binaries in place
//     next to a valid executable;
//   * the build configuration (the CMake cache values that select the
//     backend, generator and toolchain) -- read from the build directory
//     rather than embedded, so one generated tree can serve the release
//     build and a minimal-size build without either looking stale.
//
// The stamp deliberately covers the whole tracked native source set
// rather than the subset a configuration compiles: `BBLITE_BACKEND`
// drops a backend's translation units, and the same sources must digest
// identically whichever backends are compiled in.
import { createHash } from "node:crypto";
import {
    existsSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { contentDigest } from "./validation-resume.js";

/** The generated header the executable embeds. */
export const buildStampHeaderPath =
    "upstream/include/bblite/upstream/build_stamp.hpp";
/** The digest listing, kept beside the generated sources for diagnosis. */
export const buildStampInputsPath = "build-inputs.json";

export interface StampInput {
    path: string;
    sha256: string;
}

export interface BuildStamp {
    stamp: string;
    inputs: StampInput[];
}

function digest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function walkFiles(
    root: string,
    directory = root,
    out: string[] = [],
): string[] {
    if (!existsSync(directory)) {
        return out;
    }
    for (const entry of readdirSync(directory, {
        withFileTypes: true,
    })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            walkFiles(root, full, out);
        } else if (entry.isFile()) {
            out.push(relative(root, full).replace(/\\/g, "/"));
        }
    }
    return out;
}

/**
 * Files under a generated scene directory that the executable compiles.
 * Shaders and assets are deployed rather than compiled, so they are
 * verified against the deployment instead of the binary; the stamp's own
 * outputs are excluded because they are derived from this list.
 */
function compiledGeneratedFiles(generatedDirectory: string): string[] {
    return (
        walkFiles(generatedDirectory)
            .filter(
                (path) =>
                    path === "main.cpp" ||
                    path === "features.cmake" ||
                    ((path.startsWith("upstream/") ||
                        path.startsWith("sources/")) &&
                        /\.(cpp|hpp)$/.test(path)),
            )
            // The listing is not a compiled file, so the filter above already
            // leaves it out; `isGenerationOutput` in generation-stamp.ts names
            // the same pair when it decides what generation itself wrote.
            .filter((path) => path !== buildStampHeaderPath)
            .sort()
    );
}

function nativeBuildFiles(repositoryRoot: string): string[] {
    const nativeRoot = resolve(repositoryRoot, "native");
    return [
        "CMakeLists.txt",
        ...(existsSync(nativeRoot)
            ? readdirSync(nativeRoot).filter((name) => name.endsWith(".cmake"))
            : []),
    ];
}

/** The handwritten native sources every configuration is built from. */
function nativeSourceFiles(repositoryRoot: string): string[] {
    const nativeRoot = resolve(repositoryRoot, "native");
    const tracked = nativeBuildFiles(repositoryRoot);
    for (const directory of ["src", "include"]) {
        for (const path of walkFiles(resolve(nativeRoot, directory))) {
            tracked.push(`${directory}/${path}`);
        }
    }
    return tracked.sort();
}

/**
 * Digest the compiled inputs of a generated scene. The result is
 * independent of the build configuration, so every build directory built
 * from this tree reports the same stamp. `generatedInputs` is the
 * generated half already known to be current -- a stamp refresh over a
 * tree whose generated files were just proved unchanged passes the
 * previous listing's entries and digests only the native sources.
 */
export function computeBuildStamp(
    generatedDirectory: string,
    repositoryRoot = process.cwd(),
    generatedInputs?: readonly StampInput[],
): BuildStamp {
    const inputs: StampInput[] = [];
    if (generatedInputs) {
        inputs.push(...generatedInputs);
    } else {
        for (const path of compiledGeneratedFiles(generatedDirectory)) {
            inputs.push({
                path: `generated/${path}`,
                // This path also handles explicit post-generation changes,
                // including same-size writes within one filesystem clock tick.
                sha256: digest(readFileSync(resolve(generatedDirectory, path))),
            });
        }
    }
    // The native source set is the same for every scene and a population
    // run stamps every scene in one process; the digest cache reads the
    // ~2.5 MB of handwritten sources once rather than 229 times.
    for (const path of nativeSourceFiles(repositoryRoot)) {
        inputs.push({
            path: `native/${path}`,
            sha256: contentDigest(resolve(repositoryRoot, "native", path)),
        });
    }
    const stamp = digest(
        Buffer.from(
            inputs.map((input) => `${input.path} ${input.sha256}`).join("\n"),
            "utf8",
        ),
    );
    return { stamp, inputs };
}

/** The generated header body carrying the stamp into the executable. */
export function buildStampHeader(stamp: string): string {
    return `#pragma once

// Digest of the generated and native sources this executable was built
// from. bblitec recomputes it before measuring a scene and refuses a
// binary whose stamp no longer matches its inputs.
#define BBLITE_BUILD_STAMP "${stamp}"
`;
}

export interface PayloadMismatch {
    path: string;
    reason: "missing" | "changed" | "unexpected";
}

/** The renderer set a build directory compiles, as `BBLITE_BACKEND` names it. */
export type CompiledBackend = "SDL_GPU" | "DAWN" | "BOTH";

/**
 * The shader files a build's compiled renderers read, by name suffix. The
 * deploy step in `native/CMakeLists.txt` copies by the same table:
 * SDL_GPU loads the platform's offline binary (`.dxil`, Metal `.msl`,
 * otherwise SPIR-V `.spv`) plus the `.slots` sidecars naming each variant's
 * register order; Dawn compiles the `.native.wgsl` text in-process. HLSL,
 * reflection dumps, WGSL sources and tool manifests stay in the generated
 * tree as development artifacts.
 */
export function deployedShaderSuffixes(
    backend: CompiledBackend,
    platform: NodeJS.Platform = process.platform,
): readonly string[] {
    const sdlGpu = [
        platform === "win32"
            ? ".dxil"
            : platform === "darwin"
              ? ".msl"
              : ".spv",
        ".slots",
    ];
    const dawn = [".native.wgsl"];
    return backend === "SDL_GPU"
        ? sdlGpu
        : backend === "DAWN"
          ? dawn
          : [...sdlGpu, ...dawn];
}

/**
 * The renderer set recorded in the CMake cache of the build that produced
 * the executable in `executableDirectory` -- the directory itself under
 * Ninja, its parent under a multi-configuration generator.
 */
export function executableBuildBackend(
    executableDirectory: string,
): CompiledBackend {
    for (const directory of [
        executableDirectory,
        resolve(executableDirectory, ".."),
    ]) {
        const backend = readCacheConfiguration(directory)?.BBLITE_BACKEND;
        if (backend === undefined) continue;
        if (backend === "SDL_GPU" || backend === "DAWN" || backend === "BOTH") {
            return backend;
        }
        throw new Error(
            `${directory}/CMakeCache.txt names an unknown BBLITE_BACKEND '${backend}'.`,
        );
    }
    throw new Error(
        `No CMake cache with BBLITE_BACKEND beside ${executableDirectory}; ` +
            "the deployed shader payload depends on the compiled backends. " +
            "Build the scene with 'scene -- process' first.",
    );
}

/** One directory a build deploys beside its executable. */
export interface DeployedPayload {
    label: "shaders" | "assets";
    source: string;
    deployed: string;
    /** Whether the build deploys this source file (a `/`-separated relative path). */
    deploys: (path: string) => boolean;
}

/**
 * What a build deploys beside its executable, as source/destination pairs:
 * every generated asset, and the shader files its compiled renderers read.
 *
 * Two callers read it: the prune that removes what the generated tree no
 * longer has, and the guard that refuses to measure a stale one. They have to
 * agree on the set, or the guard reports something the prune never visits.
 */
export function deployedPayloads(
    executableDirectory: string,
    generatedDirectory: string,
): DeployedPayload[] {
    const shaderSuffixes = deployedShaderSuffixes(
        executableBuildBackend(executableDirectory),
    );
    return [
        {
            label: "shaders",
            source: resolve(generatedDirectory, "upstream/shaders"),
            deployed: resolve(executableDirectory, "shaders"),
            deploys: (path) =>
                shaderSuffixes.some((suffix) => path.endsWith(suffix)),
        },
        {
            label: "assets",
            source: resolve(generatedDirectory, "assets"),
            deployed: resolve(executableDirectory, "assets"),
            deploys: () => true,
        },
    ];
}

/** The source files a payload deploys, as `/`-separated relative paths. */
function expectedPayload({
    source,
    deploys,
}: Pick<DeployedPayload, "source" | "deploys">): Set<string> {
    return new Set(walkFiles(source).filter(deploys));
}

/**
 * Compare a deployed directory beside the executable against the
 * generated tree it was copied from. The deploy runs post-build, so
 * a mismatch means the deployment never ran or its source changed after
 * the last build.
 */
export function comparePayload(
    payload: Pick<DeployedPayload, "source" | "deployed" | "deploys">,
): PayloadMismatch[] {
    const mismatches: PayloadMismatch[] = [];
    if (!existsSync(payload.source)) {
        return mismatches;
    }
    const expected = expectedPayload(payload);
    for (const path of expected) {
        const deployed = resolve(payload.deployed, path);
        if (!existsSync(deployed) || !statSync(deployed).isFile()) {
            mismatches.push({ path, reason: "missing" });
            continue;
        }
        if (
            !readFileSync(resolve(payload.source, path)).equals(
                readFileSync(deployed),
            )
        ) {
            mismatches.push({ path, reason: "changed" });
        }
    }
    for (const path of orphansAgainst(expected, payload.deployed)) {
        mismatches.push({ path, reason: "unexpected" });
    }
    return mismatches;
}

/** The names-only walk behind the `unexpected` entries, shared by
 *  `comparePayload` and `payloadOrphans` so the guard and the prune
 *  cannot disagree about what an orphan is. */
function orphansAgainst(
    expected: ReadonlySet<string>,
    deployedDirectory: string,
): string[] {
    const orphans: string[] = [];
    for (const path of walkFiles(deployedDirectory)) {
        // The build's own marker files (CMake stamps the shader snapshot
        // with `.snapshot-stamp`) are not payload.
        if (path.split("/").pop()?.startsWith(".")) {
            continue;
        }
        if (!expected.has(path)) {
            orphans.push(path);
        }
    }
    return orphans;
}

/**
 * Deployed files the generated tree no longer has — `comparePayload`'s
 * `unexpected` entries, computed without byte-comparing every expected
 * file first. The pre-build prune reads only these, so hashing the whole
 * matching payload to find them was pure cost; the measured-run guard
 * keeps the full byte-compare through `comparePayload`.
 */
export function payloadOrphans(
    payload: Pick<DeployedPayload, "source" | "deployed" | "deploys">,
): string[] {
    if (!existsSync(payload.source)) {
        return [];
    }
    return orphansAgainst(expectedPayload(payload), payload.deployed);
}

/** The CMake cache entries that shape what a build directory produces. */
export function readCacheConfiguration(
    buildDirectory: string,
): Record<string, string> | undefined {
    const cachePath = resolve(buildDirectory, "CMakeCache.txt");
    if (!existsSync(cachePath)) {
        return undefined;
    }
    const values: Record<string, string> = {};
    for (const line of readFileSync(cachePath, "utf8").split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_]+):[A-Z]+=(.*)$/.exec(line);
        if (match) {
            values[match[1]!] = match[2]!;
        }
    }
    return values;
}

export interface IncompatibleCacheEntry {
    cached?: string;
    name: string;
    requested?: string;
}

function requestedCacheConfiguration(
    configureArguments: readonly string[],
): Record<string, string> {
    const requested: Record<string, string> = {};
    const generatorIndex = configureArguments.indexOf("-G");
    if (generatorIndex >= 0 && configureArguments[generatorIndex + 1]) {
        requested.CMAKE_GENERATOR = configureArguments[generatorIndex + 1]!;
    }
    for (const argument of configureArguments) {
        if (!argument.startsWith("-D")) continue;
        const separator = argument.indexOf("=");
        if (separator > 2) {
            requested[argument.slice(2, separator)] = argument.slice(
                separator + 1,
            );
        }
    }
    return requested;
}

export function cachePathKey(path: string): string {
    const absolute = resolve(path);
    // CMake's in-build regeneration rewrites tool paths in their short DOS
    // spelling (C:/PROGRA~1/...); an existing file compares by its final path.
    const canonical = existsSync(absolute)
        ? realpathSync.native(absolute)
        : absolute;
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sameCachePath(left: string, right: string): boolean {
    return left === right || cachePathKey(left) === cachePathKey(right);
}

/**
 * Cache values CMake cannot safely change in place.
 *
 * Ordinary project options can be reconfigured. A generator, compiler,
 * make program, toolchain, or vcpkg install root belongs to the build tree
 * itself; a mismatch means that disposable tree must be recreated before
 * configure. The unset toolchain direction matters because CMake otherwise
 * retains a toolchain accidentally omitted from a later invocation.
 */
export function incompatibleCacheEntries(
    cache: Readonly<Record<string, string>>,
    configureArguments: readonly string[],
): IncompatibleCacheEntry[] {
    const requested = requestedCacheConfiguration(configureArguments);
    const sticky = [
        "CMAKE_GENERATOR",
        "CMAKE_CXX_COMPILER",
        "CMAKE_MAKE_PROGRAM",
        "CMAKE_TOOLCHAIN_FILE",
        "VCPKG_INSTALLED_DIR",
    ] as const;
    const compareWhenUnset = new Set([
        "CMAKE_TOOLCHAIN_FILE",
        "VCPKG_INSTALLED_DIR",
    ]);
    const mismatches: IncompatibleCacheEntry[] = [];
    for (const name of sticky) {
        const cached = cache[name];
        const wanted = requested[name];
        if (cached === undefined) {
            if (wanted !== undefined) {
                mismatches.push({ name, requested: wanted });
            }
            continue;
        }
        if (wanted === undefined) {
            if (compareWhenUnset.has(name) && cached) {
                mismatches.push({ name, cached });
            }
            continue;
        }
        const matches =
            name === "CMAKE_GENERATOR"
                ? cached === wanted
                : sameCachePath(cached, wanted);
        if (!matches) {
            mismatches.push({ name, cached, requested: wanted });
        }
    }
    return mismatches;
}

/**
 * Whether CMake would regenerate a build tree before compiling it.
 *
 * `CMakeCache.txt` is configuration state, not a generation timestamp:
 * CMake leaves its mtime unchanged when a successful configure does not
 * change any cached value. `cmake.check_cache` is the generator-owned marker
 * refreshed by that configure, so it records that newer configure inputs were
 * already consumed.
 */
export function generatorWouldReconfigure(
    buildDirectory: string,
    generatedDirectory: string,
    repositoryRoot = process.cwd(),
): boolean {
    const generationMarker = resolve(
        buildDirectory,
        "CMakeFiles",
        "cmake.check_cache",
    );
    if (!existsSync(generationMarker)) return true;
    const generationTime = statSync(generationMarker).mtimeMs;
    const configureInputs = [
        ...nativeBuildFiles(repositoryRoot).map((path) =>
            resolve(repositoryRoot, "native", path),
        ),
        resolve(repositoryRoot, "native", "vcpkg.json"),
        resolve(generatedDirectory, "features.cmake"),
    ];
    return configureInputs.some(
        (input) =>
            existsSync(input) && statSync(input).mtimeMs > generationTime,
    );
}
