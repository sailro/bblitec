import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import { GenericFunctionStorageRequired } from "../src/compiler/generic-function-storage.js";
import { ReplayStorage } from "../src/compiler/replay-storage.js";
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
                flags: realm ? ["/DBBLITE_WORKERS=1"] : [],
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

// A gesture holding adapters of several state types as `Active<unknown>`
// calls their methods with values it holds as `unknown`; each call returns
// what the receiver's type arguments make of the declared result.
check(
    "erased-adapter-state",
    `
    interface Candidate<S> { readonly state: S; readonly finite: boolean }
    interface Adapter<S> { current(): Candidate<S>; resolve(previous: Candidate<S>): Candidate<S> | null; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Active<S> { readonly adapter: Adapter<S>; readonly initial: Candidate<S>; rejected: S | null }
    let active: Active<unknown> | null = null;
    function begin<S>(adapter: Adapter<S>): void { active = { adapter, initial: adapter.current(), rejected: null }; }
    function step(): boolean {
        const gesture = active;
        if (!gesture) return false;
        const next = gesture.adapter.resolve(gesture.initial);
        if (!next || !next.finite) {
            if (next) gesture.rejected = gesture.adapter.cloneState(next.state);
            return false;
        }
        return !gesture.adapter.statesEqual(gesture.initial.state, next.state);
    }
    interface House { x: number }
    interface Tower { h: number; name: string }
    const house: House = { x: 1 };
    begin<House>({ current: () => ({ state: house, finite: true }), resolve: (p) => ({ state: { x: p.state.x + 1 }, finite: p.state.x < 1 }), cloneState: (s) => ({ ...s }), statesEqual: (a, b) => a.x === b.x });
    if (step()) throw new Error("house moved");
    const rejected = active!.rejected as House;
    if (rejected.x !== 2 || house.x !== 1) throw new Error("house clone " + rejected.x);
    begin<Tower>({ current: () => ({ state: { h: 2, name: "t" }, finite: true }), resolve: (p) => ({ state: { h: 3, name: p.state.name }, finite: true }), cloneState: (s) => ({ ...s }), statesEqual: (a, b) => a.h === b.h && a.name === b.name });
    if (!step()) throw new Error("tower moved");
`,
);

// A value held as `unknown` stays that erased value where a test narrowed it:
// TypeScript types it `{}` past a test for `null`, `undefined` or truthiness.
check(
    "erased-adapter-narrowed-state",
    `
    interface Adapter<S> { current(): S; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Active<S> { readonly adapter: Adapter<S>; readonly initial: S; rejected: S | null; accepted?: S }
    let active: Active<unknown> | null = null;
    function begin<S>(adapter: Adapter<S>): void { active = { adapter, initial: adapter.current(), rejected: null }; }
    function reject(): void {
        const gesture = active!;
        gesture.rejected = gesture.adapter.cloneState(gesture.initial);
    }
    function audit(): { rejected: unknown; accepted: unknown; same: boolean } | null {
        const gesture = active;
        if (!gesture) return null;
        return {
            rejected: gesture.rejected === null ? null : gesture.adapter.cloneState(gesture.rejected),
            accepted: gesture.accepted !== undefined ? gesture.adapter.cloneState(gesture.accepted) : null,
            same: gesture.rejected ? gesture.adapter.statesEqual(gesture.rejected, gesture.initial) : false,
        };
    }
    interface House { x: number }
    interface Tower { h: number; name: string }
    begin<House>({ current: () => ({ x: 1 }), cloneState: (s) => ({ ...s }), statesEqual: (a, b) => a.x === b.x });
    const before = audit()!;
    if (before.rejected !== null || before.accepted !== null || before.same) throw new Error("nothing rejected yet");
    reject();
    const house = audit()!;
    if ((house.rejected as House).x !== 1 || !house.same) throw new Error("house rejection");
    begin<Tower>({ current: () => ({ h: 2, name: "t" }), cloneState: (s) => ({ ...s }), statesEqual: (a, b) => a.h === b.h && a.name === b.name });
    active!.accepted = active!.adapter.cloneState(active!.initial);
    const tower = audit()!;
    if (tower.rejected !== null || (tower.accepted as Tower).name !== "t" || tower.same) throw new Error("tower acceptance");
`,
);

