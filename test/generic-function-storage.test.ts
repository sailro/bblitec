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
        const directory = resolve("artifacts/generic-function-storage", name);
        mkdirSync(directory, { recursive: true });
        if (realm) writeFileSync(join(directory, "worker.ts"), "self.close();");
        const prefix = realm
            ? `const worker = new Worker(new URL('./worker.ts', import.meta.url), {type:'module'}); worker.terminate();\n`
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
            `generic-function-storage/${name}`,
            result.cpp,
            {
                defines: realm ? ["BBLITE_WORKERS=1"] : [],
            },
        );
    });
}

check(
    "forward-generic-state",
    `
    interface State { failed():boolean; read<T>(fn:()=>T):T; report(error:unknown):void; count():number; }
    const order:string[]=[];
    function make():State {
        order.push('factory');
        let count=0;
        return {
            failed:()=>count>0,
            read<T>(fn:()=>T):T { count++;return fn(); },
            report:(error:unknown)=>{if(typeof error==='string')count+=error.length;},
            count:()=>count,
        };
    }
    const saved:Array<()=>boolean>=[];
    saved.push(()=>state.failed());
    let threw=false;
    try { saved[0]!(); } catch { threw=true; }
    if(!threw||order.length!==0)throw new Error('temporal dead zone');
    order.push('before');
    const state=make();
    if(saved[0]!()||order.join()!=='before,factory')throw new Error('declaration order');
    if(state.read(()=>3)!==3||state.read(()=>'text')!=='text')throw new Error('specializations');
    state.report('abc');
    if(!saved[0]!()||state.count()!==5)throw new Error('shared captures');
    const alias=state.read;
    if(alias!==state.read||alias(()=>true)!==true||state.count()!==6)throw new Error('method alias');
    const duplicate=state;
    if(duplicate!==state)throw new Error('record identity');
    duplicate.failed=()=>false;
    if(saved[0]!())throw new Error('record field alias');
`,
);

check(
    "generic-callback-identity-and-optional-calls",
    `
    interface State { read<T>(fn:()=>T):T; count():number; }
    function make():State {let calls=0;return {read<T>(fn:()=>T):T{calls++;return fn();},count:()=>calls};}
    const states:State[]=[];
    for(let i=0;i<3;i++)states.push(make());
    if(states[0]!.read===states[1]!.read)throw new Error('fresh function identities');
    const original=states[0]!.read;
    function replace():()=>number {states[0]!.read=<T>(fn:()=>T):T=>fn();return ()=>7;}
    if(states[0]!.read(replace())!==7||states[0]!.count()!==1)throw new Error('callee before arguments');
    if(original===states[0]!.read||original(()=>4)!==4||states[0]!.count()!==2)throw new Error('retained old callback');
    if(states[1]!.count()!==0)throw new Error('separate closure state');
    const callbacks=new Set([original,original]);
    if(callbacks.size!==1||!callbacks.has(original))throw new Error('function identity keys');
    interface Box { read?:<T>(fn:()=>T)=>T; }
    const boxes:Box[]=[{}];const box=boxes[0]!;
    let evaluations=0;
    function argument():()=>number {evaluations++;return ()=>9;}
    if(box.read?.(argument())!==undefined||evaluations!==0)throw new Error('optional arguments');
    box.read=<T>(fn:()=>T):T=>fn();
    if(box.read?.(argument())!==9||evaluations!==1)throw new Error('present optional function');
    function clear(target:Box):void {delete target.read;}
    clear(box);
    if(box.read?.(argument())!==undefined||evaluations!==1)throw new Error('deleted optional function');
`,
);

check(
    "same-name-type-identities",
    `
    interface State { read<T>(fn:()=>T):T; ready():boolean; }
    function make():State {return {read<T>(fn:()=>T):T{return fn();},ready:()=>true};}
    const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();
    { interface Item { left:number; } function item():Item{return {left:3};}
      const result=state.read(item);if(result.left!==3)throw new Error('number layout'); }
    { interface Item { right:string; } function item():Item{return {right:'text'};}
      const result=state.read(item);if(result.right!=='text')throw new Error('string layout'); }
`,
);

check(
    "generic-callback-declared-parameters",
    `
    interface State{apply<T>(value:T,callback:(value:T)=>number):number;ready():boolean;}
    function make():State{return{ready:()=>true,apply<T>(value:T,callback:(value:T)=>number):number{return callback(value);}};}
    const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();
    if(state.apply(5,()=>3)!==3)throw new Error('ignored callback argument');
    if(state.apply('value',(value)=>value.length)!==5)throw new Error('represented callback argument');
`,
);

