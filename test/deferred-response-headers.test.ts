import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const deferredCapabilities = "runtime-throw" as const;

test("packaged static response headers throw before header arguments and leave later work reachable", () => {
    const directory = resolve("artifacts/deferred-response-headers");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "payload.bin"), Buffer.from([31, 139, 8]));
    const source = `
        let keys=0,catches=0,after=0;
        function headerName():string {keys++;return 'content-encoding';}
        async function run():Promise<void>{
            const response=await fetch('./payload.bin');
            try { response.headers?.get(headerName()); } catch(error) {
                if(!error.message.includes('dom:Response.headers'))throw error;
                catches++;
            }
            after++;
        }
        run();
        if(keys!==0||catches!==1||after!==1)throw new Error('header boundary ordering');
    `;
    const options = { fileName: join(directory, "entry.ts") };
    assert.throws(
        () => compileSource(source, options),
        /headers|static-fetch-response/,
    );
    const result = compileSource(source, { ...options, deferredCapabilities });
    assert.deepEqual(
        result.manifest.deferredCapabilities?.map((site) => [
            site.id,
            site.operation,
            site.timing,
        ]),
        [["dom:Response.headers", "read", "throw"]],
    );
    assert.ok(!result.manifest.features.includes("platform:http"));
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(tools, "deferred-response-headers/static", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
    assert.throws(
        () =>
            compileSource(source + "new FinalizationRegistry(()=>{});", {
                ...options,
                deferredCapabilities,
            }),
        /Unsupported constructor/,
    );
});

test("Headers values keep native nullable storage and authored names keep their implementation", () => {
    const source = `
        const reads:Array<(headers:Headers)=>string|null>=[headers=>headers.get('content-type')];
        const optional:Array<(headers:Headers|undefined)=>boolean|undefined>=[headers=>headers?.has('content-type')];
        if(optional[0]!(undefined)!==undefined)throw new Error('absent Headers');
        class LocalHeaders {get(key:string):string|null{return key==='content-type'?'image/png':null;}}
        const local=new LocalHeaders();
        const response={headers:local};
        if(response.headers.get('content-type')!=='image/png')throw new Error('authored method');
    `;
    const result = compileSource(source, { deferredCapabilities });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.match(result.cpp, /bbl::pal::HttpHeaders/);
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools);
    runGeneratedProgram(
        tools,
        "deferred-response-headers/retained",
        result.cpp,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});
