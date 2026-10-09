import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("owned Promise tuple arguments survive destructured async activations", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        (async()=>{
            async function read([label,value]:readonly [string,number]):Promise<string> {
                const captured=()=>label+':'+value;
                await Promise.resolve();
                return captured();
            }
            const reaction=await Promise.resolve(['reaction',6] as const).then(async ([label,value])=>{
                const captured=()=>label+':'+value;
                await Promise.resolve();
                return captured();
            });
            const settled=await Promise.resolve(['settled',8] as const);
            const deferred=async()=>{await Promise.resolve();return read(settled);};
            if(reaction!=='reaction:6'||await deferred()!=='settled:8')throw new Error('retained tuple owner');
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            queueMicrotask,
            close: () => {
                closed = true;
            },
        },
    );
    assert.equal(closed, true);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(native!, "async-settlement-captures", result.cpp, {
            defines: ["BBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
});
