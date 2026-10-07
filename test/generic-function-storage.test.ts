import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import {
    GenericFunctionStorage,
    GenericFunctionStorageRequired,
} from "../src/compiler/generic-function-storage.js";
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
    "stored-unknown-rest-signatures",
    `
    interface Host { report?:(...values:unknown[])=>void; }
    const hosts:Host[]=[{}];
    const host=hosts[0]!;
    let total=0, evaluations=0;
    const retained:Array<()=>number>=[];
    function argument():number { evaluations++;return 3; }
    host.report?.(argument());
    if(evaluations!==0)throw new Error('absent rest callback evaluates arguments');
    host.report=(...values:unknown[])=>{
        total+=values.length;
        for(const value of values) {
            if(typeof value==='number') total+=value;
            if(typeof value==='string') total+=value.length;
        }
        retained.push(()=>values.length);
    };
    const original=host.report;
    host.report?.();
    host.report?.(argument(),5);
    host.report?.('word',2,true);
    const source=[7,8];
    host.report?.(...source);
    source.push(9);
    if(total!==36||evaluations!==1||retained[0]!()!==0||retained[3]!()!==2)
        throw new Error('rest packing, specialization or fresh array');
    function replace():number {host.report=(...values:unknown[])=>{total+=100+values.length;};return 1;}
    host.report?.(replace());
    if(total!==38||original===host.report)throw new Error('selected callback before arguments');
    host.report?.(true);
    if(total!==139)throw new Error('replacement callback');
    delete host.report;
    host.report?.(argument());
    if(evaluations!==1)throw new Error('deleted rest callback');
    interface Item {value:number;}
    interface Sink {accept?:(...items:unknown[])=>void;}
    const sinks:Sink[]=[{}];
    sinks[0]!.accept=(...items:unknown[])=>{const first=items[0] as Item;first.value++;};
    const item={value:4};
    sinks[0]!.accept?.(item);
    if(item.value!==5)throw new Error('rest object identity');
`,
);

check(
    "owned-unmapped-arguments",
    `
    const snapshots:Array<()=>number>=[];
    function capture(...rest:number[]):void {
        const object=arguments;
        if(object!==arguments||Array.isArray(object)||typeof object!=='object')throw new Error('arguments identity and kind');
        snapshots.push(()=>Number(object[0]??0)+object.length);
        rest[0]=99;
        if(arguments!==object)throw new Error('stable arguments');
    }
    capture(3,4);
    const source=[7,8,9];capture(...source);source[0]=20;
    if(snapshots[0]!()!==5||snapshots[1]!()!==10)throw new Error('owned arguments snapshot');
    interface Host{report?:(...values:unknown[])=>void;}
    const hosts:Host[]=[{}];
    hosts[0]!.report=function(...values:unknown[]):void {
        const object=arguments;
        snapshots.push(()=>object.length);
        values[0]=false;
    };
    hosts[0]!.report?.(true,'word');
    hosts[0]!.report?.(false);
    if(snapshots[2]!()!==2||snapshots[3]!()!==1)throw new Error('stored arguments lifetime');
    interface Item{value:number;}
    function captureItem(...rest:unknown[]):void {
        const first=arguments[0] as Item;
        snapshots.push(()=>first.value);
    }
    const item={value:4};captureItem(item);item.value=9;
    if(snapshots[4]!()!==9)throw new Error('argument object alias');
    function outside(...rest:number[]):void {
        function inside(...nested:number[]):void {snapshots.push(()=>Number(arguments[0]??0));}
        inside(8);
        snapshots.push(()=>Number(arguments[0]??0));
    }
    outside(6);
    if(snapshots[5]!()!==8||snapshots[6]!()!==6)throw new Error('lexical arguments owner');
    let prefixCalls=0;
    function nextPrefix():number {prefixCalls++;return prefixCalls;}
    function prefixed(first:number,...rest:number[]):void {
        if(first!==arguments[0]||rest[0]!==arguments[1]||arguments.length!==2)
            throw new Error('prefix and rest argument order');
        snapshots.push(()=>Number(arguments[0]??0));
    }
    prefixed(nextPrefix(),nextPrefix());
    if(prefixCalls!==2||snapshots[7]!()!==1)throw new Error('prefix evaluation once');
`,
);

check(
    "arguments-enum-record-lanes",
    `
    const reads:Array<()=>number>=[];
    function capture(...items:unknown[]):void {
        reads.push(()=>arguments.length);
    }
    const update=(value:'on'|'off'):void=>capture('policy','update',{value,label:'off'});
    capture('policy','initial',{value:'off',label:'off'});
    update('on');
    if(reads[0]!()!==3||reads[1]!()!==3)throw new Error('typed Arguments record lanes');
`,
);

