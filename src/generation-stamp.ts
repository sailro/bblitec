// Whether a scene's generated tree is already what generating it again
// would produce.
//
// `scene -- process all` used to regenerate every registered scene on
// every run, because nothing recorded what a generation had read: the
// warm floor of the population loop was the generation stage, paid in
// full for a PAL edit that touched no scene. Generation is a function of
// a small, enumerable input set -- the compiler (`dist`), the pinned
// package, the pins under `upstream/`, the scene's own reached files, the
// CLI arguments, the two environment variables generation reads and the
// browser the bakes run in -- and `manifest.json` lists the reached files,
// so "would this run write the same bytes" is a digest comparison. A hit
// skips the compiler; a miss, or anything the digest cannot see,
// regenerates exactly as before.
//
// Inputs and outputs are both keyed by size and mtime, the identity ninja
// trusts for the same files one step later; hashing content would read
// the Doom WAD and the glTF demos' assets (56 MB over the registry) on
// every no-op run for nothing the mtime does not already say.
//
// The record lives under `artifacts/`, not inside the generated tree:
// `scene -- neutrality-generated` digests every generated file, and a
// record that moves with the compiler's own stamp would make two
// byte-identical generations look different. It carries the input list
// itself, so a staleness check never parses a manifest.
//
// Two things the input digest deliberately does NOT cover, and what
// covers them instead:
//
//   * the handwritten native sources. They reach the tree only through
//     the build stamp, which is derived rather than generated: a hit
//     recomputes it over the unchanged generated C++ and the current
//     native sources and rewrites the two stamp files if they moved, so a
//     PAL edit still refuses a stale binary without regenerating a scene.
//   * the generated files themselves. Hand-instrumenting one under
//     `generated/` has always been undone by the next compile; the output
//     digest keeps that contract, since a rewritten or missing output is a
//     miss.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { browserIdentity } from "./bake-cache.js";
import {
    buildStampHeader,
    buildStampHeaderPath,
    buildStampInputsPath,
    computeBuildStamp,
    type StampInput,
} from "./build-stamp.js";
import { GeneratedTree } from "./generated-tree.js";
import {
    contentFingerprint,
    hashEntries,
    isCompiledShaderOutput,
    metadataFingerprint,
    toolIdentity,
    writeJsonRecord,
} from "./validation-resume.js";

export interface GenerationStamp {
    version: 2;
    /** The repository files the generation read, as the manifest lists them. */
    inputs: string[];
    /** Digest of everything the generation read. */
    input: string;
    /** Digest of the size and mtime of everything it wrote. */
    output: string;
}

export interface GenerationScene {
    id: string;
    output: string;
}

/** Where a scene's record lives; the directory is disposable. */
export function generationStampPath(
    sceneId: string,
    repositoryRoot = process.cwd(),
): string {
    return resolve(
        repositoryRoot,
        "artifacts",
        "generation-stamps",
        `${sceneId}.json`,
    );
}

/**
 * The inputs every scene's generation shares -- the compiler, the pinned
 * package, the pins, the runtime and the browser -- digested once per
 * process rather than once per scene: a population run asks 229 times.
 * `undefined` when there is no compiler stamp to digest.
 */
const sharedInputsByRoot = new Map<string, string | undefined>();

function sharedGenerationInputs(repositoryRoot: string): string | undefined {
    if (sharedInputsByRoot.has(repositoryRoot)) {
        return sharedInputsByRoot.get(repositoryRoot);
    }
    const distStamp = resolve(repositoryRoot, "dist", ".build-stamp");
    const shared = existsSync(distStamp)
        ? hashEntries([
              `node ${process.version}`,
              `dist ${readFileSync(distStamp, "utf8").trim()}`,
              `pins ${contentFingerprint([
                  resolve(repositoryRoot, "package-lock.json"),
                  resolve(repositoryRoot, "upstream"),
              ])}`,
              `CHROME_PATH=${process.env.CHROME_PATH ?? ""}`,
              `BBLITE_BAKE_CACHE=${process.env.BBLITE_BAKE_CACHE ?? ""}`,
              `browser ${browserIdentity() ?? "missing"}`,
          ])
        : undefined;
    sharedInputsByRoot.set(repositoryRoot, shared);
    return shared;
}

/**
 * Digest of everything one generation reads, over a known input list.
 * `undefined` when there is no compiler stamp to digest, which the caller
 * treats as a miss.
 */
function generationInputFingerprint(
    inputs: readonly string[],
    compilerArguments: readonly string[],
    repositoryRoot = process.cwd(),
): string | undefined {
    const shared = sharedGenerationInputs(repositoryRoot);
    if (shared === undefined) return undefined;
    return hashEntries([
        "generation-stamp v2",
        `shared ${shared}`,
        `arguments ${JSON.stringify(compilerArguments)}`,
        ...[...inputs]
            .sort()
            .map(
                (input) =>
                    `${input}\t${toolIdentity(resolve(repositoryRoot, input))}`,
            ),
    ]);
}

