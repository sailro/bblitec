/**
 * Clean clang-tidy results, reused across runs.
 *
 * A result is keyed by everything one invocation reads: the clang-tidy
 * executable and its arguments, `.clang-tidy`, the shared compilation key
 * (frontend flags, header search, precompiled-header bytes) and the
 * identity of its source and of every header the build's dependency log
 * names for its object. Only a clean result is stored, so a diagnostic is
 * reported by every run that meets it. A unit whose object is older than
 * one of its inputs has a dependency list the build has not refreshed, so
 * it is checked and never stored. Paths inside the checkout enter keys
 * relative to it, so worktrees sharing the cache share results.
 */
import { existsSync, lstatSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cachePathKey as pathKey } from "./build-stamp.js";
import { pruneResultCacheDaily } from "./native-cache-clean.js";
import {
    hashEntries,
    inputIdentity,
    withoutRepositoryRoot,
} from "./tooling/records.js";

/** Bumped when the key's composition changes, retiring every stored result. */
const lintCacheSchema = 2;

/**
 * `ninja -t deps` as object path -> the inputs its last compile read, both
 * resolved against the build directory and keyed like cache paths. A stale
 * record no longer describes its object's inputs and is left out.
 */
export function ninjaDependencies(
    log: string,
    buildDirectory: string,
): Map<string, string[]> {
    const dependencies = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of log.split(/\r?\n/)) {
        const target =
            /^(\S.*?): #deps \d+, deps mtime \d+ \((VALID|STALE)\)$/.exec(line);
        if (target) {
            current = target[2] === "VALID" ? [] : undefined;
            if (current)
                dependencies.set(
                    pathKey(resolve(buildDirectory, target[1]!)),
                    current,
                );
            continue;
        }
        const input = /^\s+(\S.*)$/.exec(line);
        if (input && current) current.push(resolve(buildDirectory, input[1]!));
    }
    return dependencies;
}

/** The first input missing or newer than an output written at `outputModified`. */
export function newerInput(
    outputModified: number,
    inputs: readonly { path: string; modified: number | undefined }[],
): string | undefined {
    return inputs.find(
        ({ modified }) => modified === undefined || modified > outputModified,
    )?.path;
}

/**
 * The inputs whose identity decides one unit's result, or undefined when
 * the build has not refreshed its dependency record since they changed.
 */
export function currentLintInputs(
    source: string,
    object: string | undefined,
    dependencies: ReadonlyMap<string, readonly string[]>,
    modified: (path: string) => number | undefined,
): string[] | undefined {
    if (!object) return undefined;
    const recorded = dependencies.get(pathKey(object));
    const built = modified(object);
    if (!recorded || built === undefined) return undefined;
    const inputs = [...new Set([source, ...recorded])];
    return newerInput(
        built,
        inputs.map((path) => ({ path, modified: modified(path) })),
    ) === undefined
        ? inputs
        : undefined;
}

/** One key over the invocation's description and its inputs' identities. */
export function lintResultKey(
    invocation: readonly unknown[],
    inputs: readonly string[],
    root: string,
): string {
    return hashEntries([
        // Each string is rewritten before JSON escapes its backslashes.
        JSON.stringify([lintCacheSchema, ...invocation], (_name, value) =>
            typeof value === "string"
                ? withoutRepositoryRoot(value, root)
                : (value as unknown),
        ),
        ...inputs
            .map(
                (input) =>
                    `${withoutRepositoryRoot(pathKey(input), root)}\t${inputIdentity(input, root)}`,
            )
            .sort(),
    ]);
}

/** Stored clean results, one marker file per key. */
export class LintResultCache {
    public constructor(private readonly directory: string) {
        pruneResultCacheDaily(directory);
    }

    /** Whether `key` has a clean result; a hit is marked used, once a day at most. */
    public has(key: string): boolean {
        const path = join(this.directory, key);
        if (!existsSync(path)) return false;
        if (Date.now() - lstatSync(path).mtimeMs > 86_400_000) {
            const now = new Date();
            utimesSync(path, now, now);
        }
        return true;
    }

    public store(key: string, source: string): void {
        writeFileSync(join(this.directory, key), `${source}\n`);
    }
}
