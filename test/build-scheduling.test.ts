import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { historicalBuildCostMs, ninjaBuildCostMs, orderByHistoricalCost } from "../src/build-scheduling.js";

function log(rows: readonly string[], version = 7): string {
    return `# ninja log v${version}\n${rows.join("\n")}\n`;
}

test("Ninja costs retain the latest output sample across incremental runs and compaction", () => {
    for (const version of [5, 6, 7]) {
        const contents = log([
            "10\t1010\t123456789012345678\tmain.obj\tab",
            "1010\t1310\t-1\tpal.obj\tcd",
            "4\t204\t123456789012345699\tpal.obj\tce",
        ], version);
        assert.equal(ninjaBuildCostMs(contents), 1200);
        // Compaction may place the retained entries in any order.
        assert.equal(ninjaBuildCostMs(log([
            "4\t204\t123456789012345699\tpal.obj\tce",
            "10\t1010\t123456789012345678\tmain.obj\tab",
        ], version)), 1200);
    }
});

test("multi-output command aliases count once without merging different commands", () => {
    assert.equal(ninjaBuildCostMs(log([
        "0\t100\t111\tassets/stamp\tAB",
        "0\t100\t111\tC:/a path/assets/stamp\tab",
        "0\t100\t111\tother.obj\tcd",
        "100\t100\t111\tzero-duration.obj\tef",
    ])), 200);
});

test("invalid or incomplete history yields no estimate", () => {
    const valid = "0\t10\t1\tfile.obj\tab";
    for (const contents of [
        "", "# ninja log v7\n", log([valid], 4), log([valid], 8),
        log([valid]).trimEnd(), log([valid, "partial"]), log(["", valid]),
        log(["-1\t10\t1\tfile.obj\tab"]), log(["20\t10\t1\tfile.obj\tab"]),
        log(["0\tNaN\t1\tfile.obj\tab"]), log(["0\t1e3\t1\tfile.obj\tab"]),
        log(["0\t9007199254740992\t1\tfile.obj\tab"]),
        log(["0\t10\tmtime\tfile.obj\tab"]), log(["0\t10\t1\t\tab"]),
        log(["0\t10\t1\tfile.obj\txyz"]), log(["0\t10\t1\tfile.obj\tab\textra"]),
        log(["0\t9007199254740991\t1\tone\ta", "0\t1\t1\ttwo\tb"]),
    ]) assert.equal(ninjaBuildCostMs(contents), undefined, contents);
    assert.equal(ninjaBuildCostMs(log([valid]).replaceAll("\n", "\r\n")), 10);
});

test("only a matching single-config Ninja tree supplies a history cost", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-build-cost-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cache = join(directory, "CMakeCache.txt");
    const history = join(directory, ".ninja_log");
    assert.equal(historicalBuildCostMs(directory, "Ninja"), undefined);
    writeFileSync(history, log(["0\t25\t1\tobject\tab"]));
    assert.equal(historicalBuildCostMs(directory, "Ninja"), undefined);
    writeFileSync(cache, "CMAKE_GENERATOR:INTERNAL=Ninja\n");
    assert.equal(historicalBuildCostMs(directory, "Ninja"), 25);
    for (const generator of ["Ninja Multi-Config", "Unix Makefiles", "Visual Studio 18 2026"]) {
        assert.equal(historicalBuildCostMs(directory, generator), undefined);
        writeFileSync(cache, `CMAKE_GENERATOR:INTERNAL=${generator}\n`);
        assert.equal(historicalBuildCostMs(directory, "Ninja"), undefined);
    }
    writeFileSync(cache, "CMAKE_GENERATOR:INTERNAL=Ninja\n");
    writeFileSync(history, "corrupt");
    assert.equal(historicalBuildCostMs(directory, "Ninja"), undefined);
    rmSync(history);
    assert.equal(historicalBuildCostMs(directory, "Ninja"), undefined);
});

test("unknown scenes start early and expensive known scenes precede cheaper work stably", () => {
    const items = [
        { id: "small", cost: 2 }, { id: "new" }, { id: "large", cost: 20 },
        { id: "same-size", cost: 2 }, { id: "invalid", cost: NaN }, { id: "instant", cost: 0 },
    ];
    const original = [...items];
    const reads: string[] = [];
    const ordered = orderByHistoricalCost(items, (item) => { reads.push(item.id); return item.cost; });
    assert.deepEqual(ordered.map((item) => item.id), ["new", "invalid", "large", "small", "same-size", "instant"]);
    assert.deepEqual(reads, items.map((item) => item.id));
    assert.deepEqual(items, original);
    assert.deepEqual(orderByHistoricalCost(items, () => undefined), items);
    assert.deepEqual(orderByHistoricalCost(items, () => -1), items);
    assert.deepEqual(orderByHistoricalCost(items, () => Infinity), items);
    assert.deepEqual(orderByHistoricalCost([], () => 1), []);
});

test("historical ordering removes a late long-job tail at the same worker limit", () => {
    const items = [2, 2, 2, 2, 9];
    const makespan = (queue: readonly number[]): number => {
        const workers = [0, 0];
        for (const duration of queue) {
            const first = workers.indexOf(Math.min(...workers));
            workers[first]! += duration;
        }
        return Math.max(...workers);
    };
    assert.equal(makespan(items), 13);
    assert.equal(makespan(orderByHistoricalCost(items, (cost) => cost)), 9);
});
