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

check(
    "variant-specific-optional-references-decide-membership-by-tags",
    `
    type Item={kind:'leaf'}|{kind:'branch';next?:Item};
    function has(value:Item,key:string){return key in value;}
    function owns(value:Item,key:string){return Object.hasOwn(value,key);}
    const items:Item[]=[{kind:'branch'},{kind:'leaf'},{kind:'branch',next:{kind:'leaf'}}];
    const report=()=>items.map((item)=>('next' in item?'i':'-')+(Object.hasOwn(item,'next')?'o':'-')+(has(item,'next')?'h':'-')+(owns(item,'next')?'w':'-')+Object.keys(item).length).join(',');
    if(report()!=='----1,----1,iohw2')throw new Error(report());
    const last=items[2]!;
    if(last.kind==='branch')delete last.next;
    const first=items[0]!;
    if(first.kind==='branch')first.next=items[1]!;
    if(report()!=='iohw2,----1,----1')throw new Error(report());
    `,
);

test("tagged fields whose arms disagree on own-key presence refuse membership", () => {
    assert.throws(
        () =>
            compileSource(`
                type Item={kind:'a';x?:number}|{kind:'b';x:number|undefined}|{kind:'c'};
                const items:Item[]=[{kind:'a'},{kind:'b',x:undefined},{kind:'c'}];
                const has=items.map((item)=>'x' in item);
            `),
        /Own-property presence of 'x' is not represented/,
    );
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

check(
    "property-discriminated-recursive-owners",
    `
    type Operand={literal:number}|{input:string};
    type Expr={flag:string}|{not:Expr}|{all:Expr[]}|{compare:[Operand,Operand]}|{always:true};
    function operand(value:Operand):number {
        return 'literal' in value ? value.literal : value.input.length;
    }
    function evaluate(value:Expr):number {
        if('flag' in value)return value.flag.length;
        if('not' in value)return -evaluate(value.not);
        if('all' in value){let sum=0;for(const child of value.all)sum+=evaluate(child);return sum;}
        if('compare' in value)return operand(value.compare[0])+operand(value.compare[1]);
        return value.always ? 1 : 0;
    }
    function wrap(value:Expr):Expr{return {not:value};}
    const values:Expr[]=[{flag:'a'}];
    const leaf=values[0]!;
    values.push(wrap(leaf));values.push({all:[leaf,values[1]!]});
    values.push({compare:[{literal:3},{input:'xy'}]});values.push({always:true});
    const readers:Array<(value:Expr)=>number>=[evaluate];
    if(readers[0]!(values[1]!)!==-1||readers[0]!(values[2]!)!==0||readers[0]!(values[3]!)!==5||readers[0]!(values[4]!)!==1)throw new Error('recursive evaluation');
    const keys=['flag','not','all','compare','always'];
    for(let i=0;i<values.length;i++){
        const value=values[i]!;
        if(Object.keys(value).join(',')!==keys[i]||!Object.hasOwn(value,keys[i]!))throw new Error('exact key presence');
    }
    if('flag' in leaf)leaf.flag='updated';
    const wrapped=values[1]!;
    if(!('not' in wrapped)||wrapped.not!==leaf||evaluate(wrapped)!==-7)throw new Error('live recursive identity');
    const operands:Operand[]=[{literal:0},{input:''}];
    if(JSON.stringify(operands)!=='[{"literal":0},{"input":""}]'||operand(operands[0]!)!==0||operand(operands[1]!)!==0)throw new Error('empty payload presence');
    if('not' in wrapped)wrapped.not=wrapped;
`,
);

test("property union admission does not conflate absent keys with empty payloads", () => {
    const frontend = createCompilerProgram(
        `type Nullable={value:null}|{next:Nullable};
         type Undefined={value:undefined}|{next:Undefined};
         type Optional={value?:number}|{next:Optional};`,
        resolve("property-union-presence.ts"),
    );
    const registry = new DataTypeRegistry(
        frontend.checker,
        (_node, message) => {
            throw new Error(message);
        },
        new ClassHierarchy(frontend.checker, frontend.program),
        true,
    );
    for (const node of frontend.sourceFile.statements) {
        if (!ts.isTypeAliasDeclaration(node)) continue;
        assert.equal(
            registry.fromTsType(
                frontend.checker.getTypeAtLocation(node.name),
                node,
            ),
            undefined,
        );
    }
    assert.deepEqual(registry.renderPreamble(), {
        standalone: "",
        shared: "",
        definitions: [],
    });
});

test("declined recursive layouts roll back provisional identities and nested definitions", () => {
    const frontend = createCompilerProgram(
        `
        type Tagged={kind:'done';value:number}|{kind:'next';read:()=>Promise<Tagged>;payload:FinalizationRegistry<number>};
        type Common={next:()=>Common;payload:FinalizationRegistry<number>;left:number}|{next:()=>Common;payload:FinalizationRegistry<number>;right:boolean};
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
