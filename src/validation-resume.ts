import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { compiledShaderArtifactExtensions } from "./generated-tree.js";

export interface ValidationSceneInput {
    id: string;
    output: string;
}

interface CompletedStage {
    input: string;
    output: string;
}

/**
 * The shader stage's reuse record. Generation's own currency is answered
 * per scene by `src/generation-stamp.ts`, so this checkpoint carries the
 * one stage that has no record of its own.
 */
export interface ValidationCheckpoint {
    shaders?: CompletedStage;
    version: 1;
}

function filesUnder(path: string): string[] {
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    if (stat.isFile()) return [path];
    const files: string[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) files.push(...filesUnder(child));
        else if (entry.isFile()) files.push(child);
    }
    return files;
}

export function hashEntries(entries: readonly string[]): string {
    return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** SHA-256 over the bytes of every file under each path, missing paths included. */
export function contentFingerprint(paths: readonly string[]): string {
    const entries: string[] = [];
    const roots = [...new Set(paths.map((path) => resolve(path)))].sort();
    for (const root of roots) {
        if (!existsSync(root)) {
            entries.push(`${root}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            entries.push(
                `${file}\t${createHash("sha256")
                    .update(readFileSync(file))
                    .digest("hex")}`,
            );
        }
    }
    return hashEntries(entries);
}

/** A file's identity without reading it: its path, size and mtime. */
export function toolIdentity(path: string | undefined): string {
    if (!path || !existsSync(path)) return "missing";
    const stat = statSync(path);
    return `${resolve(path)}\t${stat.size}\t${stat.mtimeMs}`;
}

/**
 * SHA-256 over size and mtime of every file under each root that `include`
 * accepts: whether a set of outputs is still the set a run wrote, without
 * reading them.
 */
export function metadataFingerprint(
    roots: readonly string[],
    include: (relativePath: string) => boolean,
): string {
    return metadataFingerprints(roots, [include])[0]!;
}

/**
 * One walk, several digests: each predicate selects the files its digest
 * covers, so two views of one directory tree cost one `readdir` pass.
 */
export function metadataFingerprints(
    roots: readonly string[],
    includes: readonly ((relativePath: string) => boolean)[],
): string[] {
    const entries: string[][] = includes.map(() => []);
    const uniqueRoots = [
        ...new Set(roots.map((path) => resolve(path))),
    ].sort();
    for (const root of uniqueRoots) {
        if (!existsSync(root)) {
            for (const list of entries) list.push(`${root}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            const path = relative(root, file).replaceAll("\\", "/");
            let identity: string | undefined;
            includes.forEach((include, index) => {
                if (!include(path)) return;
                identity ??= `${root}/${path}\t${toolIdentity(file).split("\t").slice(1).join("\t")}`;
                entries[index]!.push(identity);
            });
        }
    }
    return entries.map(hashEntries);
}

/** A file `tools/compile-shaders.ps1` owns inside a generated tree. */
export function isCompiledShaderOutput(path: string): boolean {
    return (
        compiledShaderArtifactExtensions.some((extension) =>
            path.endsWith(extension),
        ) ||
        path === "shader-compiler.json" ||
        path.endsWith("/shader-compiler.json")
    );
}

export function validationShaderInput(
    shaderSources: string,
    target: string,
    tools: { dxc: string | undefined; tint: string | undefined },
    repositoryRoot = process.cwd(),
): string {
    return hashEntries([
        shaderSources,
        target,
        toolIdentity(tools.dxc),
        toolIdentity(tools.tint),
        contentFingerprint([
            resolve(repositoryRoot, "tools", "compile-shaders.ps1"),
        ]),
    ]);
}

/**
 * The two digests of the shader directories, from one walk: what the
 * shader compiler reads (every file it did not itself write -- narrower
 * than the whole generated tree on purpose, so a build-stamp refresh after
 * a PAL edit does not re-run the stage) and what it produced.
 */
export function shaderDirectoryFingerprints(
    scenes: readonly ValidationSceneInput[],
): { sources: string; products: string } {
    const [sources, products] = metadataFingerprints(
        scenes.map((scene) => resolve(scene.output, "upstream", "shaders")),
        [(path) => !isCompiledShaderOutput(path), isCompiledShaderOutput],
    );
    return { sources: sources!, products: products! };
}

export function readValidationCheckpoint(
    path: string,
): ValidationCheckpoint {
    if (!existsSync(path)) return { version: 1 };
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<
            ValidationCheckpoint
        >;
        return value.version === 1
            ? (value as ValidationCheckpoint)
            : { version: 1 };
    } catch {
        return { version: 1 };
    }
}

/** Write a JSON record atomically: a reader never sees a partial file. */
export function writeJsonRecord(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

export function writeValidationCheckpoint(
    path: string,
    checkpoint: ValidationCheckpoint,
): void {
    writeJsonRecord(path, checkpoint);
}
