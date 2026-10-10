import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored null-only callbacks widened to void preserve finally settlement", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        let calls=0;
        function empty():null {calls++;return null;}
        const readers:Array<()=>null>=[empty];
        const cleanup:()=>void=readers[0]!;
        (async()=>{
            const value=await Promise.resolve(7).finally(cleanup);
            if(value!==7||calls!==1)throw new Error('finally ignores null once');
            const returned=readers[0]!();
            if(returned!==null||returned===undefined||Number(calls)!==2)
                throw new Error('null callback does not become undefined');
            globalThis.close();
        })();
    `;
    await assertAsyncSourceCloses(source);
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "null-only-finally-completions", result.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
