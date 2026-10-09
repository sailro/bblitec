import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        const fileName = resolve("callable-structural-views.ts");
        const { program } = createCompilerProgram(source, fileName);
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(
                        diagnostic.messageText,
                        " ",
                    ),
                ),
            [],
        );
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const { cpp } = compileSource(source, { fileName });
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(native, `callable-structural-views/${name}`, cpp);
    });
}

test("callable property cells distinguish initialization, stores and deletion", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "callable-structural-views/property-cells",
        `
        #include <bblite/js_accessor.hpp>
        #include <cassert>
        #include <optional>
        #include <string>
        int main() {
            using Number = bbl::js::ReceiverAccessor<std::optional<double>, double>;
            Number absent;
            Number supplied(std::nullopt);
            assert(!absent.has_own() && supplied.has_own());
            absent.set(std::nullopt);
            assert(absent.has_own() && !absent.get());
            assert(absent.erase() && !absent.has_own());
            absent.set(0.0);
            assert(absent.has_own() && absent.get() == 0.0);
            assert(absent.define_value(std::nullopt));
            assert(absent.has_own());
            assert(absent.try_define(Number{}, true, false, 0.0));
            assert(absent.has_own());
            bbl::js::ReceiverAccessor<bool, double> boolean(false);
            bbl::js::ReceiverAccessor<std::string, double> string(std::string{});
            assert(boolean.has_own() && string.has_own());
            using Function = bbl::js::ReceiverAccessor<bbl::js::Callback<void()>, double>;
            Function missing;
            Function own(bbl::js::Callback<void()>{});
            assert(!missing.has_own() && own.has_own());
            missing.set({});
            assert(missing.has_own());
            assert(missing.erase() && !missing.has_own());
            bool present = false;
            Number custom({}, {}, bbl::js::Callback<bool()>([&] {return present;}));
            custom.set(1.0);
            assert(!custom.has_own());
            present = true;
            assert(custom.has_own());
        }
    `,
    );
});

check(
    "bare-callable-views-share-properties-and-live-captures",
    `
    type Source = (() => number) & {notify?: () => void};
    let count = 1;
    let calls = 0;
    const base:()=>number = () => count;
    const alias:()=>number = base;
    const first:Source = alias;
    const second:Source = base;
    if(first!==second || first!==base || Object.hasOwn(first,'notify')) throw new Error('initial identity');
    first.notify = () => {calls++;};
    second.notify?.();
    if(!Object.hasOwn(second,'notify') || calls!==1) throw new Error('later properties');
    delete second.notify;
    first.notify?.();
    if(Object.hasOwn(first,'notify') || calls!==1) throw new Error('deleted property');
    count=4;
    const callbacks:Array<()=>number>=[first,second];
    if(callbacks[0]!==base || callbacks[1]!()!==4 || first()!==4) throw new Error('call identity');
`,
);

check(
    "callable-own-undefined-and-falsy-accessor-initializers",
    `
    type Source=(()=>number)&{notify?: (()=>void)|undefined;value?:number|undefined};
    const base=()=>4;const source:Source=base;const alias:Source=base;
    if(Object.hasOwn(source,'notify')||Object.hasOwn(source,'value'))throw new Error('initial fields');
    source.notify=undefined;
    source.value=undefined;
    if(!Object.hasOwn(alias,'notify')||!Object.hasOwn(alias,'value')||alias.notify!==undefined||alias.value!==undefined)
        throw new Error('own undefined');
    function notify(value:Source):void{value.notify?.();}
    let calls=0;source.notify=()=>{calls++;};notify(alias);
    delete alias.notify;
    if(Object.hasOwn(source,'notify')||calls!==1||source()!==4)throw new Error('delete');
    Object.assign(alias,{notify:undefined});
    if(!Object.hasOwn(source,'notify')||source.notify!==undefined)throw new Error('assign undefined');
    const initialized:Source=Object.assign(()=>5,{notify:undefined,value:0});
    if(!Object.hasOwn(initialized,'notify')||!Object.hasOwn(initialized,'value')||initialized.value!==0)
        throw new Error('explicit undefined constructor');
    interface State {count?:number;flag?:boolean;text?:string;missing?:number;notify?: (()=>void)|undefined}
    const state:State={count:0,flag:false,text:'',notify:undefined};
    const view=new Proxy(state,{});
    if(!Object.hasOwn(view,'count')||!Object.hasOwn(view,'flag')||!Object.hasOwn(view,'text')||
       !Object.hasOwn(view,'notify')||Object.hasOwn(view,'missing'))throw new Error('falsy initial properties');
    if(view.count!==0||view.flag!==false||view.text!==''||view.notify!==undefined)throw new Error('initial values');
`,
);