// Adapters a generic factory builds, held as `Adapter<unknown>`, are the
// objects the factory keyed: the candidates they hand out come back to them
// through the erased adapter as the same objects, and so do their states.
check(
    "erased-adapter-candidate-identity",
    `
    interface Candidate<S> { readonly state: S; readonly finite: boolean }
    interface Adapter<S> { current(): Candidate<S>; resolve(previous: Candidate<S>): Candidate<S> | null; commit(candidate: Candidate<S>): void; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Active<S> { readonly adapter: Adapter<S>; readonly initial: Candidate<S>; last: Candidate<S>; rejected: S | null }
    let active: Active<unknown> | null = null;
    function begin<S>(adapter: Adapter<S>): void { const initial = adapter.current(); active = { adapter, initial, last: initial, rejected: null }; }
    function step(): boolean {
        const gesture = active;
        if (!gesture) return false;
        const next = gesture.adapter.resolve(gesture.last);
        if (!next || !next.finite) {
            if (next) gesture.rejected = gesture.adapter.cloneState(next.state);
            return false;
        }
        if (gesture.adapter.statesEqual(gesture.last.state, next.state)) return false;
        gesture.adapter.commit(next);
        gesture.last = next;
        return true;
    }
    function createAdapter<S>(initial: S, move: (state: S) => S, apply: (state: S) => void, clone: (state: S) => S, equal: (a: S, b: S) => boolean): Adapter<S> {
        const known = new WeakMap<object, S>();
        const make = (state: S, finite: boolean): Candidate<S> => { const candidate: Candidate<S> = { state, finite }; known.set(candidate, state); return candidate; };
        let moves = 0;
        return {
            current: () => make(initial, true),
            resolve: (previous) => { const state = known.get(previous); if (state === undefined || state !== previous.state) throw new Error("unknown previous"); return make(move(state), ++moves < 3); },
            commit: (candidate) => { const state = known.get(candidate); if (state === undefined) throw new Error("unknown candidate"); apply(state); },
            cloneState: clone,
            statesEqual: equal,
        };
    }
    interface House { x: number }
    interface Tower { h: number; name: string }
    let house: House = { x: 1 };
    const first = house;
    let tower: Tower = { h: 2, name: "t" };
    begin(createAdapter<House>(house, (s) => ({ x: s.x + 1 }), (s) => { house = s; }, (s) => ({ ...s }), (a, b) => a.x === b.x));
    if (active!.initial.state !== first || active!.last !== active!.initial) throw new Error("house initial");
    if (!step() || !step() || house.x !== 3 || active!.last.state !== house) throw new Error("house " + house.x);
    if (step() || (active!.rejected as House).x !== 4 || active!.rejected === house) throw new Error("house rejection");
    begin(createAdapter<Tower>(tower, (s) => ({ h: s.h * 2, name: s.name + "!" }), (s) => { tower = s; }, (s) => ({ ...s }), (a, b) => a.h === b.h && a.name === b.name));
    if (!step() || tower.h !== 4 || tower.name !== "t!" || active!.last.state !== tower) throw new Error("tower " + tower.h);
`,
);

// So are adapters whose generic methods are functions an options record
// stores: each is called through the erased adapter's table.
check(
    "erased-adapter-stored-functions",
    `
    interface Candidate<S> { readonly state: S; readonly score: number }
    interface Adapter<S> { readonly id: number; current(): Candidate<S>; commit(candidate: Candidate<S>): void; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Options<S> { readonly id: number; read(): S; write(state: S): void; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Active<S> { readonly adapter: Adapter<S>; readonly initial: Candidate<S>; saved: S | null }
    let active: Active<unknown> | null = null;
    const begun: Adapter<unknown>[] = [];
    function begin<S>(adapter: Adapter<S>): void { active = { adapter, initial: adapter.current(), saved: null }; begun.push(adapter); }
    function createAdapter<S>(options: Options<S>): Adapter<S> {
        const known = new WeakMap<object, S>();
        return {
            id: options.id,
            current: () => { const candidate: Candidate<S> = { state: options.read(), score: options.id }; known.set(candidate, candidate.state); return candidate; },
            commit: (candidate) => { const state = known.get(candidate); if (state === undefined) throw new Error("unknown candidate"); options.write(options.cloneState(state)); },
            cloneState: options.cloneState,
            statesEqual: options.statesEqual,
        };
    }
    interface House { f: number }
    interface Tower { a: number; name: string }
    let house: House = { f: 1 };
    let tower: Tower = { a: 2, name: "t" };
    const houseOptions: Options<House> = { id: 7, read: () => house, write: (state) => { house = state; }, cloneState: (state) => ({ ...state }), statesEqual: (a, b) => a.f === b.f };
    const towerOptions: Options<Tower> = { id: 9, read: () => tower, write: (state) => { tower = state; }, cloneState: (state) => ({ ...state, name: state.name }), statesEqual: (a, b) => a.a === b.a && a.name === b.name };
    const options: Options<House>[] = [houseOptions, { ...houseOptions, id: 8 }];
    begin(createAdapter(options[Math.random() > 2 ? 1 : 0]!));
    const gesture = active!;
    gesture.saved = gesture.adapter.cloneState(gesture.initial.state);
    if (gesture.saved === gesture.initial.state || !gesture.adapter.statesEqual(gesture.saved, gesture.initial.state)) throw new Error("house clone");
    gesture.adapter.commit(gesture.initial);
    if (house.f !== 1 || house === gesture.initial.state || gesture.adapter.id !== 7) throw new Error("house commit");
    begin(createAdapter(towerOptions));
    active!.adapter.commit(active!.initial);
    if (tower.name !== "t" || begun.length !== 2 || begun[0] === begun[1] || begun[1] !== active!.adapter) throw new Error("tower commit");
`,
);

