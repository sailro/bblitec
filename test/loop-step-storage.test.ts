import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    const steps = [1, 2];
    let seen = '';
    for (let index = 0; index < 5; index += steps.shift() ?? 1) {
        switch (index) { case 1: continue; default: seen += String(index); }
    }
    if (seen !== '034' || steps.length !== 0) throw new Error('nullable step and continue');

    let trace = '', increments = 0, index = 0;
    for (; index < 5; index = (() => { increments++; const next = index + 1; trace += 'I' + next; return next; })()) {
        try {
            trace += 'B' + index;
            if (index === 0) continue;
            if (index === 1) break;
        } finally {
            trace += 'F' + index;
            if (index === 1) continue;
            if (index === 2) break;
        }
    }
    if (index !== 2 || increments !== 2 || trace !== 'B0F0I1B1F1I2B2F2')
        throw new Error('cleanup ordering and overridden completions');

    let before = 0, after = 0, caught = 0;
    try {
        for (let cursor = 0; cursor < 4; before++, cursor = (() => {
            const next = cursor + 1;
            if (next === 2) throw new Error('step');
            return next;
        })(), after++) {}
    } catch (_error) { caught++; }
    if (before !== 2 || after !== 1 || caught !== 1)
        throw new Error('abrupt increment sequence');

    let skipped = 0;
    function leave(): number {
        for (let cursor = 0; cursor < 2; cursor = (() => { skipped++; return cursor + 1; })())
            return 7;
        return 0;
    }
    if (leave() !== 7 || skipped !== 0) throw new Error('return skips step');
`;

test("temporary-producing loop steps generate in the for header", () => {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    assert.match(compileSource(source).cpp, /for \(;[^\n]*\(\[&\]\(\) -> void/);
});

test(
    "native temporary-producing loop steps preserve completion order",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "loop-step-storage",
            compileSource(source).cpp,
            { timeoutMs: 5000 },
        );
    },
);

test("suspending loop setup refuses a non-coroutine incrementor wrapper", () => {
    assert.throws(
        () =>
            compileSource(`
        setTimeout(() => globalThis.close(), 0);
        async function run(): Promise<void> {
            const steps = [Promise.resolve(1)];
            for (let index = 0; index < 2; index += (await steps.shift()) ?? 1) {}
        }
        void run();
    `),
        /suspending loop incrementor requires native expression storage/,
    );
});
