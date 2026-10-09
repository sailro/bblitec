import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    let cleanups = 0, caught = 0;
    function choose(mode: number): number {
        try {
            try {
                if (mode === 2) throw new Error('body');
                return 3;
            } finally {
                cleanups++;
                if (mode === 1 || mode === 2) return 7;
                if (mode === 3) throw new Error('cleanup');
            }
        } catch (_error) { caught++; return 9; }
    }
    if (choose(0) !== 3 || choose(1) !== 7 || choose(2) !== 7 || choose(3) !== 9 || cleanups !== 4 || caught !== 1)
        throw new Error('cleanup overrides only pending completion');

    function nested(mode: number): string {
        try {
            try { return 'body'; }
            finally { if (mode > 0) throw new Error('inner'); }
        } finally { if (mode > 1) return 'outer'; }
    }
    if (nested(0) !== 'body' || nested(2) !== 'outer') throw new Error('nested completion');
    try { nested(1); throw new Error('missing inner exception'); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'inner') throw error; }

    const original = {value: 1};
    function owner(replace: boolean): {value: number} {
        let selected = original;
        try { return selected; }
        finally {
            selected.value++;
            selected = {value: 8};
            if (replace) return selected;
        }
    }
    const first = owner(false), second = owner(true);
    if (first !== original || first.value !== 3 || second === original || second.value !== 8)
        throw new Error('returned owner survives cleanup rebinding');

    function optional(mode: number): number | undefined {
        try { if (mode === 0) return; return 4; }
        finally { if (mode === 2) return 6; }
    }
    if (optional(0) !== undefined || optional(1) !== 4 || optional(2) !== 6)
        throw new Error('declared optional completion sink');

    let trace = '', steps = 0;
    outer: for (let i = 0; i < 3; i++, steps++) {
        for (let j = 0; j < 2; j++) {
            try { trace += 'B' + i; break outer; }
            finally { trace += 'F' + i; if (i < 2) continue outer; }
        }
    }
    if (trace !== 'B0F0B1F1B2F2' || steps !== 2) throw new Error('labeled cleanup jumps');

    let ended = 0;
    function finish(replace: boolean): void {
        try { return; }
        finally { ended++; if (replace) return; }
    }
    finish(false); finish(true);
    if (ended !== 2) throw new Error('void completion');
`;

test("synchronous finally transports returns and loop exits across overriding cleanup", () => {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    compileSource(source);
});

test(
    "native synchronous finally preserves typed values, identities and completion priority",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "finally-completions",
            compileSource(source).cpp,
            { timeoutMs: 5000 },
        );
    },
);
