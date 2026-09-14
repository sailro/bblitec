import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test("Map entry projections preserve order, duplicate keys, and object aliases", { skip: !nativeTools }, () => {
    const result = compileSource(`
        interface Entry { id: string; value: number; }
        const items: Entry[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "a", value: 3 }];
        let calls = 0;
        const index = new Map(items.map(item => { calls++; return [item.id, item]; }));
        if (calls !== 3 || index.size !== 2 || index.get("a")!.value !== 3) throw new Error("entry projection");
        items[2]!.value = 9;
        if (index.get("a")!.value !== 9) throw new Error("lost alias");
        let order = "";
        for (const [key, value] of index) order += key + value.value;
        if (order !== "a9b2") throw new Error("map order");
        const groups: string[][] = [["a", "b"], ["c"]];
        const labels = Object.fromEntries(groups.flatMap(group => group.map(name => [name, name.toUpperCase()] as const)));
        if (labels.a !== "A" || labels.b !== "B" || labels.c !== "C") throw new Error("flattened entry projection");
        const combined: Record<string, string> = { first: "before", a: "old", ...labels, last: "after", b: "override" };
        labels.a = "changed";
        if (combined.first !== "before" || combined.a !== "A" || combined.b !== "override" || combined.last !== "after") throw new Error("dictionary spread");
        function rename(item: Entry): Entry { item.id = "changed"; return item; }
        const renamed = new Map(items.map(item => [item.id, rename(item)]));
        if (!renamed.has("a") || !renamed.has("b") || renamed.has("changed")) throw new Error("pair evaluation order");
    `);
    const output = resolve("artifacts/projected-map");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});
