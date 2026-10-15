import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pruneResultCacheDaily } from "../src/native-cache-clean.js";
import {
    contentDigest,
    hashEntries,
    writeJsonRecord,
} from "../src/tooling/records.js";

const formats = ["hlsl", "msl", "spirv"] as const;

/** Validate each distinct byte sequence in all three formats; cache only successes. */
export function validateTintStages(
    tint: string,
    stages: readonly string[],
    cacheDirectory: string,
    cache = process.env.BBLITE_SHADER_TEST_CACHE !== "0",
): { unique: number; compiled: number; reused: number; failures: string[] } {
    const unique = new Map<string, string[]>();
    for (const stage of stages) {
        const digest = contentDigest(stage);
        const paths = unique.get(digest) ?? [];
        paths.push(stage);
        unique.set(digest, paths);
    }
    const identity = [
        "raw-tint-validation-v1",
        process.platform,
        process.arch,
        contentDigest(tint),
        contentDigest(join(dirname(tint), "provenance.json")),
    ];
    if (cache) pruneResultCacheDaily(cacheDirectory);
    const out = mkdtempSync(join(tmpdir(), "bblite-variant-"));
    const result = {
        unique: unique.size,
        compiled: 0,
        reused: 0,
        failures: [] as string[],
    };
    try {
        for (const format of formats) {
            for (const [digest, paths] of unique) {
                const key = hashEntries([
                    ...identity,
                    "--format",
                    format,
                    digest,
                ]);
                const marker = join(cacheDirectory, key);
                if (
                    cache &&
                    existsSync(marker) &&
                    readFileSync(marker, "utf8").trim() === "true"
                ) {
                    const now = new Date();
                    utimesSync(marker, now, now);
                    result.reused++;
                    continue;
                }
                result.compiled++;
                try {
                    execFileSync(
                        tint,
                        [
                            "--format",
                            format,
                            paths[0]!,
                            "-o",
                            join(out, `o.${format}`),
                        ],
                        {
                            stdio: "pipe",
                            windowsHide: true,
                        },
                    );
                } catch (error) {
                    const detail =
                        error instanceof Error ? error.message : String(error);
                    result.failures.push(
                        `${format} ${paths.join(", ")}: ${detail.slice(0, 500)}`,
                    );
                    continue;
                }
                if (cache) writeJsonRecord(marker, true);
            }
        }
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
    return result;
}
