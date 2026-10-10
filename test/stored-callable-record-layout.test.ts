import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(
            tools,
            `stored-callable-record-layout/${name}`,
            result.cpp,
            { timeoutMs: 10000, expectedOutput: "" },
        );
    });
}

check(
    "stored callable record views share parameter and result layouts",
    `
    interface Input {value:number}
    interface DetailedInput {value:number; label:string}
    interface Output {count:number}
    interface DetailedOutput {count:number; name:string}
    interface Handler {apply(value:Input):Output}
    const output:DetailedOutput={count:4,name:'kept'};
    const original={apply(value:DetailedInput):DetailedOutput {
        value.value++;
        return output;
    }};
    const handlers:Handler[]=[original];
    const input:DetailedInput={value:2,label:'input'};
    const selected=handlers[0];
    const result=selected.apply(input);
    result.count=7;
    if(selected!==original || result!==output || input.value!==3 || output.count!==7 ||
       input.label!=='input' || output.name!=='kept')throw new Error('record aliases');
    selected.apply=value=>{value.value+=10;return output;};
    if(original.apply(input)!==output || Number(input.value)!==13)throw new Error('method replacement');
`,
);

check(
    "stored callable layouts join records inside callback and array slots",
    `
    interface Item {value:number}
    interface DetailedItem {value:number;label:string}
    interface Handler {apply(callback:(values:Item[])=>number):number}
    const item:DetailedItem={value:2,label:'kept'};
    const values:DetailedItem[]=[item];
    const original={apply(callback:(values:DetailedItem[])=>number):number {
        return callback(values);
    }};
    const handlers:Handler[]=[original];
    const selected=handlers[0];
    const result=selected.apply(items=>{
        if(items!==values || items[0]!==item)throw new Error('nested aliases');
        items[0].value+=3;
        return items[0].value;
    });
    if(selected!==original || result!==5 || item.value!==5 || item.label!=='kept')
        throw new Error('nested mutation');
`,
);

for (const absence of ["null", "undefined"] as const)
    check(
        `stored callbacks widen ${absence} results without replacing identities`,
        `
        interface Handler {run(mode:number):number[]|null|undefined}
        const values=[3];
        let calls=0;
        function read(mode:number):number[]|${absence} {
            calls++;
            return mode>0?values:${absence};
        }
        const stored:Array<typeof read>=[read];
        const original={run:stored[0]!};
        const handlers:Handler[]=[original];
        const held=handlers[0]!;
        if(held!==original || held.run!==stored[0])
            throw new Error('callback identity');
        const result=held.run(1);
        if(result!==values || held.run(0)!==${absence} || calls!==2)
            throw new Error('result identity and absence');
        result![0]=8;
        if(values[0]!==8)throw new Error('shared returned array');
        const alias=held.run;
        if(alias!==stored[0] || alias(1)!==values || Number(calls)!==3)
            throw new Error('adapted alias and one evaluation');
        `,
    );

test("stored callable record views refuse incompatible result storage", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Handler {apply(value:{count:number}):number|string}
            const original={apply(value:{count:number;label:string}):number {
                return ++value.count;
            }};
            const handlers:Handler[]=[original];
            if(handlers[0]!==original)throw new Error('identity');
        `),
        /no shared layout holds both record types/,
    );
});
