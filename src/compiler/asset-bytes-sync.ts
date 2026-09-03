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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localAssetPath } from "../asset-source.js";
import { parseDataUrl } from "../data-url.js";
import { runGenerationChild } from "./generation-child.js";

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
export function pngDimensions(
    bytes: Uint8Array,
): { width: number; height: number } | undefined {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
        bytes.length < 24 ||
        signature.some((byte, index) => bytes[index] !== byte) ||
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

export function readPngDimensionsSync(
    source: string,
    entryFileName: string,
): { width: number; height: number } | undefined {
    return pngDimensions(readAssetBytesSync(source, entryFileName));
}

function readUncached(
    source: string,
    entryFileName: string,
): Uint8Array {
    const inline = parseDataUrl(source);
    if (inline) return inline.bytes;
    const local = localAssetPath(source, resolve(entryFileName));
    if (local) {
        return new Uint8Array(readFileSync(local));
    }
    if (source.startsWith("generated:")) {
        throw new Error(
            "Generated assets have no source bytes to read synchronously.",
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
    return new Uint8Array(
        Buffer.from(
            runGenerationChild({
                script,
                label: `Reading '${url}' at generation`,
                env: {
                    BBLITE_SYNC_ASSET_URL: url,
                    BBLITE_SYNC_ASSET_MODULE: cacheModule,
                },
                maxBuffer: 512 * 1024 * 1024,
            }),
            "base64",
        ),
    );
}
