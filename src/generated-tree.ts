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
import { dirname, join, relative, resolve } from "node:path";
import { listFiles } from "./tooling/records.js";

/**
 * Every artifact extension `src/compile-shaders.ts` derives from one
 * `.native.wgsl` stem. The pruning rule below and every keep-alive for a
 * stem another module declares consume this one list, so a new offline
 * artifact kind cannot be pruned by half the consumers.
 */
export const compiledShaderArtifactExtensions = [
    ".dxil",
    ".hlsl",
    ".msl",
    ".demote.spv",
    ".spv",
    ".slots",
    ".tint-reflection.txt",
] as const;

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

const compiledShaderArtifactPattern = new RegExp(
    `^(.*/shaders/)([^/]+?)(?:${compiledShaderArtifactExtensions
        .map((extension) => extension.replace(/[.\\]/g, "\\$&"))
        .join("|")})$`,
);

export class GeneratedTree {
    private readonly written = new Set<string>();

    public constructor(public readonly root: string) {}

    /**
     * Write a file only when its bytes differ from what is on disk.
     * Returns whether it wrote, which is the one fact a caller refreshing
     * a derived file wants to report.
     */
    public write(relativePath: string, data: string | Uint8Array): boolean {
        const path = resolve(this.root, relativePath);
        this.written.add(this.key(path));
        const bytes =
            typeof data === "string"
                ? Buffer.from(data, "utf8")
                : Buffer.from(data);
        if (this.matches(path, bytes)) {
            return false;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        return true;
    }

    /** Record a file this run produced through another writer. */
    public keep(relativePath: string): void {
        this.written.add(this.key(resolve(this.root, relativePath)));
    }

    /**
     * Delete everything under `directory` that this run did not write.
     * Generation used to remove the tree up front, which is what made
     * every file new; pruning afterwards keeps deletions correct without
     * touching the files that stayed the same.
     *
     * Shader compilation runs after generation and writes its target-selected
     * binary/source and reflection outputs into the same tree, so those are
     * kept while the WGSL they were compiled from is still emitted, and
     * deleted with it when a scene stops reaching that shader.
     */
    public prune(relativeDirectory: string): void {
        const directory = resolve(this.root, relativeDirectory);
        if (!existsSync(directory)) {
            return;
        }
        for (const path of listFiles(directory)) {
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
     * `pbr.vert.native.wgsl` compiles to the selected offline artifact and
     * intermediates, and `shader-compiler.json` records the target/toolchain.
     */
    private isLiveShaderArtifact(key: string): boolean {
        const match = compiledShaderArtifactPattern.exec(key);
        if (match) {
            return this.written.has(`${match[1]}${match[2]}.native.wgsl`);
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
        return relative(this.root, path).replace(/\\/g, "/").toLowerCase();
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
