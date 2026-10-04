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
        const compiled = compileSource(source);
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `contextual-object-spread/${name}`,
            compiled.cpp,
        );
    });
}

check(
    "contextual spread retains wider static fields and shared children",
    `
    interface Narrow { value:number; optional?:number; }
    interface Wide extends Narrow { extra:number; child:{value:number}; }
    function inspect(value:Narrow):number {
        return Object.keys(value).length + value.value;
    }
    function copy(source:Wide):number {
        const result = {...source, value:5};
        result.child.value = 8;
        result.value = 11;
        if(source.child !== result.child || source.value !== 2)
            throw new Error('spread identity');
        return inspect({...source, value:5});
    }
    const child = {value:1};
    if(copy({value:2,extra:3,child}) !== 8 || child.value !== 8)
        throw new Error('contextual own keys');
`,
);

test("fixed spread storage refuses loss of additional owned fields", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Narrow { value:number; }
            interface Wide extends Narrow { extra:number; }
            const sources:Wide[]=[{value:1,extra:2}];
            const targets:{item:Narrow}[]=[{item:{value:0}}];
            targets[0]!.item={...sources[0]!};
            if(Object.keys(targets[0]!.item).length!==2) throw new Error('lost key');
        `),
        /Spread property 'extra' cannot be retained in the narrower 'Narrow' storage/,
    );
});

check(
    "contextual spreads evaluate extra getters once before later overrides",
    `
    interface Narrow { value:number; }
    let trace = '';
    let reads = 0;
    let current = 2;
    function advance():number {trace += 'a'; current=9; return 5;}
    function inspect(value:Narrow):number {
        return Object.keys(value).length * 10 + value.value;
    }
    const source = {
        get extra():number {trace += 'g'; reads++; return current;},
        get value():number {trace += 'v'; return current+1;},
    };
    const result = {...source, value:advance()};
    if(result.extra !== 2 || result.extra !== 2 || result.value !== 5 ||
       reads !== 1 || trace !== 'gva') throw new Error('getter snapshot');
    trace = '';
    if(inspect({...source, value:advance()}) !== 25 || reads !== 2 || trace !== 'gva')
        throw new Error('narrowed getter effects');
    trace = '';
    const integerKeys = {
        get 2():number {trace += '2'; return 2;},
        get 1():number {trace += '1'; return 1;},
    };
    const ordered = {...integerKeys};
    if(trace !== '12' || ordered[1] !== 1 || ordered[2] !== 2)
        throw new Error('integer getter order');
`,
);

check(
    "raw record aliases retain added deleted and recreated keys in spreads",
    `
    const optional:{a?:number;b?:number}={a:1};
    delete optional.a;
    optional.b=2;
    if(Object.keys({...optional}).join(',') !== 'b') throw new Error('optional keys');
    let reads=0;
    const raw:Record<string,unknown>={first:1,get later():number {reads++;return 9;}};
    const alias=raw;
    delete alias.first;
    alias.last=3;
    raw['first']=4;
    Object.assign(alias,{tail:5});
    const copied={...raw};
    if(Object.keys(copied).join(',') !== 'later,last,first,tail' || reads!==1 ||
       copied.first!==4 || copied.last!==3 || copied.tail!==5)
        throw new Error('raw key mutation');
    function tag(type:number):string {return type===1?'number':'record';}
    const value=7;
    const extra:Record<string,unknown>={type:1};
    extra.valueType=tag(1);
    extra.value=value;
    if(Object.keys({...extra}).length!==3 || extra.valueType!=='number' || extra.value!==7)
        throw new Error('scalar extra keys');
    let current=1;
    let calls=0;
    function effect(value:number):number {calls++;return value;}
    extra.snapshot=current;
    extra.unused=effect(2);
    extra['indexed']=effect(3);
    current=9;
    delete extra.unused;
    delete extra['indexed'];
    if(extra.snapshot!==1 || calls!==2) throw new Error('assigned field snapshot');
`,
);

test("raw record additions retain the runtime-control-flow refusal", () => {
    assert.throws(
        () =>
            compileSource(`
        const extra:Record<string,unknown>={type:1};
        function add(value:number|null):void {
            if(value!==null)extra.value=value;
        }
        const callbacks:Array<(value:number|null)=>void>=[add];
        callbacks[0]!(7);
    `),
        /A compile-time record cannot be populated from runtime control flow/,
    );
});

check(
    "contextual spread retains runtime optional keys and overwritten fields",
    `
    interface Narrow { value:number; optional?:number; }
    interface Wide extends Narrow { extra:number; }
    const values:Wide[] = [{value:2,extra:3}, {value:4,extra:5,optional:7}];
    function inspect(value:Narrow):number {
        return Object.keys(value).length * 10 + value.value + (value.optional ?? 0);
    }
    let result = 0;
    for(const source of values) result += inspect({...source, value:6});
    if(result !== 69 || values[0]!.value !== 2 || values[1]!.value !== 4)
        throw new Error('optional own keys');
`,
);

check(
    "contextual open record spreads retain extra keys and aliases",
    `
    interface Open { id:number; [key:string]:unknown; }
    const child = {value:1};
    function inspect(value:Open):number {
        return Object.keys(value).length;
    }
    function create(extra:Record<string,unknown>):number {
        return inspect({id:1,...extra});
    }
    if(create({kind:'plain',child}) !== 3) throw new Error('open keys');
    const list:Open[] = [];
    list.push({id:2,...{kind:'stored',child}});
    if(Object.keys(list[0]!).length !== 3 || list[0]!.child !== child)
        throw new Error('stored open keys');
`,
);
