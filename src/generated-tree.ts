// Content-addressed writes for the generated tree.
//
// Rewriting an unchanged file bumps its mtime, which invalidates every
// object downstream of it -- including the shared PAL translation units,
// once per scene. Writing only what actually changed keeps the build
// graph honest instead of rebuilding a scene that generated identically.
//
// The comparison is exact bytes and nothing else: a normalized or partial
// comparison could keep an out-of-date file on disk, which is the one
// failure this must never have. Every uncertain case -- a missing file, a
// size mismatch, an unreadable file -- falls through to the write, so the
// failure mode is "rebuild more", never "rebuild less".
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";

export class GeneratedTree {
    private readonly written = new Set<string>();

    public constructor(public readonly root: string) {}

    /** Write a file only when its bytes differ from what is on disk. */
    public write(
        relativePath: string,
        data: string | Uint8Array,
    ): void {
        const path = resolve(this.root, relativePath);
        this.written.add(this.key(path));
        const bytes =
            typeof data === "string"
                ? Buffer.from(data, "utf8")
                : Buffer.from(data);
        if (this.matches(path, bytes)) {
            return;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    }

    /** Record a file this run produced through another writer. */
    public keep(relativePath: string): void {
        this.written.add(
            this.key(resolve(this.root, relativePath)),
        );
    }

    /**
     * Delete everything under `directory` that this run did not write.
     * Generation used to remove the tree up front, which is what made
     * every file new; pruning afterwards keeps deletions correct without
     * touching the files that stayed the same.
     *
     * Shader compilation runs after generation and writes its DXIL, HLSL,
     * MSL, SPIR-V and reflection outputs into the same tree, so those are
     * kept while the WGSL they were compiled from is still emitted, and
     * deleted with it when a scene stops reaching that shader.
     */
    public prune(relativeDirectory: string): void {
        const directory = resolve(
            this.root,
            relativeDirectory,
        );
        if (!existsSync(directory)) {
            return;
        }
        for (const path of this.files(directory)) {
            const key = this.key(path);
            if (this.written.has(key)) {
                continue;
            }
            if (this.isLiveShaderArtifact(key)) {
                continue;
            }
            rmSync(path, { force: true });
        }
        this.pruneEmptyDirectories(directory);
    }

    /**
     * A downstream shader artifact whose source WGSL this run emitted.
     * `pbr.frag.native.wgsl` compiles to `pbr.frag.dxil` and friends, and
     * `shader-compiler.json` records the toolchain for the directory.
     */
    private isLiveShaderArtifact(key: string): boolean {
        const match =
            /^(.*\/shaders\/)([^/]+?)\.(?:dxil|hlsl|msl|spv|tint-reflection\.txt)$/.exec(
                key,
            );
        if (match) {
            return this.written.has(
                `${match[1]}${match[2]}.native.wgsl`,
            );
        }
        return /\/shaders\/shader-compiler\.json$/.test(key);
    }

    private matches(path: string, bytes: Buffer): boolean {
        try {
            if (!existsSync(path)) {
                return false;
            }
            const stats = statSync(path);
            if (!stats.isFile() || stats.size !== bytes.length) {
                return false;
            }
            return readFileSync(path).equals(bytes);
        } catch {
            return false;
        }
    }

    private key(path: string): string {
        return relative(this.root, path)
            .replace(/\\/g, "/")
            .toLowerCase();
    }

    private files(directory: string, out: string[] = []): string[] {
        for (const entry of readdirSync(directory, {
            withFileTypes: true,
        })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                this.files(full, out);
            } else {
                out.push(full);
            }
        }
        return out;
    }

    private pruneEmptyDirectories(directory: string): boolean {
        let empty = true;
        for (const entry of readdirSync(directory, {
            withFileTypes: true,
        })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!this.pruneEmptyDirectories(full)) {
                    empty = false;
                }
            } else {
                empty = false;
            }
        }
        if (empty) {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
        return empty;
    }
}

