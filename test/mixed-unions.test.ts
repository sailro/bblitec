import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("mixed unions retain array and record alternatives through stored callbacks", { skip: !nativeTools }, () => {
    const result = compileSource(`
        interface Entry { name: string; value: number | readonly number[]; }
        interface Reader { read: (entry: string | Entry) => number; }
        const reader: Reader = { read: entry => {
            if (typeof entry === "string") return entry.length;
            const value = entry.value;
            return typeof value === "number" ? value : value[0]! + value[1]!;
        }};
        const values: (string | Entry)[] = ["abc", {name:"scalar", value:4}, {name:"array", value:[2, 5]}];
        let total = 0;
        for (const value of values) total += reader.read(value);
        if (total !== 14) throw new Error("mixed union reads");
        const numbers = [6, 2];
        const entry: Entry = {name:"shared", value:numbers};
        numbers[0] = 9;
        if (reader.read(entry) !== 11) throw new Error("array identity");
        const cache = new Map<string, string | Entry>();
        cache.set("first", entry);
        cache.set("empty", "");
        function cached(key: string): number {
            const value = cache.get(key);
            if (!value) return -1;
            return reader.read(value);
        }
        if (cached("first") !== 11 || cached("missing") !== -1 || cached("empty") !== -1) throw new Error("optional union truthiness");
        interface Formatter { format: (value: number | boolean | string) => string; }
        const formatter: Formatter = {format: value => String(value)};
        if (formatter.format(3.5) !== "3.5" || formatter.format(false) !== "false" || formatter.format("text") !== "text") throw new Error("union String conversion");
        const keys = new Set<string | Entry>();
        keys.add(entry); keys.add(entry); keys.add("entry");
        if (keys.size !== 2 || !keys.has(entry)) throw new Error("union key identity");
    `);
    assert.match(result.cpp, /std::variant/);
    const output = resolve("artifacts/mixed-unions");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});

test("recursive mixed array aliases refuse instead of recursing during type mapping", () => {
    assert.throws(() => compileSource(`
        type Nested = string | Nested[];
        const values = new Map<string, Nested>();
    `), /requires concrete data type/);
});

test("pinned shader recipe types include mixed options and WebGPU peer declarations", () => {
    const result = compileSource(`
        import type { ShaderMaterial, ShaderMaterialOptions } from "@babylonjs/lite";
        interface Recipe { options: ShaderMaterialOptions; bind?: (material: ShaderMaterial) => void; }
        const recipes = new WeakMap<ShaderMaterial, Recipe>();
    `);
    assert.match(result.cpp, /std::variant/);
});
