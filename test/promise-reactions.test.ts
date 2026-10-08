import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("promise boundaries snapshot scalar Map lookups before source mutation", (t) => {
    const directory = resolve("artifacts/promise-reactions/map-snapshots");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        const values=new Map<string,number>([["settled",3],["returned",5],["reaction",7],["argument",11]]);
        async function selected():Promise<number|undefined>{return values.get("returned");}
        async function retained(value:number|undefined):Promise<number|undefined>{await Promise.resolve();return value;}
        void(async()=>{
            const settled=Promise.resolve(values.get("settled"));
            const missing=Promise.resolve(values.get("missing"));
            const returned=selected();
            const reaction=Promise.resolve().then(()=>values.get("reaction"));
            const argument=retained(values.get("argument"));
            await Promise.resolve();
            values.set("settled",30);values.set("returned",50);values.set("reaction",70);values.set("argument",110);
            values.set("missing",13);
            if(await settled!==3||await returned!==5||await reaction!==7||await argument!==11||await missing!==undefined)
                throw new Error("promise payload aliases a rebound map slot");
            const snapshot=await settled;
            const forwarded=settled.then(value=>value);
            if(snapshot!==3||await forwarded!==3)
                throw new Error("promise consumer re-reads the original map slot");
            values.delete("settled");values.clear();
            if(await settled!==3||await returned!==5||await reaction!==7||await argument!==11||await missing!==undefined)
                throw new Error("promise payload depends on a deleted map slot");
            globalThis.close();
        })();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "promise-reactions/map-snapshots", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("two-callback Promise.then selects the original outcome and adopts returned promises", (t) => {
    const directory = resolve("artifacts/promise-reactions");
    mkdirSync(directory, { recursive: true });
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
    const result = compileSource(source, { fileName });
    const widened = compileSource(
        source
            .replace("() => 29", '() => "different"')
            .replace("value !== 29", 'value !== "different"'),
        { fileName },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            timeout: 10000,
            stdio: "pipe",
        }),
        "",
    );
    runGeneratedProgram(tools, "promise-reactions/mixed-results", widened.cpp, {
        defines: ["BBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
