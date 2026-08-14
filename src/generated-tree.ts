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
