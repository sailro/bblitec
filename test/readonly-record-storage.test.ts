import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("a read-only record alias takes the storage demanded of the record it wraps", (t) => {
    // `counts` makes `Record<string, number>` a document dictionary; the
    // facts record reads one through `Readonly<Record<string, number>>`.
    const progress: string[] = [];
    const { cpp } = compileSource(
        `
function countNumbers(table: Readonly<Record<string, unknown>>): number {
    return Object.entries(table).filter(([, value]) => typeof value === "number").length;
}
function tally(names: readonly string[]): number {
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = name.length;
    return countNumbers(counts);
}
if (tally(["a", "record"]) !== 2) throw new Error("tally");
interface Facts { switches: Readonly<Record<string, boolean>>; amounts: Readonly<Record<string, number>> }
function read(record: Facts, key: string): number { return record.amounts[key] ?? Number.NaN; }
function evaluateFacts(record: Facts): number { return read(record, "level"); }
const flagFacts: Record<string, boolean> = {};
const numberFacts: Record<string, number> = {};
const facts: Facts = { switches: flagFacts, amounts: numberFacts };
numberFacts.level = Math.random() < 2 ? 4 : 0;
if (evaluateFacts(facts) !== 4) throw new Error("read");
`,
        { compileProgress: (line) => progress.push(line) },
    );
    assert.ok(
        progress.some((line) => line.includes("(Record: documentDictionary)")),
    );
    assert.ok(
        !progress.some((line) => line.includes("Readonly: documentDictionary")),
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "readonly-record-storage/run", cpp, {
        expectedOutput: "",
    });
});