/**
 * Whether a generated file is one generation itself wrote, as opposed to
 * the shader compiler's later products or the stamp pair a hit rewrites.
 */
function isGenerationOutput(relativePath: string): boolean {
    return (
        !isCompiledShaderOutput(relativePath) &&
        relativePath !== buildStampHeaderPath &&
        relativePath !== buildStampInputsPath
    );
}

/** Digest of the size and mtime of every file generation wrote. */
export function generationOutputFingerprint(
    outputDirectory: string,
): string {
    return metadataFingerprint([outputDirectory], isGenerationOutput);
}

function readGenerationStamp(
    path: string,
): GenerationStamp | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<
            GenerationStamp
        >;
        if (
            value.version === 2 &&
            Array.isArray(value.inputs) &&
            value.inputs.every((entry) => typeof entry === "string") &&
            typeof value.input === "string" &&
            typeof value.output === "string"
        ) {
            return value as GenerationStamp;
        }
    } catch {
        // An unreadable record is no record.
    }
    return undefined;
}

/**
 * Whether the tree under `scene.output` is what generating `scene` with
 * `compilerArguments` would write now.
 */
export function generationIsCurrent(
    scene: GenerationScene,
    compilerArguments: readonly string[],
    repositoryRoot = process.cwd(),
): boolean {
    const recorded = readGenerationStamp(
        generationStampPath(scene.id, repositoryRoot),
    );
    return (
        recorded !== undefined &&
        generationInputFingerprint(
            recorded.inputs,
            compilerArguments,
            repositoryRoot,
        ) === recorded.input &&
        generationOutputFingerprint(resolve(scene.output)) === recorded.output
    );
}

/**
 * The generated half of the previous stamp listing, reusable on a hit:
 * the output digest has just proved no generated file moved, so their
 * digests are the ones recorded, and only the native half is recomputed.
 * Anything unreadable falls back to digesting the tree.
 */
function recordedGeneratedInputs(
    outputDirectory: string,
): StampInput[] | undefined {
    const listing = resolve(outputDirectory, buildStampInputsPath);
    if (!existsSync(listing)) return undefined;
    try {
        const value = JSON.parse(readFileSync(listing, "utf8")) as {
            inputs?: StampInput[];
        };
        return value.inputs?.filter((input) =>
            input.path.startsWith("generated/"),
        );
    } catch {
        return undefined;
    }
}

/**
 * Rewrite the build stamp pair over an unchanged generated tree so the
 * executable's identity follows the native sources. Returns whether either
 * file moved.
 */
export function refreshBuildStamp(outputDirectory: string): boolean {
    const output = resolve(outputDirectory);
    const { stamp, inputs } = computeBuildStamp(
        output,
        process.cwd(),
        recordedGeneratedInputs(output),
    );
    const tree = new GeneratedTree(output);
    const wroteHeader = tree.write(
        buildStampHeaderPath,
        buildStampHeader(stamp),
    );
    const wroteListing = tree.write(
        buildStampInputsPath,
        `${JSON.stringify({ stamp, inputs }, null, 2)}\n`,
    );
    return wroteHeader || wroteListing;
}

/** The reached-file list the generation just written recorded in its manifest. */
function manifestInputs(outputDirectory: string): string[] | undefined {
    const manifestPath = resolve(outputDirectory, "manifest.json");
    if (!existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        inputs?: unknown;
    };
    return Array.isArray(manifest.inputs) &&
        manifest.inputs.every((entry) => typeof entry === "string")
        ? (manifest.inputs as string[])
        : undefined;
}

/**
 * Record a generation that just completed, unless one of its inputs was
 * written while it ran -- a file edited mid-generation may or may not be
 * in the tree, so no record is written and the next run regenerates.
 * `startedAt` is the millisecond clock reading taken before the compiler
 * was launched.
 */
export function recordGeneration(
    scene: GenerationScene,
    compilerArguments: readonly string[],
    startedAt: number,
    repositoryRoot = process.cwd(),
): boolean {
    const output = resolve(scene.output);
    const inputs = manifestInputs(output);
    if (inputs === undefined) return false;
    const editedDuringRun = inputs.some((input) => {
        const path = resolve(repositoryRoot, input);
        return existsSync(path) && statSync(path).mtimeMs >= startedAt;
    });
    if (editedDuringRun) return false;
    const input = generationInputFingerprint(
        inputs,
        compilerArguments,
        repositoryRoot,
    );
    if (input === undefined) return false;
    writeJsonRecord(generationStampPath(scene.id, repositoryRoot), {
        version: 2,
        inputs,
        input,
        output: generationOutputFingerprint(output),
    } satisfies GenerationStamp);
    return true;
}
