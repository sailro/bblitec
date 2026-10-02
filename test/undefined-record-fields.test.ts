import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string, realm = false): void {
    test(name, async (t) => {
        await runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            { close: () => {} },
        );
        const directory = resolve("artifacts/undefined-record-fields", name);
        mkdirSync(directory, { recursive: true });
        if (realm) writeFileSync(join(directory, "worker.ts"), "self.close();");
        const prefix = realm
            ? `const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();\n`
            : "";
        const result = compileSource(prefix + source, {
            fileName: join(directory, "entry.ts"),
        });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `undefined-record-fields/${name}`,
            result.cpp,
            { defines: realm ? ["BBLITE_WORKERS=1"] : [] },
        );
    });
}

check(
    "required-undefined-presence-and-reads",
    `
    interface Item {value:void; label:string; optional?:number;}
    const items:Item[]=[{value:undefined,label:'item'}];
    const item=items[0]!;
    if(!('value' in item)||'optional' in item)throw new Error('own keys');
    if(Object.keys(item).join()!=='value,label')throw new Error('key order');
    if(JSON.stringify(item)!=='{"label":"item"}')throw new Error('JSON omission');
    if(item.value!==undefined||item.value===null||item.value!=null)throw new Error('nullish equality');
    if(typeof item.value!=='undefined'||String(item.value)!=='undefined'||(''+item.value)!=='undefined')throw new Error('text');
    if((item.value??'fallback')!=='fallback'||item.value)throw new Error('falsy');
    const copies:Item[]=[{...item}];
    if(!('value' in copies[0]!)||Object.keys(copies[0]!).join()!=='value,label')throw new Error('spread');
    let calls=0;
    function done():void {calls++;}
    item.value=done();
    if(calls!==1||item.value!==undefined)throw new Error('completion effects');
`,
);

check(
    "generic-tagged-undefined-completions",
    `
    type Result<T>={ok:true;value:T}|{ok:false};
    interface Gate {ready():boolean;run<T>(fn:()=>T|Promise<T>):Promise<Result<T>>;}
    function make():Gate {return {ready:()=>true,async run<T>(fn:()=>T|Promise<T>):Promise<Result<T>> {
        const value=await fn();return {ok:true,value};
    }};}
    (async()=>{
        const saved:Array<()=>boolean>=[];saved.push(()=>gate.ready());const gate=make();
        let calls=0;
        const a=await gate.run(async()=>{calls++;});
        if(!a.ok||a.value!==undefined||calls!==1)throw new Error('async void');
        if(JSON.stringify(a)!=='{"ok":true}')throw new Error('tagged JSON');
        const b=await gate.run(async()=>7);
        if(!b.ok||b.value!==7)throw new Error('async number');
        const c=await gate.run(()=>{calls++;});
        if(!c.ok||c.value!==undefined||calls!==2)throw new Error('sync void');
        {interface Item{field:number;}const item:Item={field:3};const result=await gate.run(()=>item);
         if(!result.ok||result.value.field!==3)throw new Error('named numeric payload');}
        {interface Item{field:string;}const item:Item={field:'text'};const result=await gate.run(()=>item);
         if(!result.ok||result.value.field!=='text')throw new Error('named text payload');}
        let failed=false;
        try {await gate.run(async():Promise<void>=>{throw new Error('failure');});}catch {failed=true;}
        if(!failed||!saved[0]!())throw new Error('failure');
        globalThis.close();
    })();
`,
    true,
);

check(
    "undefined-own-values",
    `
    const records:Array<{first:undefined;second:undefined}>=[{first:undefined,second:undefined}];
    const item=records[0]!;
    let count=0;
    for(const value of Object.values(item)) {if(value!==undefined)throw new Error('value');count++;}
    for(const [key,value] of Object.entries(item)) {if(value!==undefined||!key)throw new Error('entry');count++;}
    if(count!==4)throw new Error('enumeration');
    if(JSON.stringify(item)!=='{}'||JSON.stringify(item.first)!==undefined)throw new Error('undefined JSON');
`,
);

check(
    "optional-undefined-consumers-and-effects",
    `
    let reads=0;
    let getters=0;
    let fallbacks=0;
    const records:Array<{readonly value:undefined}>=[{get value(){getters++;return undefined;}}];
    function lookup(index:number){reads++;return records[index];}
    function fallback():string{fallbacks++;return 'fallback';}
    for(let index=0;index<2;index++){
        if(lookup(index)?.value!==undefined||lookup(index)?.value===null||lookup(index)?.value!=null)
            throw new Error('optional undefined equality');
        if(lookup(index)?.['value']!==undefined)throw new Error('optional indexed field');
        if((lookup(index)?.value??fallback())!=='fallback')throw new Error('undefined fallback');
        if(lookup(index)?.value||Boolean(lookup(index)?.value))throw new Error('undefined truthiness');
        if(typeof lookup(index)?.value!=='undefined')throw new Error('undefined typeof');
        if(String(lookup(index)?.value)!=='undefined'||(''+lookup(index)?.value)!=='undefined')
            throw new Error('undefined strings');
        if(JSON.stringify(lookup(index)?.value)!==undefined)throw new Error('undefined JSON');
        const copy:Array<{value:undefined}>=[{value:lookup(index)?.value}];
        if(!('value' in copy[0]!)||Object.keys(copy[0]!).join()!=='value'||JSON.stringify(copy[0]!)!=='{}')
            throw new Error('required undefined key');
    }
    if(reads!==24||getters!==12||fallbacks!==2)throw new Error('optional evaluation counts');
    const snapshot=lookup(0)?.value;
    records.length=0;
    if(snapshot!==undefined||String(snapshot)!=='undefined'||reads!==25||getters!==13)
        throw new Error('undefined snapshot');
`,
);

