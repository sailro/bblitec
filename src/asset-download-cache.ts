/**
 * A content cache for downloaded assets.
 *
 * Every asset URL the corpus names is pinned — either to the upstream commit
 * this repository pins (`raw.githubusercontent.com/.../<sha>/...`) or to a
 * versioned CDN path — so the bytes behind a URL never change. Without a cache
 * each compile refetches them, which makes the corpus unbuildable whenever the
 * host is unavailable: a GitHub incident on 2026-08-17 returned HTTP 429 for
 * `assets/brdf-lut.png` and with it blocked every IBL scene, none of whose bytes
 * had changed since the previous build.
 *
 * Seedable without the network. The asset paths under a pinned commit are the
 * paths inside a clone of it, so a local clone at that commit can fill this
 * directory directly.
 *
 * Keyed by the URL's hash rather than by its path, so two scenes naming the same
 * asset through different URLs keep separate entries and a URL that changes
 * misses rather than serving stale bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const directory = resolve(".cache", "assets");

function entryPath(url: string): string {
    return resolve(
        directory,
        createHash("sha256").update(url).digest("hex").slice(0, 32),
    );
}

/**
 * The bytes behind a URL, from the cache when present.
 *
 * A failed request is not cached: the next build retries rather than replaying
 * an error, which is what makes a rate-limited sweep recoverable by waiting.
 */
export async function downloadCached(url: string): Promise<Uint8Array> {
    return (await downloadCachedResource(url)).bytes;
}

/**
 * The same, keeping the response's content type.
 *
 * A remote glTF image can name a type the URL's extension does not, and the
 * packager refuses an image whose type it cannot determine, so the header is
 * cached beside the bytes rather than dropped. Absent for an entry seeded by
 * hand or written before this sidecar existed, which is the same state a
 * response with no header leaves.
 */
export async function downloadCachedResource(
    url: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const path = entryPath(url);
    if (existsSync(path)) {
        const type = existsSync(`${path}.type`)
            ? readFileSync(`${path}.type`, "utf8").trim()
            : "";
        return {
            bytes: new Uint8Array(readFileSync(path)),
            ...(type ? { contentType: type } : {}),
        };
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type")
        ?.split(";", 1)[0];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    if (contentType) writeFileSync(`${path}.type`, contentType);
    return { bytes, ...(contentType ? { contentType } : {}) };
}
