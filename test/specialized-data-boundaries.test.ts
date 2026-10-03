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
            `specialized-data-boundaries/${name}`,
            compiled.cpp,
        );
    });
}

check(
    "optional-spread-mapping",
    `
    interface Item { seq?: number; label: string; cell: {value:number}; }
    function adopt(items: readonly Item[], next: number): {ops:(Item & {seq:number})[];next:number} {
        const ops = items.map(item => {
            const seq = item.seq ?? next;
            next = Math.max(next, seq + 1);
            return {...item, seq};
        });
        return {ops, next};
    }
    const cell = {value:3};
    const inputs:Item[] = [{label:'first',cell}, {seq:0,label:'second',cell}];
    const result = adopt(inputs, 4);
    if(result.next !== 5 || result.ops[0]!.seq !== 4 || result.ops[1]!.seq !== 0)
        throw new Error('optional overwrite');
    if(result.ops[0]!.cell !== cell || result.ops[1]!.label !== 'second' || result.ops[0] === inputs[0])
        throw new Error('spread identity');
    if('seq' in inputs[0]! || !('seq' in result.ops[0]!)) throw new Error('own keys');
`,
);

check(
    "absent-record-destructuring",
    `
    interface Options { required:number; optional?:number; empty:number|null; }
    let defaults = 0;
    function fallback():number {defaults++; return 9;}
    function read({required,optional:renamed,empty=fallback()}:Options):number {
        if(renamed !== undefined || empty !== null) throw new Error('absent versus null');
        return required;
    }
    if(read({required:2,empty:null}) !== 2 || defaults !== 0) throw new Error('binding effects');
    function withDefault({optional=fallback()}: {optional?:number}):number {return optional;}
    if(withDefault({}) !== 9 || withDefault({optional:0}) !== 0 || defaults !== 1)
        throw new Error('missing default');
`,
);

check(
    "specialized-scalar-equality",
    `
    let trace = '';
    function flag():boolean {trace += 'b'; return true;}
    function classify(value:unknown):number {
        if(value === flag()) return 1;
        if(value === false) return 2;
        if(value === 3) return 3;
        if(value === 'word') return 4;
        return 0;
    }
    if(classify('invalid') !== 0 || classify(true) !== 1 || classify(false) !== 2 ||
       classify(3) !== 3 || classify('word') !== 4 || trace !== 'bbbbb')
       throw new Error('strict specialized equality or effects');
    function differs(value:unknown):boolean { return 1 !== value; }
    if(!differs('1') || differs(1)) throw new Error('reversed strict inequality');
`,
);

check(
    "set-constructor-spreads",
    `
    type Kind = 'north' | 'south' | 'east' | 'west';
    type Axis = 'north' | 'south';
    const axes = new Set<Axis>(['north','south']);
    let trace = '';
    function extra():Kind { trace += 'e'; axes.add('north'); return 'east'; }
    const values = new Set<Kind>([...axes, extra(), 'west', ...axes]);
    let order = '';
    for (const value of values) order += value + ',';
    if(values.size !== 4 || order !== 'north,south,east,west,' || trace !== 'e')
        throw new Error('spread widening or order');
    const cell = {value:1};
    const records = new Set<{value:number}>([...[cell], cell]);
    if(records.size !== 1 || !records.has(cell)) throw new Error('reference identity');
    let counter = 0;
    function mutate():number {counter++; return counter;}
    const ordered = new Set<number>([counter, mutate(), counter]);
    let numbers = '';
    for (const value of ordered) numbers += value + ',';
    if(numbers !== '0,1,') throw new Error('literal evaluation order');
`,
);