check(
    "arguments-prefix-object-alias",
    `
    interface Item {value:number;}
    const saved:Array<()=>number>=[];
    function capture(first:Item,...rest:unknown[]):void {
        const received=arguments[0] as Item|undefined;
        if(!received)throw new Error('missing prefix');
        if(first!==received)throw new Error('prefix object identity');
        first.value++;
        if(received.value!==3)throw new Error('prefix mutation visible in arguments');
        received.value++;
        if(first.value!==4)throw new Error('arguments mutation visible in prefix');
        saved.push(()=>first.value+received.value+rest.length);
    }
    capture({value:2},'tail');
    if(saved[0]!()!==9)throw new Error('prefix alias lifetime');
    function objects(first:Item,...rest:Item[]):void {
        const firstArgument=arguments[0] as Item;
        const lastArgument=arguments[1] as Item;
        if(first!==firstArgument||rest[0]!==lastArgument)throw new Error('required and rest record identity');
        rest[0]!.value=8;
        if(lastArgument.value!==8)throw new Error('rest object mutation');
        rest[0]={value:9};
        if(lastArgument.value!==8||rest[0]===lastArgument)throw new Error('independent rest array slot');
    }
    objects({value:3},{value:4});
`,
);

test("Arguments object unsupported mutations and unconstrained storage refuse explicitly", () => {
    for (const mutation of [
        "arguments[0]=3;",
        "arguments.length=0;",
        "arguments.callee;",
    ])
        assert.throws(
            () =>
                compileSource(
                    `function capture(...rest:number[]):void{${mutation}}capture(1);`,
                ),
            /arguments/i,
        );
    assert.throws(
        () =>
            compileSource(
                `document.createElement("div");type Host=Window & {queue?:unknown[]};const host=window as Host;host.queue??=[];globalThis.close();`,
            ),
        /Window logical assignment requires a represented declared property type/,
    );
});

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
});

test("stored unknown rest callbacks refuse unresolved element storage", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Host {report:(...values:unknown[])=>void;}
            const hosts:Host[]=[{report:(...values:unknown[])=>{}}];
            const values:unknown[]=[];
            hosts[0]!.report(...values);
        `),
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
        /An object literal method reading `this` requires shared native object storage/,
    );
});

test("a stored generic call keeps one signature across replays and refuses one that never converges", () => {
    const frontend = createCompilerProgram(
        `
        type Twin = { h: number };
        function count(raw: unknown): number { return raw === undefined ? 0 : 1; }
        count({ h: 1 });
        `,
        resolve("stored-generic-convergence.ts"),
    );
    const { checker, sourceFile } = frontend;
    const [twin, count, statement] = sourceFile.statements;
    assert.ok(twin && ts.isTypeAliasDeclaration(twin));
    assert.ok(count && ts.isFunctionDeclaration(count) && count.name);
    assert.ok(
        statement &&
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression),
    );
    const call = statement.expression;
    const functionType = checker.getTypeAtLocation(count.name);
    const replay = (storage: GenericFunctionStorage) => {
        const registry = new DataTypeRegistry(
            checker,
            (_node, message) => {
                throw new Error(message);
            },
            new ClassHierarchy(checker, frontend.program),
            false,
            storage,
        );
        const stored = registry.fromStoredTsType(functionType, count);
        assert.ok(stored?.kind === "function" && stored.generic);
        const name = stored.generic;
        return () => registry.genericFunctionCall(name, call, () => false);
    };
    const demand = (storage: GenericFunctionStorage) => {
        try {
            replay(storage)();
        } catch (error) {
            if (error instanceof GenericFunctionStorageRequired)
                return error.demand;
            throw error;
        }
        assert.fail("an unrepresented signature demands storage");
    };
    // The checker types an object literal afresh at every request; each
    // replay must still reach the signature the previous one stored.
    const converging = new GenericFunctionStorage();
    assert.ok(converging.add(demand(converging)));
    assert.equal(replay(converging)().name, "call_0");
    assert.equal(replay(converging)().name, "call_0");
    // A site whose stored signature differs only by type identity would
    // demand another signature at every replay.
    const diverging = new GenericFunctionStorage();
    const first = demand(diverging);
    diverging.add({
        ...first,
        parameters: [checker.getTypeAtLocation(twin.name)],
    });
    assert.throws(
        replay(diverging),
        /Stored generic function instantiation does not converge: this call's argument types change identity at every emission\./,
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
