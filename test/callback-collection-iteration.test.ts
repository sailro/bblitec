import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("retained callback collections observe registrations after empty iteration and settle waiters", async (t) => {
    const source = `
        const callbacks = new Set<() => void>();
        function publish(): void {
            for (const callback of callbacks) callback();
            callbacks.clear();
        }
        const retained: Array<() => void> = [publish];
        let calls = 0;
        retained[0]!();
        callbacks.add(() => { calls++; });
        retained[0]!();
        retained[0]!();
        if (calls !== 1) throw new Error('late registration or duplicate delivery');
        (async () => {
            const pending = new Promise<void>(resolve => callbacks.add(resolve));
            retained[0]!();
            await pending;
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            close: () => {
                closed = true;
            },
        },
    );
    assert.ok(closed);
    const compiled = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "callback-collection-iteration", compiled.cpp, {
        defines: ["BBLITE_WORKERS=1"],
        timeoutMs: 10000,
    });
});
