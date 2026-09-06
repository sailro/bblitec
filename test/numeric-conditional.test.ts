import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("numeric conditional preparation runs only in the selected branch", { skip: !tools }, () => {
    const source = `
        const values = new Map<number, number>();
        values.set(1, 7);
        const selectors = new Float64Array([0, 1, 0, 1]);
        let calls = 0;
        function read(key: number): number { calls++; return values.get(key) ?? -1; }
        let total = 0;
        for (let i = 0; i < selectors.length; i++) {
            const selector = selectors[i]!;
            const result = selector === 1 ? read(selector) : -2;
            total += result;
            // An arithmetic sink takes compileNumber rather than the
            // variable initializer's compileValue route.
            total += 2 * (selector === 1 ? read(selector) : -2);
        }
        if (calls !== 4 || total !== 30) throw new Error("untaken conditional ran preparation");
        class Entry { amount = 9; }
        const entries = new Map<number, Entry>();
        entries.set(1, new Entry());
        for (let i = 0; i < selectors.length; i++) {
            const selector = selectors[i]!;
            const entry = entries.get(selector);
            const result = entry ? (values.get(entry.amount - 8) ?? -1) : -2;
            if (result !== (selector === 1 ? 7 : -2)) throw new Error("unguarded optional read");
        }
        class Item {
            reads = 0;
            get active(): boolean { return ++this.reads > 0; }
        }
        const items = new Map<number, Item>();
        const item = new Item();
        items.set(1, item);
        const found = items.get(1);
        const outer = Math.random() < 0;
        const skipped = outer ? (found?.active ? 1 : 0) : 0;
        if (skipped !== 0 || item.reads !== 0) throw new Error("unselected getter ran");
        const taken = !outer ? (found?.active ? 1 : 0) : 0;
        if (taken !== 1 || item.reads !== 1) throw new Error("selected getter count");
    `;
    const output = resolve("artifacts/numeric-conditional");
    mkdirSync(output, { recursive: true });
    const file = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(file, compileSource(source).cpp);
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", file,
    ]);
    execFileSync(executable, { encoding: "utf8" });
});