check(
    "callable-results-and-array-elements-retain-their-object",
    `
    type Source<T> = (() => T) & {onResize?: (callback: () => void) => () => void};
    let count = 1;
    function make():Source<number> {return ()=>count;}
    function nested():{read:Source<number>} {return {read:()=>count+1};}
    function read(source:Source<number>):number {return source();}
    const readers:Array<typeof read>=[read];
    const source=make();
    const rows:Array<Source<number>>=[source,()=>count+2,Object.assign(()=>count+3,{
        onResize:(callback:()=>void)=>{callback(); return ()=>{count++;};},
    })];
    const record=nested();
    if(rows[0]!==source || readers[0]!(rows[1]!)!==3 || record.read()!==2) throw new Error('stored calls');
    let notified=0;
    const stop=rows[2]!.onResize?.(()=>{notified++;});
    stop?.();
    if(notified!==1 || rows[0]!()!==2 || record.read()!==3 || rows[2]!()!==5) throw new Error('returned closure');
`,
);

check(
    "generic-callable-results-retain-concrete-record-payloads",
    `
    type Source<T> = (()=>T)&{notify?:()=>void};
    function make<T>(value:T):Source<T>{return ()=>value;}
    const first=make({count:1});const second=make({count:2});
    const list:Source<{count:number}>[]=[first,second];
    const held=first();held.count=8;
    let calls=0;list[0]!.notify=()=>{calls++;};first.notify?.();
    if(list[0]!()!==held||list[0]!==first||list[1]!().count!==2||first().count!==8||calls!==1)
        throw new Error('generic callable identity');
`,
);

check(
    "assign-keeps-one-callable-target-before-source-arguments",
    `
    const base=()=>3;
    const first=Object.assign(base,{count:1,extra:0});
    let trace='';
    const original={count:2};
    function later():{extra:number} {trace+='A'; original.count=4; return {extra:5};}
    const second=Object.assign(base,original,later());
    if(first!==second || first!==base || first.count!==4 || first.extra!==5 || trace!=='A') throw new Error('assign shared target');
    second.count=7;
    if(Number(first.count)!==7 || first()!==3 || second()!==3) throw new Error('later assignment');
`,
);

test("callable views refuse invented properties and unowned stored callbacks", () => {
    assert.throws(
        () =>
            compileSource(`
        type Required=(()=>number)&{count:number};
        const value:Required=(()=>3) as Required;
        if(value.count!==1) throw new Error('missing');
    `),
        /bare callback does not supply|original lexical function owner|expected data/,
    );
    assert.throws(
        () =>
            compileSource(`
        type Source=(()=>number)&{notify?:()=>void};
        function adapt(value:()=>number):Source{return value;}
        const adapters:Array<typeof adapt>=[adapt];
        const value=adapters[0]!(()=>3);
        if(value()!==3) throw new Error('unowned');
    `),
        /original lexical function owner|demanded callable record/,
    );
    assert.throws(
        () =>
            compileSource(`
        type Counter=(()=>number)&{count:number;increment():void};
        const value:Counter=Object.assign(()=>3,{count:1,increment(){this.count++;}});
        value.increment();
    `),
        /methods without.*this|receiver/,
    );
});

test("callable reflection refuses unrepresented key order and intrinsic metadata", () => {
    assert.throws(
        () =>
            compileSource(`
        type Source=(()=>number)&{left?:number;right?:number};
        const source:Source=()=>3;
        source.right=2;source.left=1;
        if(Object.keys(source).join(',')!=='right,left')throw new Error('key order');
    `),
        /callable properties requires their runtime insertion order/,
    );
    assert.throws(
        () =>
            compileSource(`
        type Source=(()=>number)&{notify?:()=>void};
        const source:Source=()=>3;
        if(!Object.hasOwn(source,'name'))throw new Error('function name');
    `),
        /Function intrinsic property membership/,
    );
    assert.throws(
        () =>
            compileSource(`
        type Source=(()=>number)&{name?:string};
        const source:Source=()=>3;
        if(source.name===undefined)throw new Error('function name');
    `),
        /Callable intrinsic properties/,
    );
});
