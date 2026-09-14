import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("partial record projections enumerate initialized keys in source order", { skip: !nativeTools }, () => {
    const result = compileSource(`
        interface Item { label: string; count: number; }
        type Key = "first" | "second" | "unused";
        const second: Item = { label: "second", count: 2 };
        const first: Item = { label: "first", count: 1 };
        const table: Partial<Record<Key, Item>> = { second, first };
        const keys = Object.keys(table);
        const values = Object.values(table);
        if (keys.join(",") !== "second,first" || values.length !== 2)
            throw new Error("own property order or presence");
        if (values[0] !== second || values[1] !== first)
            throw new Error("value identity");
        const entries = Object.entries(table);
        if (entries[0][0] !== "second" || entries[0][1] !== second)
            throw new Error("entry projection");
    `);
    const output = resolve("artifacts/partial-record-projections");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});

test("empty asserted output records retain missing fields and shared writes", { skip: !nativeTools }, () => {
    const result = compileSource(`
        interface Projection { x: number; y: number; inside: boolean; }
        function project(x: number, out: Projection = {} as Projection): Projection {
            out.x = x;
            out.y = x * 2;
            out.inside = x > 0;
            return out;
        }
        const scratch = {} as Projection;
        const alias = scratch;
        if (scratch.x !== undefined || "x" in scratch) throw new Error("missing field presence");
        const first = project(3, scratch);
        if (first !== scratch || alias.x !== 3 || alias.y !== 6 || !alias.inside)
            throw new Error("shared output writes");
        const second = project(-2);
        if (second === scratch || second.x !== -2 || second.inside || scratch.x !== 3)
            throw new Error("fresh output allocation");
        if (!("x" in alias)) throw new Error("initialized field presence");
    `);
    assert.match(result.cpp, /Nullable<double>/);
    const output = resolve("artifacts/partial-records");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});
