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

/**
 * A file's SHA-256, keyed by its size and mtime: a population run asks
 * for the same pinned sources and native headers hundreds of times in one
 * process, and reads each once. A file whose size or mtime moved is read
 * again, so an edit during the run is still seen.
 */
const contentDigests = new Map<
    string,
    { size: number; mtimeMs: number; sha256: string }
>();

export function contentDigest(path: string): string {
    const stat = statSync(path);
    const cached = contentDigests.get(path);
    if (
        cached &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs
    ) {
        return cached.sha256;
    }
    const sha256 = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    contentDigests.set(path, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
    });
    return sha256;
}

/**
 * SHA-256 over the bytes of every file under each path, missing paths
 * included. Paths enter the digest relative to the working directory, so
 * two checkouts of the same content (a worktree beside the main tree)
 * agree on one fingerprint and one shared vcpkg install stamp.
 */
export function contentFingerprint(paths: readonly string[]): string {
    const entries: string[] = [];
    const roots = [...new Set(paths.map((path) => resolve(path)))].sort();
    for (const root of roots) {
        const rootKey = relative(process.cwd(), root).replaceAll("\\", "/");
        if (!existsSync(root)) {
            entries.push(`${rootKey}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            const fileKey = relative(root, file).replaceAll("\\", "/");
            entries.push(`${rootKey}/${fileKey}\t${contentDigest(file)}`);
        }
    }
    return hashEntries(entries);
}

/**
 * A tool's identity without reading it: its path, size and mtime. Right
 * for an installed executable, which nothing rewrites in place; wrong for
 * a repository file, which a checkout, rebase or stash rewrites with the
 * same bytes and a new mtime (`contentIdentity`).
 */
export function toolIdentity(path: string | undefined): string {
    if (!path || !existsSync(path)) return "missing";
    const stat = statSync(path);
    return `${resolve(path)}\t${stat.size}\t${stat.mtimeMs}`;
}

/** A repository file's identity: its bytes, so a byte-identical checkout is the same file. */
export function contentIdentity(path: string): string {
    if (!existsSync(path)) return "missing";
    return contentDigest(path);
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
    const entries: string[] = [];
    const uniqueRoots = [
        ...new Set(roots.map((path) => resolve(path))),
    ].sort();
    for (const root of uniqueRoots) {
        if (!existsSync(root)) {
            entries.push(`${root}\tmissing`);
            continue;
        }
        for (const file of filesUnder(root).sort()) {
            const path = relative(root, file).replaceAll("\\", "/");
            if (include(path)) entries.push(`${root}/${path}\t${toolIdentity(file).split("\t").slice(1).join("\t")}`);
        }
    }
    return hashEntries(entries);
}

/** An offline shader compiler product inside a generated tree. */
export function isCompiledShaderOutput(path: string): boolean {
    return (
        compiledShaderArtifactExtensions.some((extension) =>
            path.endsWith(extension),
        ) ||
        path === "shader-compiler.json" ||
        path.endsWith("/shader-compiler.json")
    );
}

/** Write a JSON record atomically: a reader never sees a partial file. */
export function writeJsonRecord(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}
