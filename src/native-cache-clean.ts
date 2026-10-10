import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface CacheEntry {
    path: string;
    bytes: number;
    lastUsedMs: number;
}

/** Include every input's timestamp, and refuse an entry containing a link. */
function entryState(path: string): Omit<CacheEntry, "path"> | undefined {
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return undefined;
    if (stat.isFile()) return { bytes: stat.size, lastUsedMs: stat.mtimeMs };
    if (!stat.isDirectory()) return undefined;
    let bytes = 0;
    let lastUsedMs = stat.mtimeMs;
    for (const name of readdirSync(path)) {
        const child = entryState(join(path, name));
        if (!child) return undefined;
        bytes += child.bytes;
        lastUsedMs = Math.max(lastUsedMs, child.lastUsedMs);
    }
    return { bytes, lastUsedMs };
}

function unlinkedPath(path: string): boolean {
    for (let current = resolve(path); ; current = dirname(current)) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            return false;
        if (dirname(current) === current) return true;
    }
}

function cacheEntryState(path: string): Omit<CacheEntry, "path"> | undefined {
    if (!unlinkedPath(path)) return undefined;
    const state = entryState(path);
    if (!state) return undefined;
    const lock = path.replace(/\.partial$/, "") + ".lock";
    if (existsSync(lock)) {
        const lockState = entryState(lock);
        if (!lockState) return undefined;
        state.lastUsedMs = Math.max(state.lastUsedMs, lockState.lastUsedMs);
    }
    return state;
}

/** The support inputs only; ccache owns the object cache and its eviction. */
export function oldNativeCacheEntries(
    root: string,
    days = 30,
    now = Date.now(),
): CacheEntry[] {
    if (!Number.isFinite(days) || days <= 0)
        throw new Error("clean: --cache-days must be a positive number.");
    if (!unlinkedPath(root)) return [];
    const cutoff = now - days * 86_400_000;
    const result: CacheEntry[] = [];
    for (const family of ["headers", "sources", "pch"]) {
        const directory = resolve(root, family);
        if (!existsSync(directory) || !unlinkedPath(directory)) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            // Lock files stay: removing one can split CMake's lock identity.
            const managed =
                family === "headers"
                    ? entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name)
                    : entry.isFile() &&
                      (family === "sources"
                          ? /-[0-9a-f]{16}\.[^.]+(?:\.partial)?$/.test(
                                entry.name,
                            )
                          : /^bblite_pch-[0-9a-f]{16}\.cxx(?:\.partial)?$/.test(
                                entry.name,
                            ));
            if (!managed || entry.isSymbolicLink()) continue;
            const path = join(directory, entry.name);
            const state = cacheEntryState(path);
            if (!state) continue;
            if (state.lastUsedMs < cutoff) result.push({ path, ...state });
        }
    }
    return result.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Entries of a result cache whose every entry is one top-level file or
 * folder (`artifacts/code-quality-cache`, `artifacts/native-fixture-cache`)
 * unused for `days`: last used is the newest time inside it.
 */
export function oldResultCacheEntries(
    root: string,
    days = 30,
    now = Date.now(),
): CacheEntry[] {
    if (!Number.isFinite(days) || days <= 0)
        throw new Error("clean: --cache-days must be a positive number.");
    if (!existsSync(root) || !unlinkedPath(root)) return [];
    const cutoff = now - days * 86_400_000;
    const result: CacheEntry[] = [];
    for (const name of readdirSync(root)) {
        if (name === prunedMarker) continue;
        const path = join(root, name);
        const state = cacheEntryState(path);
        if (state && state.lastUsedMs < cutoff) result.push({ path, ...state });
    }
    return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function pruneResultCache(root: string, days = 30): CacheEntry[] {
    const removed: CacheEntry[] = [];
    for (const entry of oldResultCacheEntries(root, days)) {
        const current = cacheEntryState(entry.path);
        if (!current || current.lastUsedMs >= Date.now() - days * 86_400_000)
            continue;
        rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry);
    }
    return removed;
}

/** The marker whose time records a result cache's last pruning pass. */
const prunedMarker = ".pruned";

/** Prunes a result cache at most once a day, so opening one stays cheap. */
export function pruneResultCacheDaily(root: string, days = 30): void {
    const marker = join(root, prunedMarker);
    const pruned = existsSync(marker) ? lstatSync(marker).mtimeMs : undefined;
    if (pruned !== undefined && Date.now() - pruned < 86_400_000) return;
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, "");
    pruneResultCache(root, days);
}

/** Recheck the paths and age at deletion, including a concurrent configure's touch. */
export function pruneNativeCache(root: string, days = 30): CacheEntry[] {
    const removed: CacheEntry[] = [];
    for (const entry of oldNativeCacheEntries(root, days)) {
        const current = cacheEntryState(entry.path);
        if (!current || current.lastUsedMs >= Date.now() - days * 86_400_000)
            continue;
        rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry);
    }
    return removed;
}
