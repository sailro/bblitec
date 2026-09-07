import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCacheConfiguration } from "./build-stamp.js";

/**
 * Estimate rebuild work from Ninja's latest timing per output. Appended runs
 * and compacted logs share this rule; neither file order nor the largest end
 * timestamp describes a complete build. Multi-output edges count once.
 *
 * Versions 5-7 use start/end milliseconds, output mtime, path, command hash:
 * https://github.com/ninja-build/ninja/blob/v1.13.1/src/build_log.cc
 * This is a scheduling hint, so an unknown or malformed log supplies no cost.
 */
export function ninjaBuildCostMs(contents: string): number | undefined {
    const lines = contents.split(/\r?\n/);
    if (!/^# ninja log v[567]$/.test(lines.shift() ?? "") || lines.pop() !== "") return undefined;
    const latest = new Map<string, { start: number; end: number; hash: string }>();
    for (const line of lines) {
        const fields = line.split("\t");
        if (fields.length !== 5) return undefined;
        const [startText, endText, mtime, output, hash] = fields as [string, string, string, string, string];
        if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText) ||
            !/^-?\d+$/.test(mtime) || !output || !/^[\da-f]{1,16}$/i.test(hash)) return undefined;
        const start = Number(startText);
        const end = Number(endText);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
        latest.set(output, { start, end, hash: hash.toLowerCase() });
    }
    if (latest.size === 0) return undefined;
    let total = 0;
    const counted = new Set<string>();
    for (const { start, end, hash } of latest.values()) {
        const command = `${start}:${end}:${hash}`;
        if (counted.has(command)) continue;
        counted.add(command);
        total += end - start;
        if (!Number.isSafeInteger(total)) return undefined;
    }
    return total;
}

/** Ignore stale Ninja history when the current or requested generator differs. */
export function historicalBuildCostMs(buildDirectory: string, generator: string): number | undefined {
    if (generator !== "Ninja") return undefined;
    try {
        if (readCacheConfiguration(buildDirectory)?.CMAKE_GENERATOR !== generator) return undefined;
        return ninjaBuildCostMs(readFileSync(join(buildDirectory, ".ninja_log"), "utf8"));
    } catch {
        // Missing/unreadable disposable history must not prevent a real build.
        return undefined;
    }
}

/**
 * Start unknown work promptly, then known work in descending historical cost.
 * New scenes get an early result; ties and absent history retain input order.
 * Costs are read once before any build can rewrite its own history.
 */
export function orderByHistoricalCost<T>(
    items: readonly T[],
    costOf: (item: T) => number | undefined,
): T[] {
    return items.map((item, index) => {
        const value = costOf(item);
        const cost = value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
        return { item, index, cost };
    }).sort((left, right) => {
        if (left.cost === undefined || right.cost === undefined) {
            return left.cost === right.cost ? left.index - right.index : left.cost === undefined ? -1 : 1;
        }
        return right.cost - left.cost || left.index - right.index;
    }).map(({ item }) => item);
}
