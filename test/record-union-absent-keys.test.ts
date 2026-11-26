import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { runSelfCheckingProgram } from "./self-checking-program.js";

// One record union stored in one layout; only how one member declares the
// key another member lacks differs.
const optionalKey = `
interface Result { kind: number; version?: number }
interface Total { index: number; amount: number }
type Entry = Result | Total;
const entries: Entry[] = [];
const count = Math.random() < 2 ? 3 : 0;
for (let i = 0; i < count; i++) {
    if (i === 0) entries.push({ kind: 1, version: 3 });
    else if (i === 1) entries.push({ kind: 2 });
    else entries.push({ index: i, amount: 5 });
}
let total = 0;
let absent = 0;
let own = 0;
for (const entry of entries) {
    if ("version" in entry) own++;
    if ("kind" in entry) {
        if (entry.version === undefined) absent++;
        else total += entry.version;
    } else total += entry.amount;
}
if (total !== 8 || absent !== 1 || own !== 1) throw new Error("absent keys " + total + " " + absent + " " + own);
`;
// JavaScript keeps a key written undefined own: the records holding such a
// key keep their own keys apart from their slots.
const explicitUndefined = `
interface Result { kind: number; version?: number }
interface Total { index: number; amount: number }
type Entry = Result | Total;
const entries: Entry[] = [];
const count = Math.random() < 2 ? 4 : 0;
for (let i = 0; i < count; i++) {
    if (i === 0) entries.push({ kind: 1, version: 3 });
    else if (i === 1) entries.push({ kind: 2 });
    else if (i === 2) entries.push({ kind: 3, version: undefined });
    else entries.push({ index: i, amount: 5 });
}
let total = 0;
let absent = 0;
let own = 0;
for (const entry of entries) {
    if ("version" in entry) own++;
    if ("kind" in entry) {
        if (entry.version === undefined) absent++;
        else total += entry.version;
    } else total += entry.amount;
}
if (total !== 8 || absent !== 2 || own !== 2) throw new Error("absent keys " + total + " " + absent + " " + own);
const text = JSON.stringify(entries);
if (text !== '[{"kind":1,"version":3},{"kind":2},{"kind":3},{"index":3,"amount":5}]') throw new Error(text);
`;
const recursiveUndefined = `
type Optional = { value?: number } | { next: Optional };
const chain: Optional[] = [];
const count = Math.random() < 2 ? 4 : 0;
for (let i = 0; i < count; i++) {
    if (i === 0) chain.push({ value: 4 });
    else if (i === 1) chain.push({ value: undefined });
    else if (i === 2) chain.push({});
    else chain.push({ next: chain[0]! });
}
let own = 0;
let sum = 0;
for (const link of chain) {
    if ("value" in link) {
        own++;
        sum += link.value ?? 10;
    } else if ("next" in link && "value" in link.next) sum += link.next.value ?? 0;
}
if (own !== 2 || sum !== 18) throw new Error("chain " + own + " " + sum);
const text = JSON.stringify(chain);
if (text !== '[{"value":4},{},{},{"next":{"value":4}}]') throw new Error(text);
`;
const requiredKey = `
interface Result { kind: number; version: number | undefined }
interface Total { index: number; amount: number }
type Entry = Result | Total;
const entries: Entry[] = [];
const count = Math.random() < 2 ? 3 : 0;
for (let i = 0; i < count; i++) {
    if (i === 0) entries.push({ kind: 1, version: 3 });
    else if (i === 1) entries.push({ kind: 2, version: undefined });
    else entries.push({ index: i, amount: 5 });
}
let total = 0;
let absent = 0;
let own = 0;
for (const entry of entries) {
    if ("version" in entry) own++;
    if ("kind" in entry) {
        if (entry.version === undefined) absent++;
        else total += entry.version;
    } else total += entry.amount;
}
if (total !== 8 || absent !== 1 || own !== 2) throw new Error("absent keys " + total + " " + absent + " " + own);
`;

test("an optional key one union member lacks is absent in its empty slot", (t) => {
    const { cpp } = compileSource(optionalKey);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "record-union-absent-keys/optional", cpp, {
        expectedOutput: "",
    });
});

test("an optional key one union member lacks, written undefined, stays own", (t) =>
    runSelfCheckingProgram(
        t,
        "record-union-absent-keys/explicit-undefined",
        explicitUndefined,
        { expectedOutput: "" },
    ));

test("a recursive union's optional key written undefined stays own", (t) =>
    runSelfCheckingProgram(
        t,
        "record-union-absent-keys/recursive-undefined",
        recursiveUndefined,
        { expectedOutput: "" },
    ));

test("a required key that may hold undefined beside a member lacking it refuses", () => {
    assert.throws(
        () => compileSource(requiredKey),
        /A runtime-grown handle list requires native array storage/,
    );
});
