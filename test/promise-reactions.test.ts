import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("two-callback Promise.then selects the original outcome and adopts returned promises", t => {
    const directory = resolve("artifacts/promise-reactions");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        let completed = 0;
        let wrongRejections = 0;
        let synchronous = true;
        function done(): void {
            if (synchronous || wrongRejections !== 0) throw new Error("reaction scheduling or selection");
            completed++;
            if (completed === 5) globalThis.close();
        }
        async function success(): Promise<number> { await Promise.resolve(0); return 4; }
        async function failure(): Promise<number> {
            function message(): string { return "source"; }
            await Promise.resolve(0);
            throw new Error(message());
        }
        success().then((value): void => {
            if (value !== 4) throw new Error("input value");
            throw new Error("handler");
        }, (): void => { wrongRejections++; }).catch((error): void => {
            if (String(error) !== "Error: handler") throw new Error("fulfillment error propagation");
            done();
        });
        failure().then((): void => { throw new Error("unexpected fulfillment"); }, (error): void => {
            if (String(error) !== "Error: source") throw new Error("source rejection");
            done();
        });
        success().then(value => Promise.resolve(value + 1), () => Promise.resolve(7)).then(value => {
            if (value !== 5) throw new Error("returned promise adoption");
            done();
        });
        failure().then(() => 11, () => 29).then(value => {
            if (value !== 29) throw new Error("recovery value is not the fulfillment constant");
            done();
        });
        interface Result { value: number; }
        function result(value: number): Result { return {value}; }
        failure().then(() => result(11), () => result(29)).then(record => {
            if (record.value !== 29) throw new Error("recovery record");
            done();
        });
        synchronous = false;
    `;
    const fileName = join(directory, "entry.ts");
    const result = compileSource(source, {fileName});
    assert.throws(() => compileSource(source.replace("() => 29", '() => "different"'), {fileName}), /same admitted result type/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/DBBLITE_WORKERS=1",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
});