check(
    "generic-async-results-and-hook-absence",
    `
    interface Gate { ready():boolean; run<T>(fn:()=>T|Promise<T>):Promise<T>; }
    interface Hooks { enter?:()=>void|((ok:boolean)=>void); }
    function make(hooks:Hooks):Gate {
        let running=false;
        return {
            ready:()=>!running,
            async run<T>(fn:()=>T|Promise<T>):Promise<T> {
                let release:((ok:boolean)=>void)|void;
                running=true;
                try {release=hooks.enter?.();return await fn();}
                finally {running=false;release?.(true);}
            },
        };
    }
    (async()=>{
        const checks:Array<()=>boolean>=[];checks.push(()=>gate.ready());const gate=make({});
        if(await gate.run(async()=>4)!==4||!checks[0]!())throw new Error('async number');
        let calls=0;await gate.run(async()=>{calls++;});
        if(calls!==1||!checks[0]!())throw new Error('async void');
        let releases=0;const other=make({enter:()=>{calls++;return ()=>{releases++;};}});
        if(await other.run(()=>'value')!=='value'||releases!==1)throw new Error('release hook');
        globalThis.close();
    })();
`,
    true,
);

test("generic storage retains unsupported native boundaries", () => {
    const prefix = `interface State{read<T>(fn:()=>T):T;ready():boolean;}function make():State{return{read<T>(fn:()=>T):T{return fn();},ready:()=>true};}const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();`;
    assert.throws(
        () => compileSource(prefix + `state.read.bind(null);`),
        /Stored generic Function.bind requires a concrete signature/,
    );
    assert.throws(
        () =>
            compileSource(
                prefix +
                    `const fixed:(fn:()=>number)=>number=state.read;fixed(()=>1);`,
            ),
        /Stored generic function conversion requires matching concrete signature families/,
    );
    assert.throws(
        () => compileSource(prefix + `state.read(()=>({value:undefined}));`),
        /Stored generic function instantiation requires a fully represented native signature/,
    );
});

test("stored polymorphic recursion and detached receivers refuse", () => {
    const setup = `const saved:Array<()=>boolean>=[];saved.push(()=>state.ready());const state=make();`;
    assert.throws(
        () =>
            compileSource(`
        interface State{read<T>(value:T,depth:number):T;ready():boolean;}
        function make():State{return{ready:()=>true,read<T>(value:T,depth:number):T{return depth>0?state.read(value,depth-1):value;}};}
        ${setup}state.read(3,2);
    `),
        /Recursive stored generic functions require an already represented signature/,
    );
    assert.throws(
        () =>
            compileSource(`
        interface State{report(value:unknown):number;ready():boolean;}
        function make():State{return{ready:()=>true,report(value:unknown):number{if(typeof value==='number'&&value>0)return state.report(value-1);return 0;}};}
        ${setup}state.report(2);
    `),
        /Recursive stored generic functions require an already represented signature/,
    );
    assert.throws(
        () =>
            compileSource(`
        interface State{left<T>(value:T,n:number):T;right<T>(value:T,n:number):T;ready():boolean;}
        function make():State{return{ready:()=>true,left<T>(value:T,n:number):T{return n>0?state.right(value,n-1):value;},right<T>(value:T,n:number):T{return n>0?state.left(value,n-1):value;}};}
        ${setup}state.left(3,2);
    `),
        /Recursive stored generic functions require an already represented signature/,
    );
    assert.throws(
        () =>
            compileSource(`
        interface State{count:number;read<T>(value:T):T;ready():boolean;}
        function make():State{return{count:0,ready:()=>true,read<T>(value:T):T{this.count++;return value;}};}
        ${setup}state.read(3);
    `),
        /Stored generic methods using this require a shared native receiver/,
    );
});

test("generic callback tables trace cycles and retain selected invocations", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "generic-function-storage/gc",
        `
        #include <bblite/js_data.hpp>
        #include <cassert>
        struct Table {
            bbl::js::Callback<double()> call;
            void gc_trace(const bbl::js::TraceVisitor& visitor) const {visitor(call);}
        };
        struct Environment {
            bbl::js::GenericCallback<bbl::js::Ref<Table>> callback;
            void gc_trace(const bbl::js::TraceVisitor& visitor) const {visitor(callback);}
        };
        int main(){
            using namespace bbl::js;
            const auto initial=managed_node_count();
            {
                auto table=make_ref<Table>();
                GenericCallback<Ref<Table>> callback{17,table};
                table->call=make_closure(Environment{callback},[](Environment&){return 8.0;});
                auto selected=snapshot_callback(callback.select(&Table::call));
                table.reset();callback={};
                assert(collect_cycles()==0);
                assert(selected()==8.0);
            }
            assert(collect_cycles()==2);
            assert(managed_node_count()==initial);
            GenericCallback<Ref<Table>> absent;
            assert(!absent.select(&Table::call));
        }
    `,
    );
});
