import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("nullable method records preserve receiver, callback and argument evaluation", t => {
    const result = compileSource(`
        interface Sink { write(value: string): void; read(): string; erase?(key: string): void; }
        let value = "";
        let argumentsRun = 0;
        let writes = 0;
        const sink: Sink = {write: text => { value = text; writes++; }, read: () => value};
        function argument(): string { argumentsRun++; return "saved"; }
        function operate(target: Sink | null): string | undefined {
            target?.write(argument());
            target?.erase?.(argument());
            return target?.read();
        }
        if (operate(null) !== undefined || argumentsRun !== 0) throw new Error("absent receiver effects");
        if (operate(sink) !== "saved" || argumentsRun !== 1 || writes !== 1) throw new Error("method dispatch");
        let selections = 0;
        function select(): Sink | null { selections++; return sink; }
        select()?.write("selected");
        if (selections !== 1 || writes !== 2 || value !== "selected") throw new Error("receiver evaluation");
        interface Owner { sink: Sink | null; }
        const owner: Owner = {sink};
        function clear(): string { owner.sink = null; sink.write = () => { writes += 100; }; return "captured"; }
        owner.sink?.write(clear());
        if (owner.sink !== null || writes !== 3 || value !== "captured") throw new Error("receiver and method snapshot");
        let removals = 0;
        sink.erase = () => { removals++; };
        function clearErase(): string { sink.erase = undefined; return "key"; }
        sink.erase?.(clearErase());
        if (removals !== 1 || sink.erase !== undefined) throw new Error("optional method snapshot");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/nullable-record-methods");
    mkdirSync(directory, {recursive:true});
    const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    assert.equal(execFileSync(executable, {encoding:"utf8", timeout:10000, stdio:"pipe"}), "");
});
