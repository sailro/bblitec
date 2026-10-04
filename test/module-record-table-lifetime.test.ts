import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, definitions: string, source: string): void {
    test(name, (t) => {
        const exports = {};
        const compileJs = (text: string): string =>
            ts.transpileModule(text, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.CommonJS,
                },
            }).outputText;
        runInNewContext(compileJs(definitions), { exports });
        runInNewContext(compileJs(source), {
            exports: {},
            require: (name: string) => {
                assert.equal(name, "./definitions.js");
                return exports;
            },
        });
        const directory = mkdtempSync(join(tmpdir(), "bblitec-record-owner-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        writeFileSync(join(directory, "definitions.ts"), definitions);
        const result = compileSource(source, {
            fileName: join(directory, "entry.ts"),
        });
        const native = optionalNativeFixtureTools(false);
        if (!native) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(native, `module-record-table/${name}`, result.cpp);
    });
}

const definitions = `
    export interface Entry {
        id: number;
        name: string;
        parts: {first: string; second: string};
        active: boolean;
        weight: number;
    }
    function entry(id: number, name: string,
        parts: Partial<Entry["parts"]> & {all?: string},
        options: Partial<Entry> = {}): Entry {
        const all = parts.all ?? "plain";
        return {
            id, name,
            parts: {first: parts.first ?? all, second: parts.second ?? all},
            active: options.active ?? true,
            weight: options.weight ?? 0,
        };
    }
    const ENTRIES: Record<number, Entry> = {
        1: entry(1, "first", {all: "one"}),
        2: entry(2, "second", {first: "two"}, {active: false, weight: 7}),
        3: entry(3, "third", {all: "three"}, {weight: 9}),
    };
    const alias = ENTRIES;
    export function read(id: number): Entry | undefined { return ENTRIES[id]; }
    export function viaAlias(id: number): Entry | undefined { return alias[id]; }
    export function active(id: number): boolean { return ENTRIES[id]?.active === true; }
    export function weight(id: number): number { return alias[id]?.weight ?? -1; }
`;

check(
    "pure factory entries retain identity across repeated module lookups",
    definitions,
    `import {read, viaAlias, active, weight} from "./definitions.js";
    const keys: number[] = [1, 2, 3, 8];
    for (let pass = 0; pass < 4; pass++) {
        for (const key of keys) {
            const first = read(key);
            const second = viaAlias(key);
            if (first !== second) throw new Error("module entry identity");
            if (first) {
                if (!second || first.parts !== second.parts)
                    throw new Error("nested identity");
                if (active(key) !== first.active || weight(key) !== first.weight)
                    throw new Error("independent lookup helper");
            } else if (active(key) || weight(key) !== -1) {
                throw new Error("missing entry");
            }
        }
    }`,
);

check(
    "module table aliases preserve nested mutations and initializer order",
    `export interface Entry { value: number; nested: {value: number}; }
    export let calls = 0;
    export let order = "";
    function entry(value: number): Entry {
        calls++;
        order += String(value);
        return {value, nested: {value: value + 1}};
    }
    const TABLE: Record<string, Entry> = {first: entry(3), second: entry(7)};
    const alias = TABLE;
    export function read(key: string): Entry | undefined { return TABLE[key]; }
    export function again(key: string): Entry | undefined { return alias[key]; }
    export function state(): string { return order + ":" + String(calls); }`,
    `import {read, again, state} from "./definitions.js";
    if (state() !== "37:2") throw new Error("eager module initialization");
    const keys: string[] = ["first", "second"];
    for (const key of keys) {
        const value = read(key)!;
        const original = value.nested.value;
        value.nested.value += 10;
        if (again(key) !== value || again(key)!.nested.value !== original + 10)
            throw new Error("shared nested mutation");
    }
    if (state() !== "37:2") throw new Error("repeated initialization");`,
);

check(
    "local factory tables retain one owner per invocation and snapshot scalar inputs",
    `export interface Entry { nested: {value: number}; }
    function entry(value: number): Entry { return {nested: {value}}; }
    export function create(seed: number): (key: number) => Entry | undefined {
        const table: Record<number, Entry> = {1: entry(seed), 2: entry(seed + 1)};
        seed = 100;
        return (key: number): Entry | undefined => table[key];
    }
    export function scalars(seed: number): (key: number) => number | undefined {
        const table: Record<number, number> = {1: seed + 1, 2: seed + 2};
        seed = 100;
        return (key: number): number | undefined => table[key];
    }`,
    `import {create, scalars} from "./definitions.js";
    const first = create(2);
    const second = create(5);
    const firstScalar = scalars(2);
    const secondScalar = scalars(5);
    const keys: number[] = [1, 2];
    for (const key of keys) {
        const a = first(key)!;
        const b = second(key)!;
        if (a === b || a.nested === b.nested || a !== first(key) || b !== second(key))
            throw new Error("per-invocation table identity");
        if (a.nested.value !== key + 1 || b.nested.value !== key + 4 ||
            firstScalar(key) !== key + 2 || secondScalar(key) !== key + 5)
            throw new Error("initializer snapshot");
        a.nested.value += 10;
        if (first(key)!.nested.value !== key + 11 || second(key)!.nested.value !== key + 4)
            throw new Error("local alias mutation");
    }`,
);