// So is an adapter a binding holds at its concrete type, which the program
// also calls there.
check(
    "erased-adapter-concrete-binding",
    `
    interface Candidate<S> { readonly state: S; readonly score: number }
    interface Adapter<S> { readonly id: number; current(): Candidate<S>; commit(candidate: Candidate<S>): void; cloneState(state: S): S; statesEqual(a: S, b: S): boolean }
    interface Active<S> { readonly adapter: Adapter<S>; readonly initial: Candidate<S> }
    let active: Active<unknown> | null = null;
    function begin<S>(adapter: Adapter<S>): void { active = { adapter, initial: adapter.current() }; }
    function createAdapter<S>(id: number, read: () => S, write: (state: S) => void, clone: (state: S) => S, equal: (a: S, b: S) => boolean): Adapter<S> {
        const known = new WeakMap<object, S>();
        return {
            id,
            current: () => { const candidate: Candidate<S> = { state: read(), score: id }; known.set(candidate, candidate.state); return candidate; },
            commit: (candidate) => { const state = known.get(candidate); if (state === undefined) throw new Error("unknown candidate"); write(clone(state)); },
            cloneState: clone,
            statesEqual: equal,
        };
    }
    interface House { f: number }
    interface Tower { a: number; name: string }
    let house: House = { f: 1 };
    let tower: Tower = { a: 2, name: "t" };
    const houseAdapter: Adapter<House> = createAdapter<House>(7, () => house, (state) => { house = state; }, (state) => ({ ...state }), (a, b) => a.f === b.f);
    begin(houseAdapter);
    const copy = houseAdapter.cloneState(house);
    if (copy === house || copy.f !== 1 || !houseAdapter.statesEqual(copy, house)) throw new Error("house adapter clone");
    if (active!.adapter !== houseAdapter || active!.initial.state !== house) throw new Error("house begin");
    active!.adapter.commit(active!.initial);
    if (house.f !== 1 || house === active!.initial.state || !active!.adapter.statesEqual(house, active!.initial.state)) throw new Error("house commit");
    const towerAdapter: Adapter<Tower> = createAdapter<Tower>(9, () => tower, (state) => { tower = state; }, (state) => ({ ...state }), (a, b) => a.a === b.a && a.name === b.name);
    begin(towerAdapter);
    active!.adapter.commit(active!.initial);
    if (active!.adapter !== towerAdapter || tower.name !== "t" || tower === active!.initial.state) throw new Error("tower commit");
`,
);