// ---------------------------------------------------------------------------
// `scene -- neutrality-generated` — the compile-and-digest proof
//
// docs/development.md's neutrality ladder: a change confined to
// TypeScript is proved by compiling every registered scene and digesting
// the generated tree — byte-identical output means identical build
// stamps, identical binaries, unmoved measurements. The digest half kept
// being retyped as a throwaway script; these functions are that script,
// with its one footgun handled instead of re-stepped-on: a corpus sweep
// or a deleted probe leaves top-level directories under `generated/`
// that no registry scene owns, and hashing those silently makes two
// identical compiles digest differently. They are returned for the
// caller to list loudly, and excluded from the digest.
//
// Digesting is all this does — the caller compiles first.
// ---------------------------------------------------------------------------

export interface GeneratedTreeDigest {
    /** `generated/<path>\t<sha1>`, sorted by path. */
    lines: string[];
    /** Top-level entries under the root that no registry scene owns,
     *  excluded from `lines`. */
    strays: string[];
}

function listFiles(directory: string, out: string[]): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            listFiles(full, out);
        } else {
            out.push(full);
        }
    }
}

/**
 * Hash every file under the registry-owned directories below `root`
 * (sha1, one `<rootName>/<path>\t<hash>` line per file, forward slashes,
 * sorted). `ownedDirectories` are the scenes' output directories; a
 * top-level entry outside that set is a stray, listed rather than
 * hashed.
 */
export function digestGeneratedTree(
    root: string,
    ownedDirectories: readonly string[],
): GeneratedTreeDigest {
    const resolvedRoot = resolve(root);
    const rootName = basename(resolvedRoot);
    const lines: string[] = [];
    const strays: string[] = [];
    if (!existsSync(resolvedRoot)) {
        return { lines, strays };
    }
    const owned = new Set(
        ownedDirectories.map((directory) =>
            relative(resolvedRoot, resolve(directory)).replace(/\\/g, "/"),
        ),
    );
    for (const entry of readdirSync(resolvedRoot, {
        withFileTypes: true,
    })) {
        if (!entry.isDirectory() || !owned.has(entry.name)) {
            strays.push(entry.name);
            continue;
        }
        const files: string[] = [];
        listFiles(join(resolvedRoot, entry.name), files);
        for (const file of files) {
            const relativePath = relative(resolvedRoot, file).replace(
                /\\/g,
                "/",
            );
            const digest = createHash("sha1")
                .update(readFileSync(file))
                .digest("hex");
            lines.push(`${rootName}/${relativePath}\t${digest}`);
        }
    }
    lines.sort();
    strays.sort();
    return { lines, strays };
}

/**
 * A baseline file's `<path>\t<hash>` lines as a map. Strict: a line that
 * is not that shape means the file is not a digest baseline, and
 * tolerating it would let a truncated baseline pass a comparison.
 */
export function parseDigestBaseline(text: string): Map<string, string> {
    const map = new Map<string, string>();
    text.split(/\r?\n/).forEach((line, index) => {
        if (line === "") return;
        const tab = line.indexOf("\t");
        if (tab <= 0 || tab === line.length - 1) {
            throw new Error(
                `Baseline line ${index + 1} is not '<path>\\t<sha1>': '${line}'.`,
            );
        }
        map.set(line.slice(0, tab), line.slice(tab + 1));
    });
    return map;
}

export interface GeneratedDigestComparison {
    added: string[];
    removed: string[];
    changed: string[];
    unchanged: number;
}

export function compareGeneratedDigest(
    baseline: ReadonlyMap<string, string>,
    currentLines: readonly string[],
): GeneratedDigestComparison {
    const added: string[] = [];
    const changed: string[] = [];
    let unchanged = 0;
    const seen = new Set<string>();
    for (const line of currentLines) {
        const tab = line.indexOf("\t");
        const path = tab >= 0 ? line.slice(0, tab) : line;
        const hash = tab >= 0 ? line.slice(tab + 1) : "";
        seen.add(path);
        const before = baseline.get(path);
        if (before === undefined) {
            added.push(path);
        } else if (before !== hash) {
            changed.push(path);
        } else {
            unchanged += 1;
        }
    }
    const removed = [...baseline.keys()]
        .filter((path) => !seen.has(path))
        .sort();
    return { added, removed, changed, unchanged };
}
