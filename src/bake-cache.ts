/**
 * A content-addressed replay cache for the deterministic executed bakes.
 *
 * Seven generation steps EXECUTE pinned or scene code instead of folding
 * it — the HDR GGX prefilter, the Basis transcode, the node-particle
 * simulation, the drawn sprite atlas / computed pixel modules, the
 * pinned BRDF-LUT compute, the Canvas2D data-URL helpers (all six in
 * headless Chromium), and the CPU-side DDS/splat parses — and re-run it
 * on every compile of the scenes that reach them: a measured 10–15 s of
 * CPU per `compile all`, and the full Chromium launch on every dev-loop
 * recompile of those scenes. The bakes are deterministic in their
 * declared inputs, so their results replay: each call site keys its
 * inputs here and, on a hit, gets the previous run's exact bytes back
 * without launching anything.
 *
 * The key is everything the bytes depend on:
 *   - the bake `kind` and a per-kind `version` string, bumped when the
 *     packager's contract changes;
 *   - the calling packager module's own compiled source
 *     (`moduleIdentity`), so a forgotten bump still misses rather than
 *     replaying bytes an edited packager would no longer produce;
 *   - the upstream pin (package, version, source commit) — the executed
 *     code is the pin's;
 *   - for the Chromium bakes, the resolved browser executable's
 *     path/size/mtime — the baked bytes depend on the Chrome that ran
 *     them, and a cache that survived a browser update would replay
 *     bytes a cold run no longer produces, breaking the
 *     delete-equals-cold contract;
 *   - the caller's parameters, JSON-canonicalized;
 *   - the input payloads, hashed.
 *
 * The cache directory (`artifacts/bake-cache`) is disposable: deleting
 * it is a cold start, and the generated tree must digest identically
 * either way. A miss behaves exactly as an uncached run — the bake runs
 * and its result is returned even if the store-back fails. Node's test
 * runner (`NODE_TEST_CONTEXT`) and `BBLITE_BAKE_CACHE=0` disable the
 * cache entirely: a determinism gate that re-runs a bake must measure
 * the bake, not the replay.
 */
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cacheRoot = join("artifacts", "bake-cache");

function cacheEnabled(): boolean {
    if (process.env.BBLITE_BAKE_CACHE === "0") return false;
    // Under `node --test` the existing determinism gates re-run bakes
    // and compare; serving the second run from cache would make them
    // compare the cache to itself.
    if (process.env.NODE_TEST_CONTEXT !== undefined) return false;
    return true;
}

function sha256(payload: string | Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
}

/**
 * The calling module's own identity: the sha256 of its compiled source.
 * Pass `import.meta.url`. An edit to the packager then misses the cache
 * even when its author forgot to bump the version string — the
 * rebuild-more-on-doubt direction.
 */
export function moduleIdentity(moduleUrl: string): string {
    return sha256(readFileSync(fileURLToPath(moduleUrl)));
}

/** The pin component, loaded lazily so importing this module stays free. */
function pinIdentity(): string {
    const requireModule = createRequire(import.meta.url);
    const { readUpstreamPin } =
        requireModule(
            "./upstream-source.js",
        ) as typeof import("./upstream-source.js");
    const pin = readUpstreamPin();
    return `${pin.package}@${pin.version}#${pin.sourceVersion}`;
}

/**
 * The resolved browser's identity for the Chromium bakes: its path plus
 * the executable's size and mtime — a Chrome update moves both, and the
 * bytes those bakes produce are pinned to the Chrome that ran them.
 * Undefined when no browser resolves; the caller then skips the cache
 * and lets the bake fail exactly as it does today.
 */
function browserIdentity(): string | undefined {
    try {
        const requireModule = createRequire(import.meta.url);
        const { resolveBrowserPath } =
            requireModule(
                "./browser-path.js",
            ) as typeof import("./browser-path.js");
        const path = resolveBrowserPath();
        const stats = statSync(path);
        return `${path}|${stats.size}|${stats.mtimeMs}`;
    } catch {
        return undefined;
    }
}

