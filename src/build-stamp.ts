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
//   * the deployed payload (shaders and assets copied beside the
//     executable) -- compared file by file, because a failed shader step
//     leaves the previous binaries in place next to a valid executable;
//   * the build configuration (the CMake cache values that select the
//     backend, generator and toolchain) -- read from the build directory
//     rather than embedded, so one generated tree can serve the release
//     build and a minimal-size build without either looking stale.
//
// The stamp deliberately covers the whole tracked native source set
// rather than the subset a configuration compiles: `BBLITE_CPU_FALLBACK`
// drops a translation unit, and the same sources must digest identically
// whether or not it is compiled in.
import { createHash } from "node:crypto";
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

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
            out.push(
                relative(root, full).replace(/\\/g, "/"),
            );
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
function compiledGeneratedFiles(
    generatedDirectory: string,
): string[] {
    return walkFiles(generatedDirectory)
        .filter(
            (path) =>
                path === "main.cpp" ||
                path === "features.cmake" ||
                (path.startsWith("upstream/") &&
                    /\.(cpp|hpp)$/.test(path)),
        )
        .filter((path) => path !== buildStampHeaderPath)
        .sort();
}

/** The handwritten native sources every configuration is built from. */
function nativeSourceFiles(repositoryRoot: string): string[] {
    const nativeRoot = resolve(repositoryRoot, "native");
    const tracked = ["CMakeLists.txt"];
    for (const directory of ["src", "include"]) {
        for (const path of walkFiles(
            resolve(nativeRoot, directory),
        )) {
            tracked.push(`${directory}/${path}`);
        }
    }
    return tracked.sort();
}

/**
 * Digest the compiled inputs of a generated scene. The result is
 * independent of the build configuration, so every build directory built
 * from this tree reports the same stamp.
 */
export function computeBuildStamp(
    generatedDirectory: string,
    repositoryRoot = process.cwd(),
): BuildStamp {
    const inputs: StampInput[] = [];
    for (const path of compiledGeneratedFiles(
        generatedDirectory,
    )) {
        inputs.push({
            path: `generated/${path}`,
            sha256: digest(
                readFileSync(
                    resolve(generatedDirectory, path),
                ),
            ),
        });
    }
    for (const path of nativeSourceFiles(repositoryRoot)) {
        inputs.push({
            path: `native/${path}`,
            sha256: digest(
                readFileSync(
                    resolve(repositoryRoot, "native", path),
                ),
            ),
        });
    }
    const stamp = digest(
        Buffer.from(
            inputs
                .map(
                    (input) =>
                        `${input.path} ${input.sha256}`,
                )
                .join("\n"),
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

/**
 * Compare a deployed directory beside the executable against the
 * generated tree it was copied from. `copy_directory` runs post-build, so
 * a mismatch means the deployment never ran or its source changed after
 * the last build.
 */
export function comparePayload(
    sourceDirectory: string,
    deployedDirectory: string,
): PayloadMismatch[] {
    const mismatches: PayloadMismatch[] = [];
    if (!existsSync(sourceDirectory)) {
        return mismatches;
    }
    const expected = new Set(walkFiles(sourceDirectory));
    for (const path of expected) {
        const deployed = resolve(deployedDirectory, path);
        if (
            !existsSync(deployed) ||
            !statSync(deployed).isFile()
        ) {
            mismatches.push({ path, reason: "missing" });
            continue;
        }
        if (
            !readFileSync(
                resolve(sourceDirectory, path),
            ).equals(readFileSync(deployed))
        ) {
            mismatches.push({ path, reason: "changed" });
        }
    }
    for (const path of walkFiles(deployedDirectory)) {
        // The build's own marker files (CMake stamps the shader snapshot
        // with `.snapshot-stamp`) are not payload.
        if (path.split("/").pop()?.startsWith(".")) {
            continue;
        }
        if (!expected.has(path)) {
            mismatches.push({
                path,
                reason: "unexpected",
            });
        }
    }
    return mismatches;
}

/** The CMake cache entries that shape what a build directory produces. */
export function readCacheConfiguration(
    buildDirectory: string,
): Record<string, string> | undefined {
    const cachePath = resolve(
        buildDirectory,
        "CMakeCache.txt",
    );
    if (!existsSync(cachePath)) {
        return undefined;
    }
    const values: Record<string, string> = {};
    for (const line of readFileSync(cachePath, "utf8").split(
        /\r?\n/,
    )) {
        const match = /^([A-Za-z0-9_]+):[A-Z]+=(.*)$/.exec(
            line,
        );
        if (match) {
            values[match[1]!] = match[2]!;
        }
    }
    return values;
}
