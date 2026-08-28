// A registered asset's bytes, read synchronously at entry compilation.
//
// The entry compiler is synchronous by design, and asset materialization
// normally happens after it — but a handle collection's members are the
// materialized asset's own animation groups, and `.find` over one resolves
// at generation, so the document has to be readable while `main.cpp` is
// still being emitted. The resolution mirrors the CLI's `assetBytes`
// exactly (data URL → decode, repository path → read beside the entry,
// URL → the download cache): the same source yields the same bytes the
// later materialization packages.
//
// The one asymmetry is a cache miss on a URL: Node has no synchronous
// fetch, so the miss is served by a short-lived child process running the
// repository's own `downloadCached` — which also warms the cache for the
// materialization that follows. The child is the cache module, not a
// second copy of it, so the cache layout stays single-sourced.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDataUrl } from "../data-url.js";

/** One decode per (source) within a compile; documents are small. */
const bytesBySource = new Map<string, Uint8Array>();

export function readAssetBytesSync(
    source: string,
    entryFileName: string,
): Uint8Array {
    const cached = bytesBySource.get(source);
    if (cached) return cached;
    const bytes = readUncached(source, entryFileName);
    bytesBySource.set(source, bytes);
    return bytes;
}

/** Reads only the fixed PNG header fields, and only when a dimension is used. */
export function readPngDimensionsSync(
    source: string,
    entryFileName: string,
): { width: number; height: number } | undefined {
    const bytes = readAssetBytesSync(source, entryFileName);
    if (
        bytes.length < 24 ||
        bytes[0] !== 0x89 ||
        bytes[1] !== 0x50 ||
        bytes[2] !== 0x4e ||
        bytes[3] !== 0x47 ||
        bytes[12] !== 0x49 ||
        bytes[13] !== 0x48 ||
        bytes[14] !== 0x44 ||
        bytes[15] !== 0x52
    ) {
        return undefined;
    }
    const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    );
    return {
        width: view.getUint32(16, false),
        height: view.getUint32(20, false),
    };
}

function readUncached(
    source: string,
    entryFileName: string,
): Uint8Array {
    const inline = parseDataUrl(source);
    if (inline) return inline.bytes;
    if (!/^https?:\/\//i.test(source)) {
        return new Uint8Array(
            readFileSync(
                resolve(dirname(resolve(entryFileName)), source),
            ),
        );
    }
    return downloadCachedSyncBridge(source);
}

/**
 * `downloadCached(url)` run to completion in a child, its bytes returned
 * over stdout as base64. The cache module resolves relative to this file's
 * own compiled location, so the bridge works from `dist` and from a
 * scratch `tsc` build alike.
 */
function downloadCachedSyncBridge(url: string): Uint8Array {
    const cacheModule = new URL(
        "../asset-download-cache.js",
        import.meta.url,
    ).href;
    const script =
        `const url = process.env.BBLITE_SYNC_ASSET_URL;\n` +
        `import(process.env.BBLITE_SYNC_ASSET_MODULE)\n` +
        `    .then((cache) => cache.downloadCached(url))\n` +
        `    .then((bytes) => {\n` +
        `        process.stdout.write(Buffer.from(bytes).toString("base64"));\n` +
        `    })\n` +
        `    .catch((error) => {\n` +
        `        console.error(String(error?.message ?? error));\n` +
        `        process.exit(1);\n` +
        `    });\n`;
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                BBLITE_SYNC_ASSET_URL: url,
                BBLITE_SYNC_ASSET_MODULE: cacheModule,
            },
            encoding: "utf8",
            maxBuffer: 512 * 1024 * 1024,
        },
    );
    if (child.status !== 0) {
        throw new Error(
            `Reading '${url}' at generation failed: ` +
                `${(child.stderr || child.error?.message || "no output").trim()}`,
        );
    }
    return new Uint8Array(Buffer.from(child.stdout.trim(), "base64"));
}