interface BakeKey {
    /** `hdr-prefilter`, `basis-transcode`, `node-particle`,
     *  `executed-module`, `ibl-brdf-lut`, `browser-generated-string`,
     *  `dds-package`, `splat-ply`. */
    kind: string;
    /** Bumped when the bake's contract changes. */
    version: string;
    /** `moduleIdentity(import.meta.url)` of the packager. */
    module: string;
    /** Whether the bake runs in headless Chromium; the browser identity
     *  then joins the key. */
    browser: boolean;
    /** JSON-serializable parameters; key order is canonicalized. */
    parameters: Record<string, unknown>;
    /** The input payloads, hashed into the key in order. */
    inputs: readonly Uint8Array[];
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(
                ([name, entry]) =>
                    `${JSON.stringify(name)}:${canonicalJson(entry)}`,
            )
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** The cache file for a key, or undefined when the key cannot be
 *  computed (no browser for a browser bake) or the cache is disabled. */
function cachePath(key: BakeKey): string | undefined {
    if (!cacheEnabled()) return undefined;
    const browser = key.browser ? browserIdentity() : "cpu";
    if (browser === undefined) return undefined;
    const payload = [
        `kind:${key.kind}`,
        `version:${key.version}`,
        `module:${key.module}`,
        `pin:${pinIdentity()}`,
        `browser:${browser}`,
        `parameters:${canonicalJson(key.parameters)}`,
        ...key.inputs.map((input, index) => `input${index}:${sha256(input)}`),
    ].join("\n");
    return resolve(cacheRoot, `${key.kind}-${sha256(payload)}.bin`);
}

/**
 * Replay `bake`'s bytes from the cache, or run it and store them.
 *
 * On a miss the bake's result is returned even when the store-back
 * fails — a full disk must not turn a working compile into a broken
 * one — and the store is temp-file-plus-rename so a concurrent compile
 * of another scene sharing an asset never reads a half-written entry.
 */
export async function cachedBake(
    key: BakeKey,
    bake: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
    const path = cachePath(key);
    const replayed = replayBake(path);
    if (replayed !== undefined) return replayed;
    const produced = await bake();
    storeBake(path, produced);
    return produced;
}

/** `cachedBake` for the bakes reached from synchronous callers: the CPU
 *  parses (DDS, splat PLY) and the compiler walk's Canvas2D data-URL
 *  helper, whose Chromium run is a `spawnSync` subprocess and therefore
 *  synchronous at this boundary. */
export function cachedBakeSync(
    key: BakeKey,
    bake: () => Uint8Array,
): Uint8Array {
    const path = cachePath(key);
    const replayed = replayBake(path);
    if (replayed !== undefined) return replayed;
    const produced = bake();
    storeBake(path, produced);
    return produced;
}

/** A hit's bytes, or undefined on any doubt — a cache entry deleted
 *  from under a running compile means bake, never fail. */
function replayBake(path: string | undefined): Uint8Array | undefined {
    if (path === undefined || !existsSync(path)) return undefined;
    try {
        return readFileSync(path);
    } catch {
        return undefined;
    }
}

/**
 * `cachedBake` for a JSON-shaped result. The stored payload is the
 * JSON text, so the replay round-trips exactly the way the result
 * already round-trips today: every browser bake crosses the page
 * boundary as JSON before any caller sees it.
 */
export async function cachedJsonBake<T>(
    key: BakeKey,
    bake: () => Promise<T>,
): Promise<T> {
    const bytes = await cachedBake(key, async () =>
        Buffer.from(JSON.stringify(await bake()), "utf8"),
    );
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
}

function storeBake(
    path: string | undefined,
    produced: Uint8Array,
): void {
    if (path === undefined) return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
        writeFileSync(temporary, produced);
        try {
            renameSync(temporary, path);
        } catch {
            // A concurrent writer won the rename on Windows; its bytes
            // are the same bytes (same key), so ours can go.
            rmSync(temporary, { force: true });
        }
    } catch (error) {
        console.warn(
            `bake-cache: could not store ${path}: ${
                (error as Error).message
            } (the bake result is used directly).`,
        );
    }
}

/**
 * The transitive bytes of a repository TypeScript module and every
 * relative import it reaches — the input closure of an executed module
 * bake. A scene module may import a sibling (`executed-module-assets.ts`
 * records why), so hashing the named file alone would replay stale
 * bytes after a sibling edit. Package specifiers are not followed — the
 * pinned package is the pin component of the key. Returns undefined
 * when any relative import cannot be resolved to a repository file,
 * and the caller then skips the cache: uncertain inputs mean bake.
 */
export function moduleClosureBytes(
    modulePaths: readonly string[],
    repositoryRoot = resolve("."),
): Uint8Array[] | undefined {
    const visited = new Set<string>();
    const payloads: Uint8Array[] = [];
    const queue = modulePaths.map((path) =>
        resolve(repositoryRoot, path),
    );
    while (queue.length > 0) {
        const path = queue.shift()!;
        const file = resolveModuleFile(path);
        if (file === undefined) return undefined;
        if (!file.startsWith(repositoryRoot)) return undefined;
        if (visited.has(file)) continue;
        visited.add(file);
        const source = readFileSync(file);
        // The file's identity includes its path, so moving a module is
        // a different closure even when its text is not.
        payloads.push(
            Buffer.from(`${file}\n`, "utf8"),
            source,
        );
        for (const specifier of importSpecifiers(
            source.toString("utf8"),
        )) {
            if (!specifier.startsWith(".")) continue;
            queue.push(resolve(dirname(file), specifier));
        }
    }
    return payloads;
}

/** Resolve a specifier target the way the suite server serves it: the
 *  file itself, its `.ts` twin for a `.js` specifier, or the bare
 *  specifier plus `.ts`. */
function resolveModuleFile(path: string): string | undefined {
    const candidates = [
        path,
        path.endsWith(".js") ? `${path.slice(0, -3)}.ts` : `${path}.ts`,
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return undefined;
}

/** Every import/export specifier in a module's text: static, re-export
 *  and dynamic forms. Over-matching (a specifier-looking string in a
 *  comment) only widens the closure, which is the safe direction. */
function importSpecifiers(source: string): string[] {
    const specifiers = new Set<string>();
    for (const pattern of [
        /(?:import|export)\s+[^"'`;]*?from\s*["']([^"']+)["']/g,
        /import\s*["']([^"']+)["']/g,
        /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    ]) {
        for (const match of source.matchAll(pattern)) {
            specifiers.add(match[1]!);
        }
    }
    return [...specifiers];
}