// A stored generic method takes adapters whose optional method returns
// `unknown`: each instantiation's parameter is the record each adapter is
// stored as, that result a dynamic value.
check(
    "stored-generic-unknown-member-parameter",
    `
    interface Candidate<S> { readonly state: S; readonly score: number }
    interface Adapter<S> { readonly stableId: number; current(): Candidate<S>; companion?(stableId: number): unknown; cloneState(state: S): S }
    interface Controller { begin<S>(adapter: Adapter<S>): boolean; begun(): number }
    function createController(limit: number): Controller {
        let begun = 0;
        return {
            begin<S>(adapter: Adapter<S>): boolean {
                const initial = adapter.current();
                if (initial.score > limit) return false;
                begun += adapter.stableId;
                return adapter.companion?.(adapter.stableId) === undefined && adapter.cloneState(initial.state) !== initial.state;
            },
            begun: () => begun,
        };
    }
    function createAdapter<S>(stableId: number, state: () => S, clone: (state: S) => S): Adapter<S> {
        return { stableId, current: () => ({ state: state(), score: stableId }), companion: (id) => (id === stableId ? undefined : { id }), cloneState: clone };
    }
    interface House { f: number }
    interface Tower { a: number; name: string }
    const house: House = { f: 1 };
    const tower: Tower = { a: 2, name: "t" };
    const controllers = [createController(8), createController(10)];
    const controller = controllers[Math.random() > 2 ? 0 : 1]!;
    if (!controller.begin(createAdapter<House>(7, () => house, (state) => ({ ...state })))) throw new Error("house begin");
    if (!controller.begin(createAdapter<Tower>(9, () => tower, (state) => ({ ...state })))) throw new Error("tower begin");
    if (controller.begin(createAdapter<House>(11, () => house, (state) => state))) throw new Error("house over limit");
    if (controller.begun() !== 16) throw new Error("begun " + controller.begun());
`,
);

// So does a stored method declared for one state type.
check(
    "stored-unknown-member-parameter",
    `
    interface Adapter<S> { readonly stableId: number; current(): S; companion?(stableId: number): unknown }
    interface Controller { readonly limit: number; measure(adapter: Adapter<House>): number }
    function createController(limit: number): Controller {
        return { limit, measure: (adapter) => adapter.stableId * limit + adapter.current().f + (adapter.companion?.(0) === undefined ? 0 : 1) };
    }
    function createAdapter<S>(stableId: number, state: () => S): Adapter<S> {
        return { stableId, current: state, companion: (id) => (id === stableId ? undefined : { id }) };
    }
    interface House { f: number }
    const controllers = [createController(8), createController(10)];
    const controller = controllers[Math.random() > 2 ? 0 : 1]!;
    const measured = controller.measure(createAdapter<House>(7, () => ({ f: 2 })));
    if (measured !== 73) throw new Error("measure " + measured);
`,
);

check(
    "omitted-rest-under-instantiation",
    `
    interface Token { readonly key: number }
    function attach<T extends object>(row: T, id: Token): T & { readonly id: Token } {
        const item = { ...row } as T & { readonly id: Token };
        Object.defineProperty(item, "id", { value: id, enumerable: true, writable: false, configurable: false });
        return item;
    }
    function strip<T extends { readonly id: Token }>(row: T): Omit<T, "id"> {
        const { id: _id, ...rest } = row;
        return rest;
    }
    function cloneRows<T extends { readonly id: Token }>(
        input: readonly T[],
        clone: (row: Omit<T, "id">) => Omit<T, "id">,
    ): Array<Omit<T, "id"> & { readonly id: Token }> {
        const items: Array<Omit<T, "id"> & { readonly id: Token }> = [];
        let key = 10;
        for (const row of input) {
            const { id: _sourceId, ...withoutId } = row;
            items.push(attach(clone(withoutId), { key: key++ }));
        }
        return items;
    }
    const slit = attach({ tower: 2, height: 1.5 }, { key: 1 });
    const stripped = strip(slit);
    if (stripped.tower !== 2 || stripped.height !== 1.5 || Object.keys(stripped).join() !== "tower,height")
        throw new Error("omitted rest");
    const other = strip(attach({ side: -1 }, { key: 2 }));
    if (other.side !== -1 || Object.keys(other).join() !== "side") throw new Error("second instantiation");
    const clones = cloneRows([slit, attach({ tower: 3, height: 0.5 }, { key: 3 })], (row) => ({ ...row, tower: row.tower + 5 }));
    if (clones.length !== 2 || clones[0]!.tower !== 7 || clones[1]!.height !== 0.5 || clones[1]!.id.key !== 11 ||
        Object.keys(clones[0]!).join() !== "tower,height,id")
        throw new Error("cloned rows");
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
    const replay = (storage: ReplayStorage) => {
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
    const demand = (storage: ReplayStorage) => {
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
    const converging = new ReplayStorage(checker);
    assert.ok(converging.add({ kind: "generic", demand: demand(converging) }));
    assert.equal(replay(converging)().name, "call_0");
    assert.equal(replay(converging)().name, "call_0");
    // A site whose stored signature differs only by type identity would
    // demand another signature at every replay.
    const diverging = new ReplayStorage(checker);
    const first = demand(diverging);
    diverging.add({
        kind: "generic",
        demand: {
            ...first,
            parameters: [checker.getTypeAtLocation(twin.name)],
        },
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
