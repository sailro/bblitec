import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CompileError, compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

// A constructed promise outside an application realm: the executor runs in
// place, its resolving functions escape into callbacks, an await reads the
// settlement, and an await that finds it pending ends its activation for
// good, skipping that activation's catch and finally blocks. Absent File
// System Access pickers read as `undefined`.
const program = `
interface PickerWindow {
    showOpenFilePicker?: (options: unknown) => Promise<unknown>;
    showSaveFilePicker?: (options: unknown) => Promise<unknown>;
}

const trace: string[] = [];

function settleThrough(value: number): Promise<number> {
    return new Promise((resolve) => {
        const finish = (result: number): void => resolve(result * 2);
        finish(value);
        finish(value + 1);
    });
}

function failing(message: string): Promise<number> {
    return new Promise((_resolve, reject) => {
        reject(new Error(message));
    });
}

function throwing(): Promise<number> {
    return new Promise(() => {
        throw new Error("executor");
    });
}

function never(): Promise<number> {
    return new Promise(() => {
        trace.push("executor");
    });
}

async function sum(): Promise<number> {
    const first = await settleThrough(10);
    const second = await settleThrough(1);
    return first + second;
}

async function waitsForever(): Promise<void> {
    try {
        const value = await never();
        trace.push("resumed " + value);
    } catch {
        trace.push("caught");
    } finally {
        trace.push("finally");
    }
}

async function main(): Promise<void> {
    const w = window as unknown as PickerWindow;
    if (w.showOpenFilePicker || w.showSaveFilePicker) throw new Error("absent pickers read as present");
    const picker = typeof w.showSaveFilePicker === "function" ? "native" : "fallback";
    if (picker !== "fallback") throw new Error("typeof of an absent picker");
    if ((await sum()) !== 22) throw new Error("escaping resolve");
    let rejected = "";
    try {
        await failing("rejected");
    } catch (error) {
        rejected = error instanceof Error ? error.message : "";
    }
    if (rejected !== "rejected") throw new Error("reject");
    let thrown = "";
    try {
        await throwing();
    } catch (error) {
        thrown = error instanceof Error ? error.message : "";
    }
    if (thrown !== "executor") throw new Error("executor throw rejects");
    void waitsForever();
    trace.push("after");
    if (trace.join(",") !== "executor,after") throw new Error("pending activation: " + trace.join(","));
}
`;

test("constructed promises settle, reject and end pending activations natively", async (t) => {
    let completed = false;
    await runInNewContext(
        ts.transpile(`${program}\nmain().then(() => completed());`, {
            target: ts.ScriptTarget.ES2022,
        }),
        {
            window: {},
            completed: () => {
                completed = true;
            },
        },
    );
    assert.equal(completed, true, "JavaScript oracle completed");

    const directory = resolve("artifacts/synchronous-promise");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`${program}\nvoid main();\n`, {
        fileName: join(directory, "entry.ts"),
    });
    assert.match(result.cpp, /bbl::js::SynchronousPromise<double>/);
    assert.match(
        result.cpp,
        /catch \(const bbl::js::PendingActivation&\) \{\s*bbl::js::end_abandoned_activation\(\);/,
    );
    assert.match(
        result.cpp,
        /if \(bbl::js::activation_abandoned\(\)\) return;/,
    );
    assert.doesNotMatch(result.cpp, /showOpenFilePicker|showSaveFilePicker/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp");
    const exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    const execution = spawnSync(exe, { encoding: "utf8", timeout: 10000 });
    assert.equal(execution.stderr, "");
    assert.equal(execution.status, 0);
});

test("pending activations refuse uses that need a pending promise value", () => {
    const refusal = (source: string, pattern: RegExp): void =>
        assert.throws(
            () => compileSource(source, { fileName: "examples/pending.ts" }),
            (error: unknown) =>
                error instanceof CompileError && pattern.test(error.message),
        );
    const never = `
        function never(): Promise<number> {
            return new Promise(() => {});
        }
        async function wait(): Promise<number> {
            return await never();
        }`;
    refusal(
        `${never}
        async function main(): Promise<void> {
            const pending = wait();
            await pending;
        }
        void main();`,
        /awaited, returned or discarded as a statement/,
    );
    refusal(
        `import { createEngine, startEngine } from "@babylonjs/lite";
        ${never}
        async function main(): Promise<void> {
            const engine = await createEngine({});
            window.addEventListener("keydown", wait);
            await startEngine(engine);
        }
        void main();`,
        /is called where it is named/,
    );
    refusal(
        `async function main(): Promise<void> {
            const executor = new Promise<number>((resolve) => resolve(1));
            await executor;
        }
        void main();`,
        /awaited or returned where it is created/,
    );
    refusal(
        `async function main(): Promise<void> {
            await new Promise<number>(async (resolve) => resolve(1));
        }
        void main();`,
        /async Promise executor/,
    );
    refusal(
        `async function main(): Promise<void> {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        void main();`,
        /settled from a timer or frame callback/,
    );
    refusal(
        `async function main(): Promise<void> {
            let polls = 0;
            await new Promise<void>((resolve) => {
                const poll = (): void => {
                    if (++polls > 3) {
                        resolve();
                        return;
                    }
                    queueMicrotask(poll);
                };
                poll();
            });
        }
        void main();`,
        /settled from a timer or frame callback/,
    );
});

test("pending-activation refusals are scoped to reached code", () => {
    const source = (reached: boolean): string => `
        function never(): Promise<number> {
            return new Promise(() => {});
        }
        async function wait(): Promise<number> {
            return await never();
        }
        function stores(): number {
            const pending = wait();
            return pending === undefined ? 0 : 1;
        }
        async function main(): Promise<void> {
            void wait();
            ${reached ? "stores();" : ""}
        }
        void main();`;
    const result = compileSource(source(false), {
        fileName: "examples/pending-unreached.ts",
    });
    assert.match(result.cpp, /bbl::js::SynchronousPromise<double>/);
    assert.doesNotMatch(result.cpp, /stores/);
    assert.throws(
        () =>
            compileSource(source(true), {
                fileName: "examples/pending-reached.ts",
            }),
        (error: unknown) =>
            error instanceof CompileError &&
            /awaited, returned or discarded as a statement/.test(error.message),
    );
});

test("absent global members fold through aliases and typeof", () => {
    const result = compileSource(
        `
        import { createEngine, startEngine } from "@babylonjs/lite";
        interface Pickers { showDirectoryPicker?: () => Promise<unknown> }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const pickers = globalThis as unknown as Pickers;
            const alias = pickers;
            let chosen = 0;
            if (alias.showDirectoryPicker) chosen = 1;
            else if (typeof pickers.showDirectoryPicker === "undefined") chosen = 2;
            if (pickers.showDirectoryPicker != null) chosen = 3;
            engine.canvas.width = chosen;
            await startEngine(engine);
        }
        void main();
        `,
        { fileName: "examples/absent-globals.ts" },
    );
    assert.doesNotMatch(result.cpp, /showDirectoryPicker/);
    assert.match(result.cpp, /v_chosen = 2\.0/);
    assert.doesNotMatch(result.cpp, /v_chosen = [13]\.0/);
});
