import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import { createCompilerProgram } from "../src/compiler/program.js";
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
        const directory = resolve("artifacts/recursive-object-unions", name);
        mkdirSync(directory, { recursive: true });
        if (realm) writeFileSync(join(directory, "worker.ts"), "self.close();");
        const prefix = realm
            ? "const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});worker.terminate();\n"
            : "";
        const result = compileSource(prefix + source, {
            fileName: join(directory, "entry.ts"),
        });
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `recursive-object-unions/${name}`,
            `#define main generated_main\n${result.cpp}\n#undef main\n` +
                `int main(){const auto baseline=bbl::js::managed_node_count();const int result=generated_main();` +
                `bbl::js::collect_cycles();if(bbl::js::managed_node_count()!=baseline)throw std::runtime_error("recursive union ownership leak");return result;}\n`,
            { defines: realm ? ["BBLITE_WORKERS=1"] : [], timeoutMs: 10000 },
        );
    });
}

test("variant-specific optional references refuse ambiguous own-key membership", () => {
    for (const initialize of [
        "const items:Item[]=[{kind:'branch'}];",
        "const items:Item[]=[{kind:'branch',next:undefined}];",
        "const items:Item[]=[{kind:'branch'}];if(items[0]!.kind==='branch')items[0]!.next=undefined;",
        "const items:Item[]=[{kind:'branch',next:{kind:'leaf'}}];if(items[0]!.kind==='branch')delete items[0]!.next;",
    ]) {
        for (const membership of [
            "Object.hasOwn(items[0]!,'next');",
            "'next' in items[0]!;",
            "function has(value:Item,key:string){return Object.hasOwn(value,key);}has(items[0]!,'next');",
            "function has(value:Item,key:string){return key in value;}has(items[0]!,'next');",
        ]) {
            assert.throws(
                () =>
                    compileSource(`
                        type Item={kind:'leaf'}|{kind:'branch';next?:Item};
                        ${initialize}
                        ${membership}
                    `),
                /Own-property presence of 'next' is not represented/,
            );
        }
    }
});

check(
    "tagged-array-optional-and-callback-cycles",
    `
    type Item={kind:'value';value:number;next?:Item}|{kind:'list';values:Item[];next?:Item}|{kind:'call';read:()=>Item;next?:Item};
    const items:Item[]=[{kind:'value',value:3}];
    const first=items[0]!;
    function has(value:Item,key:string){return Object.hasOwn(value,key);}
    if(Object.hasOwn(first,'next')||has(first,'next')||'next' in first)throw new Error('optional key absent');
    items.push({kind:'list',values:[first]});
    items.push({kind:'call',read:()=>first});
    const list=items[1]!, callback=items[2]!;
    first.next=list;list.next=first;
    if(!Object.hasOwn(first,'next')||!has(first,'next')||!('next' in first))throw new Error('optional key assigned');
    if(list.kind!=='list'||list.values[0]!==first||list.next!==first||first.next!==list)throw new Error('recursive identity');
    if(callback.kind!=='call'||callback.read()!==first)throw new Error('recursive callback result');
    if(first.kind!=='value')throw new Error('tag');
    first.value=7;
    const returned=callback.read();
    if(returned.kind!=='value'||returned.value!==7)throw new Error('live recursive value');
    delete first.next;
    if(Object.hasOwn(first,'next')||has(first,'next')||'next' in first||first.next!==undefined)throw new Error('optional key deleted');
    first.next=callback;callback.next=first;
`,
);

check(
    "common-field-array-optional-and-callback-cycles",
    `
    type Item={value:number;next?:Item;children:()=>Item[]}|{value:number|undefined;next?:Item;children:()=>Item[]};
    const items:Item[]=[];
    items.push({value:2,children:()=>items});
    items.push({value:undefined,children:()=>items});
    const first=items[0]!,second=items[1]!;
    first.next=second;second.next=first;
    if(first.children()[1]!==second||second.children()[0]!==first||first.next!==second||second.next!==first)throw new Error('common identity');
    second.value=9;
    if(first.next.value!==9||first.children()[1]!.value!==9)throw new Error('common live value');
`,
);

check(
    "recursive-tagged-promises",
    `
    type Result={kind:'value';value:number}|{kind:'next';read:()=>Promise<Result>;next?:Result};
    (async()=>{
        const values:Result[]=[{kind:'value',value:4}];
        const first=values[0]!;
        values.push({kind:'next',read:async()=>first});
        const next=values[1]!;
        if(next.kind!=='next')throw new Error('tag');
        next.next=next;
        const result=await next.read();
        if(result!==first||result.kind!=='value'||result.value!==4)throw new Error('promise identity');
        first.value=8;
        const again=await next.read();
        if(again.kind!=='value'||again.value!==8)throw new Error('promise live value');
        globalThis.close();
    })();
`,
    true,
);

check(
    "recursive-common-promises",
    `
    type Item={value:number;read:()=>Promise<Item>;next?:Item}|{value:number|undefined;read:()=>Promise<Item>;next?:Item};
    (async()=>{
        const items:Item[]=[];
        items.push({value:2,read:async()=>items[0]!});
        items.push({value:undefined,read:async()=>items[1]!});
        const first=items[0]!,second=items[1]!;
        first.next=second;second.next=first;
        if(await first.read()!==first||await second.read()!==second)throw new Error('common promise identity');
        second.value=7;
        if((await first.next.read()).value!==7)throw new Error('common promise live value');
        globalThis.close();
    })();
`,
    true,
);

test("declined recursive layouts roll back provisional identities and nested definitions", () => {
    const frontend = createCompilerProgram(
        `
        type Tagged={kind:'done';value:number}|{kind:'next';read:()=>Promise<Tagged>;payload:symbol};
        type Common={next:()=>Common;payload:symbol;left:number}|{next:()=>Common;payload:symbol;right:boolean};
        interface Good {value:number;next?:Good;}
        `,
        resolve("recursive-layout-rollback.ts"),
    );
    const registry = (): DataTypeRegistry =>
        new DataTypeRegistry(
            frontend.checker,
            (_node, message) => {
                throw new Error(message);
            },
            new ClassHierarchy(frontend.checker, frontend.program),
            true,
        );
    const types = frontend.sourceFile.statements.flatMap((node) =>
        ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
            ? [{ node, type: frontend.checker.getTypeAtLocation(node.name) }]
            : [],
    );
    const mapped = registry();
    for (const entry of types.slice(0, 2)) {
        assert.equal(mapped.fromTsType(entry.type, entry.node), undefined);
        assert.equal(mapped.fromTsType(entry.type, entry.node), undefined);
    }
    const good = types[2]!;
    const fresh = registry();
    const afterFailures = mapped.fromTsType(good.type, good.node);
    const withoutFailures = fresh.fromTsType(good.type, good.node);
    assert.ok(afterFailures && withoutFailures);
    assert.deepEqual(afterFailures, withoutFailures);
    assert.equal(mapped.cppType(afterFailures), fresh.cppType(withoutFailures));
    assert.deepEqual(mapped.renderPreamble(), fresh.renderPreamble());
});

test("required owned record fields still refuse deletion", () => {
    assert.throws(
        () =>
            compileSource(`
                const records:Array<{next:{value:number}}>=[{next:{value:1}}];
                delete records[0]!.next;
            `),
        /required field of its type/,
    );
});