test("cloned undefined fields retain required keys and aliases", (t) => {
    const directory = resolve("artifacts/undefined-record-fields/clone");
    mkdirSync(directory, { recursive: true });
    const declarations = `
        export interface Item {value:undefined;optional?:number;}
        export interface Payload {item:Item;same:Item;}
        export function verify(copy:Payload):void {
            if(copy.item!==copy.same||copy.item.value!==undefined)throw new Error('clone values');
            if(!('value' in copy.item)||'optional' in copy.item||Object.keys(copy.item).join()!=='value')throw new Error('clone keys');
            if(JSON.stringify(copy.item)!=='{}')throw new Error('clone JSON');
        }
    `;
    runInNewContext(
        ts.transpileModule(
            declarations.replaceAll("export ", "") +
                `
        const item:Item={value:undefined};verify(structuredClone({item,same:item}));
    `,
            { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
        ).outputText,
        { structuredClone },
    );
    writeFileSync(join(directory, "types.ts"), declarations);
    writeFileSync(
        join(directory, "echo.ts"),
        `
        import {verify,type Payload} from './types';
        self.addEventListener('message',(event:MessageEvent<Payload>)=>{verify(event.data);self.postMessage(event.data);});
    `,
    );
    const result = compileSource(
        `
        import {verify,type Item,type Payload} from './types';
        const worker=new Worker(new URL('./echo.ts',import.meta.url),{type:'module'});
        const item:Item={value:undefined};const payload:Payload={item,same:item};
        worker.addEventListener('message',(event:MessageEvent<Payload>)=>{
            verify(event.data);if(event.data.item===item)throw new Error('clone identity');globalThis.close();
        });
        worker.postMessage(payload);
    `,
        { fileName: join(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "undefined-record-fields/clone", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
    });
});

test("erased void completion and optional undefined refuse", () => {
    for (const source of [
        `const f:()=>void=()=>7;const records:Array<{value:void}>=[{value:f()}];JSON.stringify(records);`,
        `let f=()=>{};f=()=>7;const records:Array<{value:void}>=[{value:f()}];JSON.stringify(records);`,
    ])
        assert.throws(
            () => compileSource(source),
            /requires a proven undefined completion/,
        );
    assert.throws(
        () =>
            compileSource(
                `const records:Array<{value?:undefined}>=[{}];Object.keys(records[0]!);`,
            ),
        /Optional undefined-only fields require separate own-property presence storage/,
    );
    assert.throws(
        () =>
            compileSource(
                `const records:Array<{value:undefined}>=[{value:undefined}];delete records[0]!.value;`,
            ),
        /delete.*optional|optional.*delete/i,
    );
    assert.throws(
        () =>
            compileSource(
                `const records:Array<{value:undefined}>=[{value:undefined}];if(JSON.stringify([records[0]!.value])!=='[null]')throw new Error('array');`,
            ),
        /JSON.stringify serializes a plain-data value/,
    );
    assert.throws(
        () =>
            compileSource(
                `type Item={ok:true;value?:undefined}|{ok:false};const records:Item[]=[{ok:true}];JSON.stringify(records);`,
            ),
        /Optional undefined-only fields require separate own-property presence storage/,
    );
    assert.throws(
        () =>
            compileSource(
                `type Item={ok:true;value:undefined}|{ok:false};const records:Item[]=[{ok:false}];if('value' in records[0]!)throw new Error('presence');`,
            ),
        /tagged undefined field requires its discriminant/,
    );
});

test("erased async void completions refuse required storage", () => {
    const directory = resolve("artifacts/undefined-record-fields/erased-async");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const prefix = `const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();\n`;
    const gate = `type Result<T>={ok:true;value:T}|{ok:false};
        interface Gate{ready():boolean;run<T>(fn:()=>T|Promise<T>):Promise<Result<T>>;}
        function make():Gate{return{ready:()=>true,async run<T>(fn:()=>T|Promise<T>):Promise<Result<T>>{const value=await fn();return {ok:true,value};}};}`;
    for (const body of [
        `const erased:()=>void=async()=>7;const records:Array<{value:void}>=[{value:await erased()}];JSON.stringify(records);`,
        `const erased:()=>void=()=>7;const saved:Array<()=>boolean>=[];saved.push(()=>gate.ready());const gate=make();const result=await gate.run(erased);JSON.stringify(result);`,
        `const erased:()=>void=async()=>7;const saved:Array<()=>boolean>=[];saved.push(()=>gate.ready());const gate=make();const result=await gate.run(erased);JSON.stringify(result);`,
    ])
        assert.throws(
            () =>
                compileSource(
                    prefix +
                        gate +
                        `(async()=>{${body}globalThis.close();})();`,
                    { fileName: join(directory, "entry.ts") },
                ),
            /requires a proven undefined completion/,
        );
});
