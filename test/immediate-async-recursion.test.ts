import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("immediate recursive async callbacks preserve early returns, fallthrough and effect order", async (t) => {
    const source = `
        async function verify(): Promise<void> {
            let trace = '';
            let visits = 0;
            const early = async (value: number): Promise<void> => {
                trace += 'e' + String(value) + ';';
                if (value <= 0) return;
                visits += 1;
                await early(value - 1);
                trace += 'E' + String(value) + ';';
            };
            const falling = async (value: number): Promise<void> => {
                trace += 'f' + String(value) + ';';
                visits += 1;
                if (value > 0) await falling(value - 1);
                trace += 'F' + String(value) + ';';
            };

            await early(2);
            if (String(trace) !== 'e2;e1;e0;E1;E2;' || Number(visits) !== 2)
                throw new Error('early return and recursive completion order');
            trace = '';
            await early(0);
            if (String(trace) !== 'e0;' || Number(visits) !== 2)
                throw new Error('early return skips the continuation');

            trace = '';
            await falling(2);
            if (String(trace) !== 'f2;f1;f0;F0;F1;F2;' || Number(visits) !== 5)
                throw new Error('fallthrough and recursive completion order');
            trace = '';
            await falling(-1);
            if (String(trace) !== 'f-1;F-1;' || Number(visits) !== 6)
                throw new Error('repeated callback retains shared state');
        }
        verify();
    `;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /bbl::js::Callback<void\(double\)>/);
    assert.doesNotMatch(result.cpp, /bbl::js::Callback<bool\(double\)>/);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "immediate-async-recursion", result.cpp);
});
