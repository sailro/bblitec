import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("stored callbacks preserve promise and synchronous void outcomes", t => {
    const directory = resolve("artifacts/optional-promise");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        interface Action { run: (mode: number) => Promise<void> | void; }
        let effects = 0;
        let completed = 0;
        function effect(): void { effects++; }
        function produce(): Promise<void> { effects++; return Promise.resolve(); }
        const action: Action = {run: (mode: number): Promise<void> | void => {
            effects++;
            if (mode === 0) return;
            if (mode === 1) return effect();
            return produce();
        }};
        const empty: Action = {run: () => { effects++; }};
        const asynchronous: Action = {run: async () => { await Promise.resolve(); effects++; }};
        if (typeof produce().then !== "function") throw new Error("promise method");
        function invoke(action: Action, mode: number): void {
            const result = action.run(mode);
            if (result && typeof (result as Promise<void>).then === "function") result.then(() => { completed++; });
            else completed++;
        }
        invoke(action, 0);
        invoke(action, 1);
        invoke(action, 2);
        invoke(empty, 0);
        invoke(asynchronous, 0);
        queueMicrotask(() => { queueMicrotask(() => {
            if (effects !== 8 || completed !== 5) throw new Error("callback outcome or effects");
            globalThis.close();
        }); });
    `;
    const result = compileSource(source, {fileName:join(directory, "entry.ts")});
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DBBLITE_WORKERS=1",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
});
