import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const authoredEntry of [false, true]) {
    test(`entry record owners and constant array elements retain distinct provenance (${authoredEntry ? "authored" : "implicit"})`, (t) => {
        const source = `
            interface Item { value: number }
            const source: Item = {value: 3};
            const alias = source;
            const items: Item[] = [{value: 2}, {value: 2}];
            const aliases: Item[] = [alias, source];
            function main() {
                let index = 0;
                const first = items[index]!;
                index++;
                const second = items[index]!;
                if (first === second) throw new Error("literal identity");
                first.value = 7;
                if (items[0]!.value !== 7 || second.value !== 2) throw new Error("element ownership");
                const retained = new Map<string, Item>();
                retained.set("source", alias);
                const held = retained.get("source")!;
                held.value = 9;
                if (held !== source || source.value !== 9 || aliases[0] !== aliases[1] || aliases[index] !== source)
                    throw new Error("entry declaration ownership");
            }
            ${authoredEntry ? "main();" : ""}
        `;
        runInNewContext(
            ts.transpileModule(source + (authoredEntry ? "" : "main();"), {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `record-provenance-${authoredEntry ? "authored" : "implicit"}`,
            result.cpp,
        );
    });
}

test("retained record presence preserves lazy getters and mutable absence", (t) => {
    const source = `
        let reads = 0;
        let current = 4;
        const env = {get value() {reads++; return current;}};
        function resolve(options: {env?: typeof env}): {env: Partial<typeof env>} {
            return {env: options.env ?? {}};
        }
        const result = resolve({env});
        if (reads !== 0 || result.env !== env || result.env.value !== 4 || reads !== 1)
            throw new Error("present getter identity");
        current = 8;
        if (result.env.value !== 8 || reads !== 2) throw new Error("lazy getter");
        interface Item { value?: number }
        let selected: Item | null = {value: 5};
        const retained = new Map<string, Item>();
        retained.set("initial", selected);
        let fallbacks = 0;
        function fallback(): Item { fallbacks++; return {}; }
        function read(): Item { return selected ?? fallback(); }
        const present = read();
        if (present !== selected || fallbacks !== 0) throw new Error("present branch");
        selected = null;
        const absent = read();
        if (fallbacks !== 1 || absent.value !== undefined || absent === retained.get("initial"))
            throw new Error("absent branch");
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "record-fallback-presence", result.cpp);
});

test("a nullish fallback cannot invent required record fields", () => {
    assert.throws(
        () =>
            compileSource(`
            function select(value: {required: number} | null): {required: number} {
                return value ?? {};
            }
            const values: {required: number}[] = [select(null)];
            if (values.length !== 1) throw new Error("length");
        `),
        /missing required field 'required'/,
    );
});
