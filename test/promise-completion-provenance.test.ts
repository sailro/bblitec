import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored Promise recovery callbacks retain concrete undefined completions", async (t) => {
    const source = `
        queueMicrotask(() => {});
        const events: string[] = [];
        const hooks = {
            failed(error: unknown) { events.push("first"); hooks.failed = error => { events.push("replacement"); }; }
        };
        (async () => {
            const saved = hooks.failed;
            const recovered = await Promise.reject<boolean>(new Error("source")).catch(saved).finally(() => { events.push("finally"); });
            if (recovered !== undefined || events.join() !== "first,finally") throw new Error("recovery completion/order");
            const replaced = await Promise.reject<boolean>(new Error("next")).then(value => value, hooks.failed);
            if (replaced !== undefined || events.join() !== "first,finally,replacement") throw new Error("replacement completion");
            let caught = 0;
            try { await Promise.reject<boolean>(new Error("source")).catch(() => { throw new Error("callback"); }); }
            catch { caught++; }
            try { await Promise.resolve(1).finally(() => { throw new Error("cleanup"); }); }
            catch { caught++; }
            if (caught !== 2) throw new Error("reaction throws");
            async function empty(): Promise<void> { await Promise.resolve(); }
            const emptyResult = await empty();
            if (emptyResult !== undefined) throw new Error("awaited concrete completion");
            globalThis.close();
        })();
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "promise-completion-provenance/concrete",
            result.cpp,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("erased callback views cannot fabricate undefined or drop adoption", async () => {
    for (const [body, expected] of [
        ["return 7;", "7"],
        [
            "return Promise.resolve().then(() => { events.push('adopted'); return 9; });",
            "9",
        ],
        [
            "return Promise.resolve().then(() => { events.push('adopted'); throw new Error('delayed'); });",
            "'rejected'",
        ],
        [
            "return {then(resolve: (value: number) => void) { events.push('adopted'); resolve(11); }};",
            "11",
        ],
    ]) {
        const source = `
            queueMicrotask(() => {});
            const events: string[] = [];
            const hooks: {failed(error: unknown): void} = {failed: error => { ${body} }};
            (async () => {
                let observed: unknown = 'rejected';
                try { observed = await Promise.reject<boolean>(new Error('source')).catch(hooks.failed).finally(() => { events.push('finally'); }); }
                catch { }
                if (observed !== ${expected} || events[events.length - 1] !== 'finally') throw new Error('completion/adoption');
                globalThis.close();
            })();
        `;
        await assertAsyncSourceCloses(source);
        assert.throws(
            () => compileSource(source),
            /proven undefined completion|thenable assimilation|stored void|Promise.*result/,
        );
    }
});

test("async replacements preserve the adoption boundary of a void callback slot", async () => {
    for (const rejects of [false, true]) {
        const source = `
            queueMicrotask(() => {});
            const events: string[] = [];
            const hooks = { failed() {} };
            hooks.failed = async () => {
                await Promise.resolve();
                events.push('adopted');
                ${rejects ? "throw new Error('delayed');" : ""}
            };
            (async () => {
                let rejected = false;
                try {
                    const result = await Promise.reject<boolean>(new Error('source')).catch(hooks.failed).finally(() => { events.push('finally'); });
                    if (result !== undefined) throw new Error('completion');
                } catch { rejected = true; }
                if (rejected !== ${rejects} || events.join() !== 'adopted,finally') throw new Error('async adoption');
                globalThis.close();
            })();
        `;
        await assertAsyncSourceCloses(source);
        assert.throws(
            () => compileSource(source),
            /proven undefined completion/,
        );
    }
});

test("unknown implementations and value-returning replacements retain the completion boundary", () => {
    assert.throws(
        () =>
            compileSource(`
        queueMicrotask(() => {});
        function install(hooks: {failed(error: unknown): void}) {
            void Promise.resolve(true).catch(hooks.failed).finally(() => {});
        }
        const retained: Array<typeof install> = [install];
        if (retained.length !== 1) throw new Error('retained');
    `),
        /proven undefined completion/,
    );
    for (const replacement of [
        "() => { return 7; }",
        "() => { return Promise.resolve(9); }",
    ]) {
        assert.throws(
            () =>
                compileSource(`
            queueMicrotask(() => {});
            const hooks = {failed() {}};
            hooks.failed = ${replacement};
            void Promise.reject<boolean>(new Error('source')).catch(hooks.failed);
        `),
            /proven undefined completion/,
        );
    }
});
