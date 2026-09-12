import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("qualified realm timers and microtasks run without a scene engine", t => {
    const directory = resolve("artifacts/qualified-realm-services");
    mkdirSync(directory, {recursive:true});
    const worker = join(directory, "worker.ts");
    writeFileSync(worker, 'globalThis.setTimeout(() => { self.postMessage(1); self.close(); }, 0);');
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        let received = 0;
        let timeouts = 0;
        let intervals = 0;
        let microtasks = 0;
        let interval = 0;
        function done(): void {
            if (received === 1 && timeouts === 1 && intervals === 1 && microtasks === 1) globalThis.close();
        }
        function shadowed(): number {
            const window = {setTimeout:(value:number):number => value + 1};
            return window.setTimeout(6);
        }
        if (shadowed() !== 7) throw new Error("shadowed global");
        worker.addEventListener("message", () => { received++; done(); });
        const canceled = window.setTimeout(() => { throw new Error("canceled timer ran"); }, 0);
        globalThis.clearTimeout(canceled);
        const canceledInterval = globalThis.setInterval(() => { throw new Error("canceled interval ran"); }, 0);
        window.clearInterval(canceledInterval);
        window.queueMicrotask(() => { microtasks++; });
        window.setTimeout(() => {
            if (microtasks !== 1) throw new Error("microtasks must run first");
            timeouts++;
            done();
        }, 0);
        interval = window.setInterval(() => {
            intervals++;
            globalThis.clearInterval(interval);
            done();
        }, 0);
    `;
    const fileName = join(directory, "entry.ts");
    const result = compileSource(source, {fileName});
    assert.doesNotMatch(result.cpp, /create_engine\(/);
    writeFileSync(worker, 'window.setTimeout(() => {}, 0);');
    assert.throws(() => compileSource(source, {fileName}), /Window global is not available in a worker realm/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DBBLITE_WORKERS=1",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
});
