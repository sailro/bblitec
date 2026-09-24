import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

// The generic TypeScript user-code surface: every source below runs its own
// assertions in JavaScript first, then the generated C++ must build and run
// them identically.
const native = optionalNativeFixtureTools(false);

check(
    "switch-on-temporary-string",
    `
    function classify(prefix: string, tail: string): number {
        switch (prefix + tail) {
            case "ab": return 1;
            case "abc": return 2;
            default: return 0;
        }
    }
    let total = 0;
    for (const tail of ["b", "bc", "x"]) total = total * 10 + classify("a", tail);
    if (total !== 120) throw new Error("switch on a concatenation " + total);
`,
);

check(
    "string-collection-foreach",
    `
    const names = new Set<string>(["alpha", "beta"]);
    const seen: string[] = [];
    names.forEach(name => {
        seen.push(name);
        if (name === "alpha") names.delete("beta");
    });
    if (seen.join(",") !== "alpha") throw new Error("set forEach order " + seen.join(","));
    const labels = new Map<string, string>([["a", "one"], ["b", "two"]]);
    const pairs: string[] = [];
    labels.forEach((value, key) => { pairs.push(key + "=" + value); });
    if (pairs.join(",") !== "a=one,b=two") throw new Error("map forEach " + pairs.join(","));
`,
);

check(
    "record-arrow-lexical-this",
    `
    function select(values: number[], options: {test: (value: number) => boolean}): number[] {
        function filter(test: (value: number) => boolean): number[] {
            const selected: number[] = [];
            for (const value of values) if (test(value)) selected.push(value);
            return selected;
        }
        return filter(options.test);
    }
    class Selection {
        private readonly allowed = new Set([2, 4]);
        run(): number[] {
            return select([1, 2, 3, 4], {test: value => this.allowed.has(value)});
        }
    }
    const result = new Selection().run();
    if (result.join(",") !== "2,4") throw new Error("arrow receiver");
`,
);

check(
    "constant-null-guard",
    `
    function sum(x: number, y: number): number { return x + y; }
    function select(x: number | null, y: number | null): number {
        const valid = x !== null && y !== null && x >= 0 && y >= 0;
        if (!valid) return -1;
        return sum(x, y);
    }
    if (select(null, null) !== -1 || select(2, 3) !== 5) throw new Error("guarded arithmetic");
`,
);

check(
    "callback-helper-signatures",
    `
    function accepts(callback: (value: number) => boolean): boolean { return callback(7); }
    function invokes(count: number): number {
        return accepts(() => true) ? count + 1 : count;
    }
    if (invokes(1) !== 2 || invokes(3) !== 4) throw new Error("omitted callback parameter");
`,
);

check(
    "ambient-typeof-guards",
    `
    declare const OPTIONAL_BUILD: boolean | undefined;
    declare function OPTIONAL_HOOK(): void;
    declare namespace OPTIONAL_PACKAGE { function run(): void; }
    declare class OptionalClass { value: number; }
    const enabled = typeof OPTIONAL_BUILD !== "undefined" && OPTIONAL_BUILD === true;
    if (enabled || typeof OPTIONAL_HOOK !== "undefined") throw new Error("absent ambient globals");
    if (typeof NEVER_PROVIDED !== "undefined") throw new Error("unbound typeof");
    if (typeof OPTIONAL_PACKAGE !== "undefined" || typeof OptionalClass !== "undefined") throw new Error("erased declarations");
    function kind(OPTIONAL_BUILD: number): string { return typeof OPTIONAL_BUILD; }
    if (kind(7) !== "number") throw new Error("parameter binding");
    {
        const OPTIONAL_BUILD = true;
        if (typeof OPTIONAL_BUILD !== "boolean") throw new Error("local binding");
    }
    const selected = typeof OPTIONAL_BUILD === "undefined" ? "fallback" : "provided";
    if (selected !== "fallback") throw new Error("conditional guard");
    let effects=0;
    function receiver(): {value:number} { effects++; return {value:7}; }
    if (typeof receiver().value !== "number" || effects !== 1) throw new Error("member operand evaluation");
`,
);

test("absent typeof support preserves errors for unprovided reads and imported implementations", () => {
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: boolean; const value=OPTIONAL_BUILD;",
            ),
        /Unknown or unsupported variable/,
    );
    assert.throws(
        () =>
            compileSource(
                "declare const OPTIONAL_BUILD: {value:number}; const value=typeof OPTIONAL_BUILD.value;",
            ),
        /Unknown or unsupported variable/,
    );
    const directory = resolve("artifacts/ambient-typeof-import");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "provider.ts"),
        "export declare const supplied: number;",
    );
    assert.throws(() =>
        compileSource(
            'import {supplied} from "./provider.js"; const kind=typeof supplied;',
            { fileName: join(directory, "entry.ts") },
        ),
    );
});

test("ambient availability guards settle through imported helpers", async (t) => {
    const directory = resolve("artifacts/ambient-typeof-module");
    mkdirSync(directory, { recursive: true });
    const module = `declare const OPTIONAL_LABEL: string | undefined;
        export const label = typeof OPTIONAL_LABEL === "undefined" ? "baseline" : OPTIONAL_LABEL;
        export function describe(prefix="value"): string { return prefix+":"+label; }`;
    writeFileSync(join(directory, "feature.ts"), module);
    const javascript = ts.transpileModule(module, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.CommonJS,
        },
    }).outputText;
    assert.equal(
        runInNewContext(
            "const exports={};" + javascript + ";exports.describe()",
        ),
        "value:baseline",
    );
    const result = compileSource(
        'import {describe,label} from "./feature.js"; if(describe()!=="value:baseline" || label!=="baseline") throw new Error("module fallback");',
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(t, "ambient-typeof-module", result.cpp);
});

check(
    "optional-container-method-continuations",
    `
    const original = new Set<number>([4]);
    const groups = new Map<string, Set<number>>([['entry', original]]);
    let calls = 0;
    function argument(): number { calls++; groups.clear(); return 4; }
    const removed = groups.get('entry')?.delete(argument());
    const missing = groups.get('missing')?.delete(argument());
    groups.get('missing')?.clear();
    if (removed !== true || missing !== undefined || original.size !== 0 || calls !== 1)
        throw new Error('optional receiver snapshot and argument guard');
    const state: {values: number[] | null} = {values: [3, 5, 7]};
    let sum = 0;
    function start(): number { calls++; state.values = null; return 1; }
    state.values?.slice(start()).forEach(value => { sum += value; });
    state.values?.slice(start()).forEach(value => { sum += value; });
    if (sum !== 12 || calls !== 2) throw new Error('chain continuation');
    const rows: Record<string, string>[] = [{}, {code:'north'}, {code:'south'}];
    const match = rows.find(row => row.code?.startsWith('n'));
    if (match?.code !== 'north' || rows.findIndex(row => row.code?.startsWith('s')) !== 2 ||
        rows.filter(row => row.code?.startsWith('n')).length !== 1 ||
        !rows.some(row => row.code?.startsWith('s')) || rows.every(row => row.code?.startsWith('n')))
        throw new Error('predicate truthiness after unchecked lookup');
`,
);

check(
    "nullable-coalesce-widening",
    `
    type Tag = "north" | "south";
    const values: (Tag | null)[] = ["north", null, "south"];
    let calls = 0;
    function fallback(): string { calls++; return "fallback"; }
    let observed = "";
    for (const value of values) {
        const tag: Tag | "" = value ?? "";
        observed += "[" + tag + "]";
        const text = value ?? fallback();
        observed += text;
        const mixed = value ?? 7;
        if (typeof mixed === "number") observed += mixed + 1;
        else observed += mixed.toUpperCase();
    }
    if (observed !== "[north]northNORTH[]fallback8[south]southSOUTH" || calls !== 1)
        throw new Error("joined nullish alternatives");
    let reads = 0;
    function read(index: number): Tag | null { reads++; return values[index]!; }
    const selected: string = read(1) ?? "empty";
    if (selected !== "empty" || reads !== 1) throw new Error("one evaluation across string sink");
    function optional(value: boolean): string | undefined { calls++; return value ? "later" : undefined; }
    const states = [true, false];
    for (const state of states) {
        const present = read(0) ?? optional(state);
        const absent = read(1) ?? optional(state);
        if (present !== "north") throw new Error("present wider fallback");
        if (state) { if (absent !== "later") throw new Error("present optional fallback"); }
        else if (absent !== undefined) throw new Error("absent optional fallback");
    }
    if (calls !== 3 || reads !== 5) throw new Error("lazy optional fallback");
    const record: {tag: Tag | null} = {tag: "north"};
    function turn(): void { record.tag = "south"; }
    if (record.tag === "north") {
        turn();
        if (String(record.tag ?? "") !== "south") throw new Error("live tag after narrowed helper call");
    }
`,
);

check(
    "scalar-union-strict-comparisons",
    `
    const values:(string|number|boolean)[] = ['head',2,false,NaN];
    if(values[0] !== 'head' || values[1] !== 2 || values[2] !== false) throw new Error('matching type and value');
    if(values[1] === '2' || values[2] === 0 || values[3] === values[3]) throw new Error('strict types and NaN');
    let calls = '';
    const state:{value:string|number} = {value:'before'};
    function left():string|number {calls+='l';return state.value;}
    function right():string|number {calls+='r';state.value='after';return 'before';}
    if(left() !== right() || calls !== 'lr' || state.value !== 'after') throw new Error('operand snapshots');
    const lookup = new Map<string,string|number>([['entry','before']]);
    function clear():string|number|undefined {lookup.clear();return 'before';}
    if(lookup.get('entry') !== clear()) throw new Error('borrowed optional snapshot');
    function absent():string|number|undefined {return undefined;}
    if(absent() !== lookup.get('missing')) throw new Error('absent union equality');
    const rows:Record<string,string|number>[]=[{text:'value',amount:3}];
    for(const row of rows) {
        if(row.text !== 'value' || row.amount !== 3 || row.missing === 'value' || row.missing === 0)
            throw new Error('unchecked optional union');
    }
    const [head,...tail] = values;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== false) throw new Error('union rest values');
    type Tag = 'north' | 'south';
    const tagged:(Tag|number)[] = ['north',3];
    for(const tag of tagged) {
        if(tag === 'north') continue;
        if(tag !== 3 || tag === 'outside') throw new Error('tagged scalar equality');
    }
`,
);

check(
    "mixed-tuple-rest-bindings",
    `
    const object = {score:4};
    const source:[string,number,{score:number}|null] = ['head',2,object];
    const [head,...tail] = source;
    source[1] = 9;
    if(head !== 'head' || tail[0] !== 2 || tail.length !== 2) throw new Error('fresh rest storage');
    if(tail[1]) tail[1].score++;
    if(object.score !== 5) throw new Error('shallow object identity');
    tail[0] = 7;
    if(source[1] !== 9) throw new Error('independent rest writes');
    const pair:[string,number] = ['key',3];
    const [,,...empty] = pair;
    if(empty.length !== 0) throw new Error('empty rest');
    function copy(value:[string,number,boolean]):[number,boolean] {
        const [,...rest] = value;
        return rest;
    }
    const result = copy(['value',6,true]);
    if(result[0] !== 6 || result[1] !== true) throw new Error('returned rest');
    function parameter([head,...rest]:[string,number,boolean]):[number,boolean] {
        if(head !== 'value') throw new Error('parameter head');
        rest[0]++;
        return rest;
    }
    const row:[string,number,boolean] = ['value',8,false];
    const parameterTail = parameter(row);
    if(parameterTail[0] !== 9 || parameterTail[1] !== false || row[1] !== 8) throw new Error('parameter rest copy');
    const retained:(()=>number)[] = [];
    const rows:[string,number,boolean][] = [['a',3,true],['b',5,false]];
    for(const [head,...rest] of rows) {
        rest[0]++;
        retained.push(() => rest[0] + head.length);
    }
    if(retained[0]() !== 5 || retained[1]() !== 7 || rows[0][1] !== 3) throw new Error('loop rest lifetime');
    const numbers:[number,number,number] = [2,4,6];
    const [,...numericTail] = numbers;
    numericTail[0] = 10;
    if(numericTail[0] !== 10 || numbers[1] !== 4) throw new Error('numeric tuple rest');
    const entries = new Map<string,number>([['x',11]]);
    for(const [key,...rest] of entries) {
        rest[0]++;
        if(key !== 'x' || rest[0] !== 12 || entries.get(key) !== 11) throw new Error('map entry rest');
    }
    const values = new Set<number>([13]);
    for(const [,...rest] of values.entries()) {
        rest[0]++;
        if(rest[0] !== 14 || !values.has(13)) throw new Error('set entry rest');
    }
    const list:string[] = ['first','second'];
    for(const [index,...rest] of list.entries()) {
        rest[0] = 'changed';
        if(list[index] === 'changed') throw new Error('array entry rest');
    }
    for(const [,,...rest] of entries) if(rest.length !== 0) throw new Error('empty entry rest');
`,
);

check(
    "iterable-parameter-storage",
    `
    class Collector {
        items:string[] = [];
        append(values:Iterable<string>):void {
            for(const value of values) this.items.push(value);
        }
    }
    const collector = new Collector();
    const values = new Set(['one','two']);
    collector.append(values);
    collector.append(['three']);
    const iterator = values.entries();
    function count(pairs:Iterable<[string,string]>):number {
        let total = 0;
        for(const [key,value] of pairs) {if(key !== value) throw new Error('entry identity');total++;}
        return total;
    }
    if(collector.items.join(',') !== 'one,two,three' || count(iterator) !== 2 || count(iterator) !== 0)
        throw new Error('iterable uses its actual collection');
`,
);

check(
    "mixed-tuple-mutations",
    `
    const pair:[string,number] = ['head',2];
    const alias = pair;
    const positions:number[] = [0,1];
    for(const index of positions) pair[index] = index + 10;
    for(const index of positions) {
        const value = alias[index];
        if(typeof value !== 'number' || value !== index + 10) throw new Error('dynamic writes and shared identity');
    }
    if(pair.push('tail') !== 3 || alias.length !== 3) throw new Error('push result and alias');
    if(pair.pop() !== 'tail' || pair.shift() !== 10) throw new Error('pop and shift values');
    if(pair.unshift('new') !== 2) throw new Error('unshift length');
    const removed = pair.splice(1,1,20,30);
    const indices:number[] = [1,2];
    if(removed[0] !== 11 || pair.length !== 3) throw new Error('splice result');
    for(const index of indices) if(pair[index] !== (index + 1) * 10) throw new Error('splice insertion');
    pair.length = 0 as 2;
    if(alias.length !== 0 || pair.pop() !== undefined || pair.shift() !== undefined) throw new Error('empty mutation results');
    for(const index of positions) if(pair[index] !== undefined) throw new Error('out of range after truncation');
`,
);

check(
    "mixed-tuple-mutation-boundaries",
    `
    const source:[string,number] = ['head',2];
    const positions:number[] = [0];
    for(const index of positions) source[index] = 4;
    const value = source[0];
    if(typeof value !== 'number' || value !== 4) throw new Error('changed static lane');
    if(typeof value === 'number' && value + 1 !== 5) throw new Error('guarded numeric operation');
    function tail(pair:[string,number,boolean]):[number,boolean] {
        const [,...rest] = pair;
        return rest;
    }
    const row:[string,number,boolean] = ['head',2,true];
    const rows:[number,boolean][] = [];
    rows.push(tail(row));
    if(rows[0][0] !== 2 || rows[0][1] !== true) throw new Error('stored returned rest');
    let pair:[string,number] = ['head',2];
    const original = pair;
    function argument():number {pair=['new',3];return 4;}
    if(pair.push(argument()) !== 3 || original.length !== 3 || pair.length !== 2) throw new Error('push receiver snapshot');
    let numbers:number[] = [1];
    const before = numbers;
    let current = 2;
    function replace():number {numbers=[9];current=3;return 4;}
    if(numbers.push(current, replace()) !== 3 || before[1] !== 2 || before[2] !== 4 || numbers.length !== 1) throw new Error('ordinary push evaluation');
    if(numbers.push() !== 1) throw new Error('empty push length');
    const prepend = numbers;
    if(numbers.unshift(current, replace()) !== 3 || prepend[0] !== 3 || prepend[1] !== 4 || numbers.length !== 1) throw new Error('unshift evaluation');
    const spread:number[] = [5,6];
    function editSpread():number {spread[0]=7;return 8;}
    numbers.push(...spread, editSpread());
    if(numbers[1] !== 5 || numbers[2] !== 6 || numbers[3] !== 8) throw new Error('spread arguments evaluated before mutation');
    numbers.push(...numbers);
    if(numbers.length !== 8 || numbers[5] !== 5) throw new Error('self spread');
`,
);

check(
    "mixed-tuple-destructuring-assignments",
    `
    const row:[string,number,boolean] = ['head',2,true];
    let head = '';
    let tail:(number|boolean)[] = [];
    [head,...tail] = row;
    if(head !== 'head' || tail[0] !== 2 || tail[1] !== true) throw new Error('assigned rest');
    tail[0] = 7;
    if(row[1] !== 2) throw new Error('rest is fresh');
    let count = 0;
    let enabled = false;
    [head,count,enabled] = row;
    if(head !== 'head' || count !== 2 || enabled !== true) throw new Error('assigned lanes');
    [head,count,enabled] = ['next',3,false];
    if(head !== 'next' || count !== 3 || enabled !== false) throw new Error('literal assignment');
    [,count] = row;
    if(count !== 2) throw new Error('omitted assignment');
    let first = 1, second = 2;
    [first,second] = [second,first];
    if(first !== 2 || second !== 1) throw new Error('numeric swap');
    function mutate():number {second=9;return 7;}
    [first,second] = [second,mutate()];
    if(first !== 1 || second !== 7) throw new Error('source values precede assignments');
    let calls = 0;
    function source():[string,number,boolean] {calls++;return row;}
    [head,...tail] = source();
    if(calls !== 1 || head !== 'head' || tail[0] !== 2) throw new Error('single source evaluation');
    const object = {value:4};
    const objects:[string,{value:number}] = ['object',object];
    let selected = {value:0};
    [head,selected] = objects;
    selected.value = 9;
    if(object.value !== 9) throw new Error('assigned object identity');
    let empty:(number|boolean)[] = [1];
    [,,,...empty] = row;
    if(empty.length !== 0) throw new Error('empty assigned rest');
    [...tail] = [];
    if(tail.length !== 0) throw new Error('empty literal rest');
`,
);

check(
    "unshift-callback-snapshots",
    `
    function first():number {return 1;}
    function second():number {return 2;}
    let selected:()=>number=first;
    function replace():()=>number {selected=second;return second;}
    const callbacks:(()=>number)[]=[];
    callbacks.unshift(selected,replace());
    if(callbacks[0]!()!==1 || callbacks[1]!()!==2 || selected()!==2)
        throw new Error("unshift snapshots before later effects");
    callbacks.unshift(selected);
    if(callbacks[0]!()!==2 || callbacks[1]!()!==1)
        throw new Error("unshift borrows until insertion");
    `,
);

check(
    "mixed-tuple-dynamic-reads",
    `
    let pair: [string, number] = ["value", 7];
    const indices = [0, 1, 2, -1, 0.5, NaN];
    let observed = "";
    for (const index of indices) {
        const lookup = pair[index];
        const value = lookup;
        if (typeof value === "string") observed += value.toUpperCase();
        else if (typeof value === "number") observed += value + 1;
        else if (value === undefined) observed += "?";
    }
    if (observed !== "VALUE8????") throw new Error("dynamic tuple values and absence");
    let calls = 0;
    function index(): number { calls++; pair = ["new", 10]; return 1; }
    if (pair[index()] !== 7 || calls !== 1 || pair[1] !== 10) throw new Error("dynamic tuple evaluation order");
    const item = {score: 3};
    const recordPair: [string, {score:number} | null] = ["key", item];
    const recordIndices: number[] = [1, 0, 2];
    for (const offset of recordIndices) {
        const value = recordPair[offset];
        if (typeof value === "object" && value !== null) value.score++;
    }
    if (item.score !== 4) throw new Error("dynamic tuple object identity");
`,
);

check(
    "set-entry-iteration",
    `
    const values = new Set<number>([2, 3, 4]);
    let seen = "";
    for (const [first, second] of values.entries()) {
        if (first !== second) throw new Error("entry lanes");
        seen += first;
        if (first === 2) { values.delete(3); values.add(5); }
    }
    if (seen !== "245") throw new Error("live entry iteration");
    const pairs = [...values.entries()];
    pairs[0]![0] = 99;
    if (!values.has(2) || values.has(99) || pairs[0]![1] !== 2) throw new Error("fresh numeric pairs");
    const copied = Array.from(values.entries());
    if (copied.map(([a,b]) => a + b).join(",") !== "4,8,10") throw new Error("entry array copy");
    let visits = 0;
    const projected = Array.from(values.entries(), ([a,b], index) => { visits++; return a + b + index; });
    if (visits !== 3 || projected.join(",") !== "4,9,12") throw new Error("entry array mapper");
    for (let [a,b] of values.entries()) { a = 20; b = 30; if (a + b !== 50) throw new Error("local entry bindings"); }
    const mutated = Array.from(values.entries(), pair => { pair[0] = 100; return pair[1]; });
    if (mutated.join(",") !== "2,4,5" || Array.from(values).join(",") !== "2,4,5") throw new Error("mapper pair identity");
    const records = new Set<{score:number}>();
    const record = {score:7}; records.add(record);
    for (const pair of records.entries()) {
        if (pair[0] !== pair[1] || pair[0] !== record) throw new Error("shared entry object");
        pair[0].score++;
        pair[0] = {score:20};
        if (pair[1] !== record) throw new Error("independent entry lanes");
    }
    const objects = [...records.entries()];
    if (record.score !== 8 || objects[0]![0] !== record || objects[0]![1] !== record) throw new Error("retained object identity");
    const secondCopy = [...records.entries()];
    if (objects[0] === secondCopy[0]) throw new Error("fresh entry identities");
    const cleared = new Set<number>([1,2]);
    let clearedSeen = "";
    for (const [value] of cleared.entries()) { clearedSeen += value; if (value === 1) { cleared.clear(); cleared.add(3); } }
    if (clearedSeen !== "13") throw new Error("clear during iteration");
    const mapping = new Map<string, number>([["a",1],["b",2]]);
    for (let [key, value] of mapping.entries()) { key = "other"; value = 9; if (key !== "other" || value !== 9) throw new Error("map locals"); }
    const mappedPairs = Array.from(mapping.entries(), pair => { pair[0] = "new"; return pair; });
    if (mapping.has("other") || mapping.has("new") || mapping.get("a") !== 1 || mappedPairs[0]![0] !== "new") throw new Error("map fresh pairs");
    const source = {values: new Set<number>([1,2])};
    const original = source.values;
    const rewritten = Array.from(source.values, value => { source.values = new Set<number>([9]); value += 10; return value; });
    if (rewritten.join(",") !== "11,12" || Array.from(original).join(",") !== "1,2") throw new Error("mapper receiver and value snapshots");
`,
);

check(
    "stored-set-entry-iterators",
    `
    const values = new Set<number>([2,3]);
    const entries = values.entries();
    const alias = entries;
    if(!entries || entries !== alias) throw new Error('iterator identity and truthiness');
    values.add(4);
    const first = entries.next();
    if(first.done || first.value[0] !== 2 || first.value[1] !== 2) throw new Error('first');
    first.value[0] = 99;
    if(first.value[1] !== 2 || !values.has(2)) throw new Error('fresh pair lanes');
    values.delete(2);
    values.delete(3);
    let seen = '';
    for(const [a,b] of alias) {
        if(a !== b) throw new Error('matching lanes');
        seen += a;
        if(a === 4) { values.clear(); values.add(7); }
    }
    if(seen !== '47') throw new Error('live cursor');
    values.add(8);
    const exhausted = entries.next();
    if(!entries) throw new Error('exhausted iterator is still an object');
    if(!exhausted.done || exhausted.value !== undefined) throw new Error('sticky exhaustion');
    const delayedValues = new Set<string>();
    const delayed = delayedValues.entries();
    delayedValues.add('later');
    const copied = [...delayed];
    if(copied.length !== 1 || copied[0]![0] !== 'later') throw new Error('deferred start');
    const shared = {count:1};
    const objects = new Set<{count:number}>([shared]);
    const objectEntries = objects.entries();
    for(const pair of objectEntries) {
        pair[0].count++;
        if(pair[1].count !== 2) throw new Error('object identity');
    }
    if(shared.count !== 2) throw new Error('retained object');
    const partial = new Set<number>([1,2,3]).entries();
    for(const [a] of partial) { if(a !== 1) throw new Error('break'); break; }
    const remaining = Array.from(partial);
    if(remaining.length !== 2 || remaining[0]![0] !== 2 || remaining[1]![1] !== 3) throw new Error('resume after break');
    const mappedValues = new Set<number>([2]);
    const mappedEntries = mappedValues.entries();
    const mapped = Array.from(mappedEntries, ([a,b], index) => {
        if(a === 2) mappedValues.add(3);
        return a+b+index;
    });
    if(mapped.join(',') !== '4,7') throw new Error('mapped iterator');
    function make(): IterableIterator<[number,number]> {
        const owner = new Set<number>([5,6]);
        return owner.entries();
    }
    const returned = make();
    const retained: () => number = () => {
        const next = returned.next();
        return next.done ? -1 : next.value[0];
    };
    if(retained() !== 5 || retained() !== 6 || retained() !== -1) throw new Error('iterator lifetime');
    const keyed = new Set<number>([2,3]);
    const keys = keyed.keys();
    const scalarValues = keyed.values();
    if(keys.next().value !== 2 || scalarValues.next().value !== 2) throw new Error('independent cursors');
    const keysArray = [...keys];
    if(keysArray.join(',') !== '3') throw new Error('key cursor');
`,
);

check(
    "string-replacement-callbacks",
    `
    let calls = 0;
    let input = "aba";
    const result = input.replaceAll("a", (match, index: number, original: string) => {
        calls++;
        input = "changed";
        if (original !== "aba" || match !== "a") throw new Error("callback input snapshot");
        return "$&" + index;
    });
    if (result !== "$&0b$&2" || calls !== 2 || input !== "changed") throw new Error("literal callback result");
    function replace(match: string, offset: number, source: string): string {
        return match + offset + source.length;
    }
    if ("aba".replace("a", replace) !== "a03ba") throw new Error("first replacement");
    let stored: (match: string) => string = match => match.toUpperCase();
    if ("aba".replaceAll("a", stored) !== "AbA") throw new Error("stored replacement");
    calls = 0;
    const untouched = "abc".replaceAll("z", () => { calls++; return "bad"; });
    if (untouched !== "abc" || calls !== 0) throw new Error("missing match callback");
    const padded = "😀".replaceAll("", (_match, offset: number) => "[" + offset + "]");
    if (padded !== "[0]\\ud83d[1]\\ude00[2]") throw new Error("empty search UTF16 positions");
    let order = "";
    function source(): string { order += "s"; return "x"; }
    function search(): string { order += "p"; return "x"; }
    function callback(): (value: string) => string { order += "c"; return value => { order += "r"; return value; }; }
    if (source().replace(search(), callback()) !== "x" || order !== "spcr") throw new Error("replacement evaluation order");
`,
);

check(
    "known-nullish-string-conversion",
    `
    function show(value: unknown): string { return String(value); }
    const missing = undefined;
    const empty = null;
    if (typeof missing !== "undefined" || typeof empty !== "object") throw new Error("nullish typeof");
    if (show(missing) !== "undefined" || show(empty) !== "null") throw new Error("nullish String");
    if ("value=" + missing !== "value=undefined" || "value=" + empty !== "value=null") throw new Error("nullish concatenation");
    if (\`value=\${missing}\` !== "value=undefined" || \`value=\${empty}\` !== "value=null") throw new Error("nullish interpolation");
`,
);

check(
    "array-predicates-preserve-effects-and-absence",
    `
    let calls = 0;
    function numbers(): number[] { calls++; return [1, 2]; }
    function record(): {value:number} { calls++; return {value: 1}; }
    function optional(present: boolean): number[] | null { return present ? [1] : null; }
    if (!Array.isArray(numbers()) || Array.isArray(record()) || calls !== 2) throw new Error("array predicate effects");
    const inputs = [true, false];
    for (const input of inputs) if (Array.isArray(optional(input)) !== input) throw new Error("absent array");
    if (Array.isArray(undefined) || Array.isArray(null) || Array.isArray(new Float32Array(2))) throw new Error("nonarrays");
`,
);

check(
    "tuple-aliases-survive-binding-replacement",
    `
    let numeric: [number, number] = [1, 2];
    const oldNumeric = numeric;
    numeric = [3, 4];
    numeric[0] = 5;
    if (oldNumeric[0] !== 1 || numeric[0] !== 5) throw new Error("numeric tuple binding");
    let mixed: [string, number] = ["old", 1];
    const oldMixed = mixed;
    mixed = ["new", 2];
    mixed[1] = 3;
    if (oldMixed[0] !== "old" || oldMixed[1] !== 1 || mixed[1] !== 3) throw new Error("mixed tuple binding");
`,
);

check(
    "empty-audio-resource-collections",
    `
    const nodes = new Map<AudioNode, number>();
    const parameters = new Map<AudioParam, number>();
    const contexts = new Set<AudioContext>();
    const streams = new Map<MediaStream, number>();
    const tracks = new Set<MediaStreamTrack>();
    if (nodes.size + parameters.size + contexts.size + streams.size + tracks.size !== 0) throw new Error("resource collections");
`,
);

check(
    "enum-parameter-defaults",
    `
    enum Tone { Soft = "soft", Bold = "bold" }
    enum Mode { First = 3, Second }
    function tone(value: Tone = Tone.Soft): string { return value; }
    function mode(value: Mode = Mode.Second): number { return value; }
    function main(): void {
        if (tone() !== "soft" || tone(Tone.Bold) !== "bold" || mode() !== 4) throw new Error("enum defaults");
        let order = "";
        function mark(name: string): string { order += name; return order; }
        const labels: Record<Tone, string> = {[Tone.Bold]: mark("b"), [Tone.Soft]: mark("s")};
        if (order !== "bs" || labels[Tone.Bold] !== "b" || labels[Tone.Soft] !== "bs") throw new Error("enum record effects");
        if (Object.keys(labels).join(",") !== "bold,soft" || Object.values(labels).join(",") !== "b,bs") throw new Error("enum record order");
    }
    main();
`,
);

check(
    "object-prototype-own-property-call",
    `
    const entries: Record<string, number> = {first: 2, second: 3};
    delete entries["first"];
    const keys = ["first", "second", "toString", "missing"];
    let found = "";
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(entries, key)) found += key;
    }
    if (found !== "second") throw new Error("own property membership");
    let calls = 0;
    function owner(): Record<string, number> { calls++; return entries; }
    if (!Object.prototype.hasOwnProperty.call(owner(), "second") || calls !== 1) throw new Error("own property effects");
`,
);

check(
    "callback-factory-record-assignment",
    `
    let count = 0;
    function handler(step: number): () => void { count++; return () => { count += step; }; }
    const registry = { identity: <T>(value: T): T => value, action: (): void => {} };
    registry.action();
    registry.action = handler(3);
    registry.action();
    if (registry.identity(count) !== 4) throw new Error("callback factory assignment");
`,
);

check(
    "ignored-generic-record-returns-preserve-branch-effects",
    `
    let visits = 0;
    function createHook() { visits += 10; return {identity: <T>(value:T):T => value}; }
    function install(ready: boolean) {
        try {
            if (ready) return createHook();
            visits++;
            return createHook();
        } finally { visits += 100; }
    }
    for (const ready of [true, false]) install(ready);
    if (visits !== 221) throw new Error("ignored return effects or finally");
    function literal(ready:boolean) {
        if (ready) return {first: visits++, second: createHook()};
        return {first: visits++, second: createHook()};
    }
    for (const ready of [false, true]) literal(ready);
    if (visits !== 243) throw new Error("discarded literal member effects");
    function compared(ready:boolean) {
        if (ready) return visits++ > 0;
        return visits++ < 0;
    }
    for (const ready of [false, true]) compared(ready);
    if (visits !== 245) throw new Error("discarded comparison effects");
    const values = [3, 1, 2];
    values.sort((a,b) => a-b);
    if (values.join(",") !== "1,2,3") throw new Error("discarded sort still consumes comparator result");
`,
);

check(
    "record-method-rebinding-is-visible-to-retained-callbacks",
    `
    let count = 0;
    function handler(step: number): () => void { count++; return () => { count += step; }; }
    const registry = {identity: <T>(value:T):T => value, action: ():void => { count += 10; }};
    const callbacks: Array<() => void> = [() => registry.action()];
    const alias = registry;
    const flags = [false, true];
    for (const replace of flags) {
        if (replace) alias.action = handler(3);
        callbacks[0]!();
    }
    if (registry.identity(count) !== 14) throw new Error("retained callback method slot");
`,
);

check(
    "nullable-string-enum-assertions",
    `
    const keys = ["low", "high"] as const;
    type Key = typeof keys[number];
    function parse(raw: string | null): Key | null {
        return (keys as readonly string[]).includes(raw ?? "") ? raw as Key : null;
    }
    const inputs: Array<string | null> = ["high", null, "unknown", "low"];
    const parsed = inputs.map(parse);
    if (parsed[0] !== "high" || parsed[1] !== null || parsed[2] !== null || parsed[3] !== "low") throw new Error("nullable enum assertion");
`,
);

async function executeGeneratedAssertions(
    t: TestContext,
    name: string,
    source: string,
): Promise<void> {
    await t.test(
        "generated C++ executes the same assertions",
        { skip: !native },
        () => {
            const directory = resolve("artifacts/language-constructs", name);
            mkdirSync(directory, { recursive: true });
            const cpp = join(directory, "check.cpp"),
                exe = join(directory, "check.exe");
            writeFileSync(cpp, source);
            runNativeFixtureCompiler(native!, [
                "/nologo",
                "/std:c++20",
                "/W4",
                "/WX",
                "/permissive-",
                "/EHsc",
                "/MD",
                "/fp:precise",
                "/utf-8",
                "/I",
                "native/include",
                "/I",
                join(nativeFixtureVcpkgRoot, "include"),
                `/Fo:${directory}/`,
                `/Fe:${exe}`,
                cpp,
            ]);
            execFileSync(exe, { stdio: "pipe" });
        },
    );
}

/**
 * The snippet sees one deployment query on both sides: the Node run reads
 * it as `location.search`, the compiler folds it as the reference query.
 */
function check(
    name: string,
    source: string,
    { search = "" }: { search?: string } = {},
): void {
    test(name, async (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
            { location: { search }, URLSearchParams },
        );
        const result = compileSource(source, {
            fileName: `${name}.ts`,
            search,
        });
        await executeGeneratedAssertions(t, name, result.cpp);
    });
}

// Hoisted typed-array tables store their elements converted at generation;
// every element must read back as the value the runtime store produces.
const hoistedTableValues = [
    -0.1555, 0.4098, 0.1, 0.3333333333333333, 1e-7, -2.5, 1e21, 16777217,
    33565870, 33565872, 33565874, 3.4028234663852886e38, 1.1754943508222875e-38,
    1.401298464324817e-45, 65504.5, 0.30000000000000004, -98765.4321,
    4294967296.5, -1.9, 300,
];
for (let seed = 12345; hoistedTableValues.length < 132;) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const mantissa = (seed / 2147483648) * 2 - 1;
    hoistedTableValues.push(
        Number((mantissa * 10 ** ((seed % 13) - 6)).toPrecision(9)),
    );
}
check(
    "hoisted-typed-array-tables-store-converted-elements",
    `
    const raw: number[] = [${hoistedTableValues.join(", ")}];
    const floats = new Float32Array([${hoistedTableValues.join(", ")}]);
    const words = new Uint32Array([${hoistedTableValues.join(", ")}]);
    const bytes = new Int8Array([${hoistedTableValues.join(", ")}]);
    const expectedWords = new Uint32Array(raw);
    const expectedBytes = new Int8Array(raw);
    for (let index = 0; index < raw.length; ++index) {
        if (floats[index] !== Math.fround(raw[index]!)) throw new Error("float " + index);
        if (words[index] !== expectedWords[index]) throw new Error("word " + index);
        if (bytes[index] !== expectedBytes[index]) throw new Error("byte " + index);
    }
`,
);

check(
    "constant-tables-use-literals-outside-local-scopes",
    `
    type Row = [number, number, "run" | null, boolean?];
    const first = 3, second = 7, enabled = true;
    const totals: number[] = [];
    function append(rows: Row[]): void {
        for (const [value, multiplier, , active] of rows) {
            totals.push(value * multiplier + (active ? 1 : 0));
        }
    }
    append([[first, 4, null, enabled], [second, 2, null, enabled]]);
    if (totals.join(",") !== "13,15") throw new Error("constant tuple table");
`,
);

check(
    "mixed-tuple-storage",
    `
    interface Item { score: number; }
    const item: Item = {score: 3};
    const pairs: [string, Item][] = [["b", item], ["a", {score: 5}]];
    const alias = pairs[0]!;
    alias[0] = "c";
    alias[1].score += 4;
    if (pairs[0]![0] !== "c" || item.score !== 7) throw new Error("tuple aliases");
    const [key, value] = alias;
    if (key !== "c" || value !== item || alias.length !== 2) throw new Error("destructure");
    const byKey = new Map<string, Item>(pairs);
    const entries = [...byKey.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.map(([k, v]) => k + v.score).join(",") !== "a5,c7") throw new Error("ordered entries");
    entries[0]![0] = "other";
    entries[0]![1].score = 9;
    if (byKey.has("other") || byKey.get("a")!.score !== 9) throw new Error("fresh entry pair");
    const object = Object.fromEntries(pairs);
    if (object["c"] !== item) throw new Error("fromEntries identity");
    let total = 0;
    for (const [, entry] of pairs) total += entry.score;
    if (total !== 16) throw new Error("iteration");
    const seen = new Set<[string, Item]>();
    seen.add(alias); seen.add(pairs[0]!); seen.add(["c", item]);
    if (seen.size !== 2 || !seen.has(alias)) throw new Error("tuple key identity");
    const groups = new Map<number, string[]>();
    groups.set(2, ["b"]); groups.set(1, ["a", "c"]);
    const ordered = [...groups].sort(([a], [b]) => a - b).map(([, names]) => [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    if (ordered.map(names => names.join("+")).join(";") !== "a+c;b") throw new Error("nested entry arrays");
    const weights = new Map<string, number>();
    weights.set("a", 2); weights.set("b", 1);
    const sortedKeys: string[] = ["a", "b"];
    if (sortedKeys.sort((a, b) => weights.get(a)! - weights.get(b)!).join("") !== "ba") throw new Error("asserted Map result");
`,
);

check(
    "conditional-json-null",
    `
    function parse(text: string): number {
        const value = text ? JSON.parse(text) : null;
        return value === null ? -1 : value.count;
    }
    if (parse("") !== -1 || parse('{"count":3}') !== 3) throw new Error("nullable document");
    function missing(text: string): boolean {
        const value = text ? JSON.parse(text) : undefined;
        return value === undefined;
    }
    if (!missing("") || missing("null")) throw new Error("undefined document");
    type Mode = "slow" | "normal" | "fast";
    function mode(value: unknown): Mode { return value === "slow" || value === "fast" ? value : "normal"; }
    const inputs = JSON.parse('["slow", "fast", 0, null]');
    let modes = "";
    for (const input of inputs) modes += mode(input) + ";";
    if (modes !== "slow;fast;normal;normal;") throw new Error("guarded JSON enum");
`,
);

check(
    "fixed-record-entry-projection",
    `
    type Action = "left" | "right";
    type Scheme = "first" | "second";
    const definitions = [
        {action: "left", defaults: {first: "a", second: "j"}},
        {action: "right", defaults: {first: "d", second: "l"}},
    ] as const;
    function profile(scheme: Scheme): Record<Action, string> {
        return Object.fromEntries(definitions.map(definition => [definition.action, definition.defaults[scheme]])) as Record<Action, string>;
    }
    const first = profile("first"), second = profile("second");
    if (first.left !== "a" || first.right !== "d" || second.left !== "j" || second.right !== "l") throw new Error("fixed record projection");
    let visits = 0;
    const values = Object.fromEntries(["x", "x", "y"].map(key => [key, ++visits]));
    if (visits !== 3 || values.x !== 2 || values.y !== 3) throw new Error("duplicate entry effects");
`,
);

check(
    "compound-union-tags",
    `
    type Key = {kind: "motion"; action: "up" | "down"} | {kind: "command"; action: "save" | "load"};
    type Result = {ok: true; value: number; displaced?: Key} | {ok: false; reason: "invalid"} | {ok: false; reason: "blocked"; key: Key};
    function result(index: number): Result {
        if (index < 0) return {ok: false, reason: "invalid"};
        if (index === 0) return {ok: false, reason: "blocked", key: {kind: "motion", action: "up"}};
        return {ok: true, value: index};
    }
    const results: Result[] = [result(-1), result(0), result(3)];
    let text = "";
    for (const entry of results) {
        if (entry.ok) text += entry.value;
        else if (entry.reason === "blocked") text += entry.key.action;
        else text += entry.reason;
    }
    if (text !== "invalidup3") throw new Error("compound tag narrowing");
`,
);

check(
    "contextual-string-array-results",
    `
    interface Definition { name: "first" | "second" | null; }
    interface Group { names: readonly string[]; }
    const definitions: Definition[] = [{name:"first"}, {name:null}, {name:"second"}];
    const names: readonly string[] = definitions.map(value => value.name).filter((name): name is NonNullable<typeof name> => name !== null);
    const groups: Group[] = [{names}];
    const alias = names as string[];
    alias.push("extra");
    if (groups[0]!.names.join(",") !== "first,second,extra") throw new Error("contextual filter identity");
    const mapped: string[] = definitions.filter(value => value.name !== null).map(value => value.name!);
    mapped.push("extra");
    if (mapped.join(",") !== "first,second,extra") throw new Error("contextual map");
`,
);

check(
    "stored-array-predicates",
    `
    interface Filter { run: (accept: (value: number) => boolean) => number[]; }
    const numbers: number[] = [1, 2, 3];
    const filter: Filter = {run: accept => [...numbers].filter(accept)};
    if (filter.run(value => value > 1).join(",") !== "2,3") throw new Error("stored predicate");
    let predicate: (value: number) => boolean = value => { predicate = () => false; return value > 0; };
    if (numbers.filter(predicate).length !== 3 || numbers.filter(predicate).length !== 0) throw new Error("callback argument snapshot");
`,
);

check(
    "assigned-optional-array-result",
    `
    function group(values: readonly string[]): string[][] {
        const rows: string[][] = [];
        let selected: string[] | null = null;
        for (const value of values) {
            if (!selected) rows.push(selected = []);
            selected.push(value);
        }
        return rows;
    }
    if (group(["a", "b"]).map(row => row.join("")).join(",") !== "ab") throw new Error("assignment returns initialized array");
`,
);

check(
    "constructor-callback-instance-capture",
    `
    interface Hooks { change: () => number; }
    class Counter {
        value = 0;
        constructor(private readonly hooks: Hooks) {}
        next(): number { this.value++; return this.hooks.change(); }
    }
    const counter = new Counter({change: () => counter.value});
    if (counter.next() !== 1 || counter.next() !== 2) throw new Error("constructor closure observes instance");
`,
);

check(
    "absent-optional-iteration",
    `
    const input: {items?: readonly number[]} = {};
    let visited = 0;
    for (const item of input.items ?? []) {
        if (item < 0) continue;
        visited++;
        if (item === 4) break;
    }
    if (visited !== 0) throw new Error("absent iterable");
`,
);

check(
    "constant-array-slices",
    `
    const entries = [{score: 2}, {score: 7}, {score: 11}] as const;
    const gaps = entries.slice(1).map((entry, index) => entry.score - entries[index]!.score);
    if (Math.min(...gaps) !== 4 || entries.slice(-2, -0.5).length !== 0) throw new Error("constant slice bounds");
    let visits = 0;
    function next(): number { return ++visits; }
    const first = [next(), next(), next()].slice(0, 1);
    if (first[0] !== 1 || visits !== 3) throw new Error("discarded slice effects");
    const minimum = Math.min(...[2, 7, 11].map(value => value + 1));
    if (minimum !== 3 || Math.max(...[]) !== -Infinity) throw new Error("constant numeric spread");
`,
);

check(
    "indexed-and-union-string-parts",
    `
    function token(text: string): string { let i = 0, value = ""; while (i < text.length) value += text[i++]; return value; }
    if (token("text") !== "text") throw new Error("indexed concat");
    let index = 0;
    const text = "x" + ""[index++];
    if (text !== "xundefined" || index !== 1) throw new Error("missing character once");
    interface Label { text: (value: string | number) => string; }
    const label: Label = {text: value => \`value:\${value}\`};
    if (label.text(3) !== "value:3" || label.text("name") !== "value:name") throw new Error("union template");
`,
);

check(
    "logical-assignment",
    `
    function verify(seed: number | undefined, flag: number): number {
        let a = seed;
        a ??= 2;
        let b = flag;
        b ||= 3;
        b &&= b + 1;
        const r: { a?: number; b: number; s: string } = { b: 0, s: "" };
        r.a ??= 5;
        r.a ??= 9;
        r.b ||= 7;
        r.s ||= "x";
        const groups: Record<string, number[]> = {};
        (groups["k"] ??= []).push(1);
        (groups["k"] ??= []).push(2);
        const cache = new Map<string, number[]>();
        let bucket = cache.get("k");
        bucket ??= [];
        bucket.push(4);
        cache.set("k", bucket);
        const lanes: Array<number | undefined> = [undefined, 2];
        lanes[0] ??= 6;
        return a + b + (r.a ?? 0) + r.b + r.s.length + (groups["k"]?.length ?? 0) + (cache.get("k")?.length ?? 0) + (lanes[0] ?? 0);
    }
    if (verify(undefined, 0) !== 2 + 4 + 5 + 7 + 1 + 2 + 1 + 6) throw new Error("nullish and falsy stores");
    if (verify(1, 5) !== 1 + 6 + 5 + 7 + 1 + 2 + 1 + 6) throw new Error("present values keep their value");
`,
);

check(
    "logical-string-selection",
    `
    let effects = 0;
    function read(value: string): string { effects++; return value; }
    function fallback(): string { effects += 10; return "fallback"; }
    interface Selector { choose: (value: string | null) => string; }
    const selector: Selector = {choose: value => value || fallback()};
    if ((read("kept") || fallback()) !== "kept" || effects !== 1) throw new Error("lazy OR");
    if ((read("") || fallback()) !== "fallback" || effects !== 12) throw new Error("fallback OR");
    if ((read("") && fallback()) !== "" || effects !== 13) throw new Error("lazy AND");
    if ((read("kept") && fallback()) !== "fallback" || effects !== 24) throw new Error("selected AND");
    if (selector.choose(null) !== "fallback" || effects !== 34) throw new Error("nullable OR");
    if (selector.choose("present") !== "present" || effects !== 34) throw new Error("present OR");
`,
);

check(
    "retained-nonfinite-records",
    `
    function entry() { return {invalid: Number.NaN, high: Number.POSITIVE_INFINITY, low: Number.NEGATIVE_INFINITY}; }
    const entries = Array.from({length: 3}, () => entry());
    for (const value of entries) {
        if (!Number.isNaN(value.invalid) || value.high !== Infinity || value.low !== -Infinity) throw new Error("nonfinite retained fields");
    }
`,
);

check(
    "contextual-conditional-arrays",
    `
    type Key = "first" | "second" | "third";
    class Catalog {
        values(key: Key): readonly Key[] {
            return key === "first" ? ["second", "third"] : key === "second" ? ["first"] : [];
        }
    }
    const catalog = new Catalog();
    const keys: Key[] = ["first", "second", "third"];
    let result = "";
    for (const key of keys) result += catalog.values(key).join(",") + ";";
    if (result !== "second,third;first;;") throw new Error("contextual array selection");
    const defaults = ["first", "second", "first"] as const;
    const unique = new Set<string>(defaults);
    if (unique.size !== 2 || !unique.has("second")) throw new Error("constant iterable constructor");
`,
);

check(
    "recursive-array-callback",
    `
    function evaluate(seed: number): number {
        const memo = new Map<number, number>();
        const depth = (value: number): number => {
            const known = memo.get(value);
            if (known !== undefined) return known;
            const parents: number[] = value > 1 ? [value - 1, value - 2] : [];
            const result = parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
            memo.set(value, result);
            return result;
        };
        return depth(seed);
    }
    if (evaluate(6) !== 5 || evaluate(3) !== 2) throw new Error("recursive array callback captures");
`,
);

check(
    "error-values",
    `
    if (String(new Error()) !== "Error" || String(new RangeError("limit")) !== "RangeError: limit") throw new Error("error string conversion");
    let text = "first";
    const held = new Error(text);
    const stack = held.stack;
    if (typeof stack !== "undefined" && typeof stack !== "string") throw new Error("optional error stack");
    text = "second";
    if (String(held) !== "Error: first" || \`result: \${held}\` !== "result: Error: first") throw new Error("error message snapshot");
    function boom(kind: number): number {
        try {
            if (kind === 1) throw new RangeError("range");
            if (kind === 2) throw new TypeError("type");
            const held = new Error("held");
            if (kind === 3) throw held;
            if (kind === 4) throw new Error();
        } catch (e) {
            if (!(e instanceof Error)) throw new Error("caught value is an Error");
            return e.message.length;
        }
        return -1;
    }
    if (boom(1) !== 5 || boom(2) !== 4 || boom(3) !== 4 || boom(4) !== 0 || boom(5) !== -1) throw new Error("messages");
    const constructed = new RangeError("bad");
    if (constructed.message !== "bad" || constructed.name !== "RangeError") throw new Error("constructed error");
    let rethrown = 0;
    function inner(): void { try { throw new Error("x"); } catch (e) { throw e; } }
    try { inner(); } catch (e) { rethrown = (e as Error).message.length; }
    if (rethrown !== 1) throw new Error("rethrow");
`,
);

check(
    "object-statics",
    `
    const TABLE = Object.freeze({ a: 1, b: 2 });
    const XS = Object.freeze([1, 2, 3]);
    if (TABLE.a + TABLE.b + XS.length + XS[2]! !== 9) throw new Error("freeze is the value");
    function dictionary(d: Record<string, number>): number {
        let total = 0;
        for (const [key, value] of Object.entries(d)) total += key.length * value;
        for (const value of Object.values(d)) total += value;
        return total + Object.keys(d).length + (Object.hasOwn(d, "bb") ? 10 : 0) + ("bb" in d ? 20 : 0);
    }
    if (dictionary({ a: 1, bb: 2 }) !== 1 + 4 + 3 + 2 + 10 + 20) throw new Error("dictionary statics");
    const merged = Object.assign({}, { a: 1, b: 2 }, { b: 3, c: 4 });
    if (merged.a + merged.b + merged.c !== 8) throw new Error("assign merges");
    const record = { a: 1, b: 2 };
    Object.assign(record, { b: 5 });
    if (record.b !== 5) throw new Error("assign into target");
    function same(a: number, b: number): number { return Object.is(a, b) ? 1 : 0; }
    if (same(NaN, NaN) !== 1 || same(0, -0) !== 0 || same(2, 2) !== 1) throw new Error("Object.is");
    const fromPairs = Object.fromEntries([["x", 1], ["y", 2]] as Array<[string, number]>);
    const source = new Map<string, number>([["z", 3]]);
    const fromMap = Object.fromEntries(source);
    if ((fromPairs["x"] ?? 0) + (fromPairs["y"] ?? 0) + (fromMap["z"] ?? 0) !== 6) throw new Error("fromEntries");
    if (Object.entries(record).length !== 2 || Object.entries(record)[1]![1] !== 5) throw new Error("record entries");
`,
);

check(
    "string-indexing",
    `
    function at(value: string, index: number): string | undefined { return value[index]; }
    const text = "Aé😀Z";
    if (at(text, 0) !== "A" || at(text, 1) !== "é" || at(text, 4) !== "Z") throw new Error("code unit indexing");
    if (at(text, 2) !== String.fromCharCode(0xd83d) || at(text, 3) !== String.fromCharCode(0xde00)) throw new Error("surrogate indexing");
    if (at(text, -1) !== undefined || at(text, 5) !== undefined || at(text, 1.5) !== undefined || at(text, NaN) !== undefined) throw new Error("absent string property");
    let source = "ab";
    function change(): number { source = "cd"; return 1; }
    const selected = source[change()];
    if (selected !== "b") throw new Error("string receiver snapshot");
    const axes = [[0, 1, 2], [1, 0, 2], [2, 1, 0]] as const;
    const names = axes.map(row => row.map(index => "xyz"[index]).join(""));
    if (names.join(",") !== "xyz,yxz,zyx") throw new Error("static string projection");
`,
);

check(
    "string-indexing-parameter-lifetime",
    `
    function scan(text: string): number {
        let sum = 0;
        const n = text.length;
        for (let i = 0; i < n;) sum += text[i++]!.charCodeAt(0);
        for (let i = n - 1; i >= 0; i--) sum -= text.charCodeAt(i);
        if (text[n] !== undefined || text[-1] !== undefined || text[0.5] !== undefined ||
            !Number.isNaN(text.charCodeAt(Infinity))) throw new Error("indexed bounds");
        return sum;
    }
    if (scan("aé😀Z".repeat(20000)) !== 0 || scan("different") !== 0 || scan("") !== 0)
        throw new Error("repeated string traversal");
    function replace(text: string): string {
        const first = text[0];
        function change(): number { text = "cd"; return 1; }
        const selected = text[change()];
        return first + selected + text[0];
    }
    const runtimeText = "ab".repeat(Math.trunc(Math.random()) + 1);
    if (replace(runtimeText) !== "abc") throw new Error("mutable parameter snapshot");
    function retained(text: string): () => string | undefined {
        const first = text[0];
        return () => first + text[1];
    }
    const first = retained("ab"), second = retained("cd");
    if (first() !== "ab" || second() !== "cd") throw new Error("retained string capture");
`,
);

check(
    "literal-key-record-lookup",
    `
    type Mode = "low" | "high";
    interface Settings { amount: number; enabled: boolean; }
    const options: Readonly<Record<Mode, Settings>> = {
        low: { amount: 1, enabled: false }, high: { amount: 3, enabled: true },
    };
    const selected: Mode = "high";
    const settings = options[selected];
    if (settings.amount !== 3 || !settings.enabled) throw new Error("literal key lookup");
`,
);

check(
    "constant-filter-effects",
    `
    let calls = 0;
    function step(value: number): number { calls++; return value; }
    const input = [step(1), "skip", step(2)] as const;
    let visits = 0;
    const selected = input.filter(value => { visits++; return typeof value === "number"; });
    if (calls !== 2 || visits !== 3 || selected.join(",") !== "1,2") throw new Error("filter evaluation order");
    const early = [1, 2, 3].filter(value => {
        if (value < 2) return false;
        return value > 0;
    });
    if (early.join(",") !== "2,3") throw new Error("early predicate returns");
`,
);

check(
    "readonly-record-array-lookup",
    `
    interface Attachment { position: readonly [number, number, number]; }
    interface Entry { id: string; attachment: Attachment | null; }
    const catalog: readonly Entry[] = [
        { id: "a", attachment: null },
        { id: "b", attachment: { position: [1, 2, 3] } },
    ];
    function find(id: string): Entry | undefined { return catalog.find(entry => entry.id === id); }
    const key = Math.random() > .5 ? "b" : "b";
    const match = find(key);
    if (!match || !match.attachment || match.attachment.position[1] !== 2) throw new Error("runtime lookup");
    if (find("a")?.attachment !== null || find("missing") !== undefined) throw new Error("nullable lookup");
`,
);

check(
    "iterators",
    `
    function walk(xs: number[]): number {
        let total = 0;
        for (const [index, value] of xs.entries()) total += index * value;
        for (const index of xs.keys()) total += index;
        for (const value of xs.values()) total += value;
        return total;
    }
    if (walk([2, 3]) !== 3 + 1 + 5) throw new Error("array iterators");
    const scaled: number[] = [1, 2];
    for (const [index, value] of scaled.entries()) scaled[index] = value * 10;
    if (scaled[0]! + scaled[1]! !== 30) throw new Error("entries index the source");
    const m = new Map<string, number>([["a", 1], ["b", 2]]);
    let text = "";
    for (const [k, v] of m.entries()) text += k + v;
    for (const k of m.keys()) text += k;
    for (const v of m.values()) text += v;
    if (text !== "a1b2ab12") throw new Error("map iterators");
    const s = new Set<number>([3, 4]);
    let sum = 0;
    for (const v of s.values()) sum += v;
    for (const v of s.keys()) sum += v;
    const merged = [...m.keys(), ...m.keys()];
    const valueList = [...m.values()];
    const spread = merged.length + valueList[1]!;
    if (sum !== 14 || spread !== 6) throw new Error("set iterators and spreads");
    const doubled = Array.from(s, (v, i) => v * 2 + i);
    const keys = Array.from(m.keys());
    if (doubled.join() !== "6,9" || keys.join() !== "a,b") throw new Error("Array.from over ranges");
    const lanes = new Float32Array([1.5, 2.5]);
    let lanesTotal = 0;
    for (const lane of lanes) lanesTotal += lane;
    if (lanesTotal !== 4) throw new Error("typed array iteration");
`,
);

check(
    "dictionaries",
    `
    interface Table { fallback: number; [id: string]: number }
    function lookup(table: Table, key: string): number {
        return table[key] ?? table.fallback;
    }
    const table: Table = { fallback: 1, deer: 3 };
    table.deer = 4;
    table["fox"] = 5;
    if (lookup(table, "deer") + lookup(table, "fox") + lookup(table, "owl") !== 10) throw new Error("index signature table");
    const counts: Record<string, number> = {};
    for (const word of ["a", "b", "a"]) counts[word] = (counts[word] ?? 0) + 1;
    delete counts["b"];
    if (Object.keys(counts).length !== 1 || counts["a"] !== 2 || "b" in counts) throw new Error("delete and in");
    const groups: Record<string, string[]> = {};
    for (const [key, value] of Object.entries({ x: "1", y: "2" })) (groups[key] ??= []).push(value);
    if (groups["x"]?.join() !== "1" || groups["y"]?.join() !== "2") throw new Error("dictionary of arrays");
`,
);

check(
    "weak-collections",
    `
    interface Item { id: number }
    const seen = new WeakMap<Item, number>();
    const marked = new WeakSet<Item>();
    const item: Item = { id: 1 };
    const other: Item = { id: 1 };
    seen.set(item, 2);
    marked.add(item);
    if (seen.get(item) !== 2 || seen.has(other) || !marked.has(item) || marked.has(other)) throw new Error("identity keys");
    seen.delete(item);
    if (seen.has(item)) throw new Error("delete");
`,
);

check(
    "destructuring",
    `
    function lanes(xs: number[]): number {
        const [first = 5, second = 7, ...rest] = xs;
        let a = 1;
        let b = 2;
        [a, b] = [b, a];
        return first + second * 10 + rest.length * 100 + a * 1000;
    }
    if (lanes([1]) !== 1 + 70 + 0 + 2000 || lanes([1, 2, 3, 4]) !== 1 + 20 + 200 + 2000) throw new Error("array defaults and rest");
    const source = { a: 1, b: 2, c: 3 };
    const { a, ...rest } = source;
    const { b = 9, d = 4 } = { b: 2 } as { b?: number; d?: number };
    if (a + rest.b + rest.c + b + d !== 12) throw new Error("object defaults and rest");
    interface Options { width?: number; height: number }
    function area({ width = 2, height }: Options): number { return width * height; }
    if (area({ height: 3 }) + area({ width: 4, height: 1 }) !== 10) throw new Error("destructured parameters");
    function struct(options: Options): number {
        const { width = 6, height } = options;
        return width + height;
    }
    if (struct({ height: 1 }) + struct({ width: 1, height: 1 }) !== 9) throw new Error("struct defaults");
`,
);

check(
    "generics",
    `
    function first<T>(xs: readonly T[]): T | undefined { return xs[0]; }
    function mapAll<T, U>(xs: readonly T[], f: (x: T) => U): U[] { const out: U[] = []; for (const x of xs) out.push(f(x)); return out; }
    function longest<T extends { length: number }>(a: T, b: T): T { return a.length >= b.length ? a : b; }
    function getOrCreate<K, V>(m: Map<K, V>, k: K, make: () => V): V { let v = m.get(k); if (v === undefined) { v = make(); m.set(k, v); } return v; }
    function pick<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }
    if ((first([2, 3]) ?? 0) + (first(["ab"]) ?? "").length !== 4) throw new Error("two instantiations");
    if (mapAll([1, 2], x => x * 2).join() !== "2,4" || mapAll(["a"], x => x.length)[0] !== 1) throw new Error("callback types");
    if (longest("abc", "de") !== "abc" || longest([1], [1, 2]).length !== 2) throw new Error("constraints");
    const buckets = new Map<string, number[]>();
    getOrCreate(buckets, "a", () => []).push(1);
    getOrCreate(buckets, "a", () => []).push(2);
    if (getOrCreate(buckets, "a", () => []).length !== 2) throw new Error("nullable rebinding");
    if (pick({ a: 2, b: "x" }, "a") !== 2) throw new Error("keyof");
    class Stack<T> {
        private items: T[] = [];
        push(item: T): void { this.items.push(item); }
        peek(): T | undefined { return this.items[this.items.length - 1]; }
        size(): number { return this.items.length; }
    }
    const numbers = new Stack<number>();
    numbers.push(1);
    numbers.push(2);
    const words = new Stack<string>();
    words.push("x");
    if ((numbers.peek() ?? 0) + numbers.size() + (words.peek() ?? "").length !== 5) throw new Error("generic class");
    type Result<T> = { ok: true; value: T } | { ok: false; error: string };
    function unwrap(r: Result<number>): number { return r.ok ? r.value : -1; }
    if (unwrap({ ok: true, value: 2 }) + unwrap({ ok: false, error: "e" }) !== 1) throw new Error("literal-tagged union alias");
`,
);

check(
    "function-parameters",
    `
    function sum(...xs: number[]): number { let t = 0; for (const x of xs) t += x; return t; }
    function join(separator: string, ...parts: string[]): string { return parts.join(separator); }
    function sum3(a: number, b: number, c: number): number { return a + b + c; }
    const args: [number, number, number] = [1, 2, 3];
    const spread = [4, 5];
    if (sum(1, 2) + sum() + sum(...spread) !== 12) throw new Error("rest parameters");
    if (join("-", "a", "b") !== "a-b" || join("+") !== "") throw new Error("rest after fixed");
    if (sum3(...args) !== 6) throw new Error("tuple spread call");
`,
);

check(
    "module-state",
    `
    const items: number[] = [];
    const stats = { hits: 0, nested: { depth: 1 } };
    const cache = new Map<string, number>();
    const listeners: Array<() => void> = [];
    const api = { base: 10, get() { return this.base + items.length; } };
    function add(n: number): void { items.push(n); stats.hits += 1; stats.nested.depth += n; }
    function memo(key: string): number { let v = cache.get(key); if (v === undefined) { v = key.length; cache.set(key, v); } return v; }
    function on(l: () => void): () => void { listeners.push(l); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    function emit(): void { for (const l of listeners) l(); }
    add(1);
    add(2);
    let fired = 0;
    const off = on(() => { fired += 1; });
    emit();
    off();
    emit();
    if (items.length !== 2 || stats.hits !== 2 || stats.nested.depth !== 4) throw new Error("mutated module containers");
    if (memo("ab") + memo("ab") + cache.size !== 5 || fired !== 1) throw new Error("module cache and listeners");
    if (api.get() !== 12) throw new Error("module record method");
`,
);

check(
    "class-shapes",
    `
    class A { v = 1; }
    class B { w = 2; }
    class Counter { constructor(private n: number) {} get doubled(): number { return this.n * 2; } read(): number { return [1].map(x => x + this.n)[0] ?? 0; } }
    function tag(x: unknown): number { return x instanceof A ? 1 : x instanceof B ? 2 : 0; }
    const items: Array<A | B> = [new A(), new B()];
    let total = 0;
    for (const item of items) total += item instanceof A ? item.v : item.w;
    if (total !== 3 || tag(new A()) + tag(new B()) + tag(3) !== 3) throw new Error("instanceof");
    if (new Counter(2).doubled + new Counter(3).read() !== 8) throw new Error("temporaries as receivers");
`,
);

check(
    "binary-data",
    `
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    view.setFloat32(0, 1.5, true);
    view.setUint16(4, 258);
    view.setFloat64(8, -2.25, true);
    view.setInt8(6, -1);
    const bytes = new Uint8Array(buffer);
    if (view.getFloat32(0, true) !== 1.5 || bytes[4] !== 1 || bytes[5] !== 2 || view.getUint8(6) !== 255) throw new Error("setters");
    if (view.getFloat64(8, true) !== -2.25 || view.getInt16(4) !== 258 || view.getUint16(4, true) !== 513) throw new Error("byte order");
    const lanes = new Float32Array(8);
    const window = lanes.subarray(2, 4);
    window[0] = 7;
    const tail = lanes.subarray(6);
    if (lanes[2] !== 7 || window.length !== 2 || tail.length !== 2 || lanes.slice(2, 3)[0] !== 7) throw new Error("subarray shares bytes");
    const words = new Uint32Array(buffer, 4, 2);
    words[0] = 0x01020304;
    if (bytes[4] !== 4 || bytes[7] !== 1) throw new Error("buffer views");
`,
);

check(
    "buffer-view-storage",
    `
    interface Payload { data: ArrayBufferView; read(): ArrayBufferView | null; }
    const buffer = new ArrayBuffer(32);
    const floats = new Float32Array(buffer, 8, 3);
    const bytes = new Uint8Array(buffer, 4, 12);
    const view = new DataView(buffer, 6, 8);
    const payloads: Payload[] = [
        { data: floats, read: () => floats },
        { data: bytes, read: () => bytes },
        { data: view, read: () => view },
    ];
    function setFirst(value: ArrayBufferView): void {
        const destination = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        destination[0] = 17;
    }
    for (let i = 0; i < payloads.length; i++) {
        const item = payloads[i]!;
        const read = item.read();
        if (read !== item.data || item.data.buffer !== buffer) throw new Error("view and buffer identity");
        setFirst(item.data);
    }
    const all = new Uint8Array(buffer);
    if (all[4] !== 17 || all[6] !== 17 || all[8] !== 17) throw new Error("shared subview bytes");
    if (payloads[0]!.data.byteOffset !== 8 || payloads[0]!.data.byteLength !== 12) throw new Error("numeric view range");
    if (payloads[2]!.data.byteOffset !== 6 || payloads[2]!.data.byteLength !== 8) throw new Error("data view range");
    const aliases: ArrayBufferView[] = [floats, floats, new Float32Array(buffer, 8, 3)];
    if (aliases[0] !== aliases[1] || aliases[0] === aliases[2]) throw new Error("distinct views on one buffer");
    const views = new Set<ArrayBufferView>();
    views.add(floats); views.add(floats); views.add(bytes);
    if (views.size !== 2 || !views.has(floats)) throw new Error("view keys");
`,
);

check(
    "contextual-record-map-spreads",
    `
    interface Item { name: string; category: "first" | "second"; metadata: { size: number } | null; }
    const first: string[] = ["a", "b"];
    const second: string[] = ["long"];
    const items: readonly Item[] = [
        ...first.map(name => ({ name, category: "first" as const, metadata: null })),
        ...second.map(name => ({ name, category: "second" as const, metadata: { size: name.length } })),
    ];
    if (items.length !== 3 || items[0]!.metadata !== null || items[2]!.metadata!.size !== 4)
        throw new Error("contextual record fields");
    if (items.filter(item => item.metadata === null).map(item => item.name).join(",") !== "a,b")
        throw new Error("contextual record filtering");
`,
);

check(
    "spread-string-literal-sets",
    `
    const labels = { first: "warm", second: "cool", duplicate: "warm" } as const;
    type Label = "start" | "warm" | "cool" | "end";
    const values: readonly Label[] = ["start", ...new Set(Object.values(labels)), "end"];
    if (values.join(",") !== "start,warm,cool,end") throw new Error("set widening and order");
    const small: ("warm" | "cool")[] = ["cool", "warm"];
    const strings: string[] = [...small];
    small[0] = "warm";
    if (strings.join(",") !== "cool,warm") throw new Error("fresh widened array");
    if (values.filter(label => label.startsWith("c")).map(label => label.toUpperCase()).join(",") !== "COOL")
        throw new Error("string methods on literal unions");
    const selected = values[2]!;
    if (selected.length !== 4 || selected[1] !== "o") throw new Error("literal union string members");
`,
);

check(
    "flat-map-tuple-alternatives",
    `
    type Tag = "a" | "b";
    const tags: Tag[] = ["a", "b"];
    function location(tag: Tag | "unused" | undefined): "north" | "south" | null { return tag === "unused" ? null : tag === "a" ? "north" : null; }
    function temperature(tag: Tag): "hot" | "cold" { return tag === "a" ? "hot" : "cold"; }
    const byName: ReadonlyMap<string, Tag> = new Map(tags.flatMap(tag => {
        const place = location(tag);
        const heat = temperature(tag);
        return [...(place === null ? [] : [[place, tag] as const]), ...(heat === "cold" ? [[heat, tag] as const] : [])];
    }));
    if (byName.size !== 2 || byName.get("north") !== "a" || byName.get("cold") !== "b") throw new Error("flattened alternatives");
    const original = new Map<Tag, number>([["a", 1], ["b", 2]]);
    const widened: Map<string, number> = new Map(original);
    widened.set("extra", 3);
    if (widened.get("b") !== 2 || original.size !== 2) throw new Error("fresh widened map");
`,
);

check(
    "runtime-parameter-defaults",
    `
    let calls = 0;
    function fallback(): number { calls++; return 7; }
    function scale(value = fallback(), multiplier = 2): number { return value * multiplier; }
    const options: { value?: number }[] = [{}, { value: 3 }];
    if (scale(options[0]!.value) !== 14 || calls !== 1) throw new Error("missing value default");
    if (scale(options[1]!.value, 4) !== 12 || calls !== 1) throw new Error("present value skips default");
    if (scale(undefined, 3) !== 21 || calls !== 2) throw new Error("explicit undefined");
    function dependent(first: number, second = first + 1): number { return second; }
    if (dependent(9) !== 10) throw new Error("prior parameter scope");
    let sequence = "";
    function missing(): number | undefined { sequence += "a"; return undefined; }
    function last(): number { sequence += "b"; return 2; }
    function initial(): number { sequence += "c"; return 3; }
    function ordered(value = initial(), factor: number): number { return value * factor; }
    if (ordered(missing(), last()) !== 6 || sequence !== "abc") throw new Error("argument and default order");
    function keepNull(value: number | null = 5): number | null { return value; }
    if (keepNull(null) !== null || keepNull() !== 5) throw new Error("null is not undefined");
    interface Item { score: number; }
    const original: Item = { score: 9 };
    interface Saved { value?: Item; callback?: () => number; }
    const records: Saved[] = [{}, { value: original, callback: () => 6 }];
    function choose(value: Item = { score: 3 }): Item { return value; }
    const fresh = choose(records[0]!.value);
    if (!fresh || fresh.score !== 3 || choose(records[1]!.value) !== original) throw new Error("reference defaults");
    function invoke(callback: () => number = () => 2): number { return callback(); }
    if (invoke(records[0]!.callback) !== 2 || invoke(records[1]!.callback) !== 6) throw new Error("callback defaults");
`,
);

check(
    "fixed-record-enumeration",
    `
    type Key = "north" | "south";
    interface Entry { bounds: readonly [number, number]; }
    const table: Record<Key, Entry> = { south: { bounds: [2, 4] }, north: { bounds: [1, 3] } };
    if (Object.keys(table).join(",") !== "south,north") throw new Error("key order");
    if (Object.values(table).map(entry => entry.bounds[1]).join(",") !== "4,3") throw new Error("value order");
    const pairs = Object.entries(table);
    if (pairs[0][0] !== "south" || pairs[0][1] !== table.south) throw new Error("entry identity");
    function width(key: Key): number { return table[key].bounds[1] - table[key].bounds[0]; }
    const largest = Math.max(...(Object.keys(table) as Key[]).map(key => width(key) * table[key].bounds[1]));
    if (largest !== 8) throw new Error("typed key callbacks");
`,
);

check(
    "readonly-numeric-dictionaries",
    `
    const samples = new Float32Array([2, 4]);
    const writable: Record<number, Float32Array> = {};
    writable[7] = samples;
    interface Collection { readonly channels: Readonly<Record<number, Float32Array>>; }
    const collections: Collection[] = [{ channels: writable }];
    const key = Number("7");
    const channels = collections[0]!.channels;
    if (channels[key] !== samples || channels[key]![1] !== 4) throw new Error("dictionary identity");
    channels[key]![0] = 9;
    if (samples[0] !== 9) throw new Error("readonly dictionary retains mutable values");
    if (channels[8] !== undefined || !(key in channels) || 8 in channels) throw new Error("key presence");
`,
);

check(
    "numeric-index-outputs",
    `
    interface Output { [index: number]: number; }
    interface Projector { write(out: Output, index: number, value: number): void; changed?: () => void; }
    const projectors: Projector[] = [{ write(out, index, value) { out[index] = value; } }];
    const floats = new Float32Array(2);
    const bytes = new Uint8Array(2);
    const numbers: number[] = [0];
    const tuple: [number, number] = [0, 0];
    const outputs: Output[] = [floats, bytes, numbers, tuple];
    for (const out of outputs) projectors[0]!.write(out, 1, 258.1);
    if (floats[1] !== Math.fround(258.1) || bytes[1] !== 2 || numbers[1] !== 258.1 || numbers.length !== 2 || tuple[1] !== 258.1)
        throw new Error("index writes preserve storage");
    function add(out: Output, index: number): number { out[index] += 2; return out[index]++; }
    if (add(bytes, 1) !== 4 || bytes[1] !== 5) throw new Error("index updates");
    let changed = 0;
    projectors[0]!.changed?.();
    projectors[0]!.changed = () => { changed++; };
    projectors[0]!.changed?.();
    if (changed !== 1) throw new Error("optional interface callbacks");
`,
);

check(
    "strings-and-numbers",
    `
    function text(s: string): string { return s.charAt(0) + s.charAt(9) + s.padEnd(4, "-") + s.trimStart().trimEnd() + "|"; }
    if (text(" ab") !== " " + " ab-" + "ab|") throw new Error("string methods");
    function spell(n: number): string { return n.toString(16) + ":" + n.toString(2) + ":" + n.toString(); }
    if (spell(255) !== "ff:11111111:255" || (-10).toString(16) !== "-a" || (0.5).toString(2) !== "0.1") throw new Error("radix");
    function parse(s: string): number { return parseFloat(s) + Number.parseFloat(s) + parseInt(s, 10); }
    if (parse("1.5x") !== 4 || !Number.isNaN(parseFloat("x")) || parseFloat("  -2e1z") !== -20) throw new Error("parseFloat");
    function truthy(n: number, s: string): number { return (Boolean(n) ? 1 : 0) + (Boolean(s) ? 2 : 0); }
    if (truthy(0, "x") !== 2 || truthy(3, "") !== 1) throw new Error("Boolean()");
    if (String(null) + String(undefined) !== "nullundefined") throw new Error("String of nullish");
    let a = 1;
    const comma = (a += 1, a * 10);
    if (comma !== 20 || Date.now() <= 0) throw new Error("comma and clock");
`,
);

check(
    "nullish-equality",
    `
    function absent(value: number | null | undefined): boolean { return value == null; }
    function present(value: string | null | undefined): boolean { return value != null; }
    if (!absent(null) || !absent(undefined) || absent(0) || absent(NaN)) throw new Error("numeric absence");
    if (present(null) || present(undefined) || !present("") || !present("text")) throw new Error("string presence");
    const document = JSON.parse('{"nil":null,"zero":0,"empty":"","no":false}');
    if (document.nil != null || document.missing != null || document.zero == null || document.empty == null || document.no == null)
        throw new Error("JSON nullish values");
    if (document.nil === undefined || document.missing === null) throw new Error("strict null distinction");
`,
);

test("raw text imports read the file beside the module", () => {
    const result = compileSource(
        'import shader from "./raw-text-import.wgsl?raw";\nif (shader.length !== 27) throw new Error("raw text length");\n',
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
        "the text file is a recorded input",
    );
});

test("raw text imports support constant string replacement through helpers", () => {
    const result = compileSource(
        `
        import shader from "./raw-text-import.wgsl?raw";
        function replacement(): string { return "return"; }
        const expanded = shader.replace(" r ", " " + replacement() + " ").replaceAll("1.0", "2.0");
        if (!expanded.includes("return 2.0")) throw new Error("raw text expansion");
    `,
        { fileName: "test/fixtures/raw-text-import.ts" },
    );
    assert.ok(result.cpp.includes("return 2.0"));
    assert.ok(
        result.manifest.inputs.includes("test/fixtures/raw-text-import.wgsl"),
    );
});

test("constant numeric tables support runtime indexing and static string projections", () => {
    const result = compileSource(`
        const AXES = [[0, 1, 2], [1, 0, 2], [2, 1, 0]] as const;
        export function axes(axis: 0 | 1 | 2): readonly [number, number, number] { return AXES[axis]; }
        const names = AXES.map(row => row.map(index => "xyz"[index]).join(""));
        export const shader = \`first=\${names[0]};second=\${names[1]};third=\${names[2]};\`;
        if (axes(Math.random() < 0.5 ? 0 : 1)[2] !== 2) throw new Error("runtime table index");
    `);
    assert.ok(result.cpp.includes("first=xyz;second=yxz;third=zyx;"));
});

test("static early returns preserve shader composition records", () => {
    const result = compileSource(`
        import type { EngineContext, ShaderMaterial, ShaderUniformDecl } from "@babylonjs/lite";
        interface Composition {
            text: string;
            uniforms: readonly ShaderUniformDecl[];
            bind: (engine: EngineContext, material: ShaderMaterial) => void;
        }
        const disabled: Composition = { text: "disabled", uniforms: [], bind: () => {} };
        function composition(enabled: boolean): Composition {
            if (!enabled) return disabled;
            return { text: "enabled", uniforms: [], bind: () => {} };
        }
        const text = composition(true).text + ":" + composition(false).text;
        if (text !== "enabled:disabled") throw new Error("composition branch");
    `);
    assert.ok(result.cpp.includes("enabled:disabled"));
});

check(
    "static-return-paths",
    `
    let visits = 0;
    function select(enabled: boolean): number {
        visits++;
        if (enabled) { const value = visits; return value; }
        visits++;
        return visits;
    }
    const first = select(true);
    const second = select(false);
    if (first !== 1 || second !== 3 || visits !== 3) throw new Error("static return effects");
    function dynamic(flag: number): number { return select(flag > 0); }
    if (dynamic(1) !== 4 || dynamic(0) !== 6 || visits !== 6) throw new Error("dynamic fallback effects");
`,
);

test("unsupported language shapes refuse explicitly", () => {
    for (const [source, message] of [
        [
            "function* gen(): Generator<number> { yield 1; } for (const v of gen()) {}",
            /Generator functions/,
        ],
        [
            "const a = { x: 1 }; const b = { x: 1 }; if (Object.is(a, b)) {}",
            /Object.is compares/,
        ],
        [
            'function f(n: number): boolean { return "x" in n; } f(1);',
            /'in' is decided/,
        ],
        [
            "function f(r: { a: number }): void { delete r.a; } f({ a: 1 });",
            /required field/,
        ],
        [
            "function f(xs: number[]): void { xs[Math.trunc(Math.random())] ??= 2; } f([1]);",
            /must not contain a call/,
        ],
    ] as const)
        assert.throws(() => compileSource(source), message);
});

check(
    "promise-rejection-parameters",
    `
    let seen = "";
    let calm = 0;
    let armed = true;
    async function risky(): Promise<void> {
        if (armed) throw new Error("boom");
        calm++;
    }
    void risky().catch((error) => {
        if (!(error instanceof Error) || error.message !== "boom") throw new Error("catch binding");
        seen = error.message;
    });
    void risky().then(() => { if (calm >= 0) throw new Error("fulfilled"); }, (error) => {
        if (error.message !== "boom") throw new Error("rejection binding");
    });
    void risky().catch((error) => { if (error.message.length !== 4) return; seen += "!"; });
    armed = false;
    void risky().catch((error) => { throw new Error("unexpected " + error.message); });
`,
);

check(
    "private-class-members",
    `
    interface Request { id: number; text: string; }
    class Queue<T extends Request> {
        readonly #pending: T[] = [];
        #priorityCount = 0;
        #current: T | null = null;
        get current(): T | null { return this.#current; }
        get size(): number { return this.#pending.length; }
        get #head(): T | undefined { return this.#pending[0]; }
        push(request: T, priority = false): void {
            if (this.#current) {
                if (priority) { this.#pending.splice(this.#priorityCount, 0, request); this.#priorityCount++; }
                else this.#pending.push(request);
                return;
            }
            this.#current = request;
        }
        advance(): T | null {
            if (this.#priorityCount > 0) this.#priorityCount--;
            const next = this.#pending.shift();
            this.#current = next ?? null;
            return this.#current;
        }
        #describe(): string { return this.#current ? this.#current.text : "idle"; }
        describe(): string { return this.#describe() + "/" + (this.#head?.text ?? "-"); }
    }
    const queue = new Queue<Request>();
    queue.push({ id: 1, text: "one" });
    queue.push({ id: 2, text: "two" });
    queue.push({ id: 3, text: "three" }, true);
    const before = queue.describe();
    const advanced = queue.advance();
    const after = queue.describe();
    if (before !== "one/three" || advanced?.id !== 3 || after !== "three/two" || queue.size !== 1 || queue.current?.text !== "three") {
        throw new Error(before + " " + after + " " + queue.size);
    }
    class Slot<T extends Request> {
        #value: T;
        #hits = 0;
        constructor(value: T) { this.#value = value; }
        touch(): number { this.#hits++; return this.#value.id + this.#hits; }
    }
    const slots: Slot<Request>[] = [];
    for (let index = 0; index < 3; index++) slots.push(new Slot<Request>({ id: index, text: "slot" }));
    let total = 0;
    for (const slot of slots) total += slot.touch() + slot.touch();
    if (total !== 15) throw new Error("stored generic private fields " + total);
`,
);

check(
    "struct-results-evaluate-once",
    `
    interface Item { id: number; }
    const queue: Item[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    let current: Item | null = null;
    current = queue.shift() ?? null;
    if (current?.id !== 1 || queue.length !== 2) throw new Error("shift once");
    const spare: Item = { id: 9 };
    const last = queue.pop() ?? spare;
    if (last.id !== 3 || queue.length !== 1) throw new Error("pop once");
    function next(): Item | undefined { return queue.pop(); }
    const inlined = next() ?? spare;
    if (inlined.id !== 2 || queue.length !== 0) throw new Error("inlined call once");
    let taken = 0;
    const pool: Item[] = [{ id: 5 }, { id: 6 }];
    function take(): Item { taken++; return pool[taken - 1]; }
    const sum = take().id + take().id;
    if (sum !== 11 || taken !== 2) throw new Error("snapshot once " + sum);
    class Node { id: number; constructor(id: number) { this.id = id; } bump(): void { this.id++; } }
    const nodes: Node[] = [new Node(1), new Node(2)];
    nodes.pop()?.bump();
    if (nodes.length !== 1 || nodes[0].id !== 1) throw new Error("receiver once");
`,
);

check(
    "string-append-storage",
    `
    class Log {
        private parts: string[] = ["a", "b"];
        private text = "";
        describe(): string { return this.parts.join("/"); }
        get size(): number { return this.parts.length; }
        add(entry: string): void { this.text += entry + ";"; }
        get all(): string { return this.text; }
    }
    const log = new Log();
    let text = log.describe();
    text += "|" + log.describe() + "|" + log.size;
    text += 2;
    if (text !== "a/b|a/b|22") throw new Error(text);
    log.add("x"); log.add("y");
    if (log.all !== "x;y;") throw new Error(log.all);
    interface Entry { text: string; count: number; }
    const entries: Entry[] = [{ text: "a", count: 0 }];
    entries[0].text += "b";
    if (entries[0].text !== "ab") throw new Error(entries[0].text);
    const words: string[] = ["a", "b"];
    words[1] += "c";
    words[0] += log.size;
    if (words.join(",") !== "a2,bc") throw new Error(words.join(","));
    const emoji = "😀";
    let joined = emoji.at(0) ?? "";
    joined += emoji.at(1) ?? "";
    if (joined !== emoji || joined.codePointAt(0) !== 128512) throw new Error("surrogate append");
`,
);

check(
    "resolved-query-values-in-native-expressions",
    `
    const qs = new URLSearchParams(location.search);
    const labTest = qs.has("labtest");
    const godMode = qs.has("godmode");
    const cleanLab = qs.has("guidedtour") || qs.has("rocktest");
    const enabled = Date.now() > 0;
    interface Save { size: number; }
    const saves: (Save | null)[] = [{ size: 3 }, null];
    const loaded = saves[enabled ? 0 : 1];
    function fits(size: number): boolean { return size === 3; }
    const sizeOk = labTest || loaded === null || fits(loaded.size);
    const content = loaded !== null && sizeOk ? loaded : null;
    if (content === null || content.size !== 3) throw new Error("mixed chain");
    const skipSplash = godMode || loaded === null;
    const persist = !labTest && !cleanLab && enabled;
    if (!skipSplash || !persist) throw new Error("folded and native operands");
    const base = enabled ? 10 : 20;
    const count = Number(qs.get("count") ?? "3") + base;
    const modeName = qs.get("mode") ?? "walk";
    const current = enabled ? "fly" : "walk";
    let matched = 0;
    if (current === modeName) matched += 1;
    if (count !== 14 || matched !== 1) throw new Error("query constants beside natives " + count + " " + matched);
    const driveName = (qs.get("drive") || "Studio").toLowerCase();
    if (driveName !== "studio" || (qs.get("mode") ?? "").length !== 3) throw new Error("query receivers " + driveName);
`,
    { search: "?godmode&count=4&mode=fly" },
);

check(
    "query-helpers-with-parameters",
    `
    const qs = new URLSearchParams(location.search);
    const num = (k: string, d: number): number => {
        const v = qs.get(k);
        return v !== null && Number.isFinite(Number(v)) ? Number(v) : d;
    };
    function str(k: string, d: string): string {
        const v = qs.get(k);
        return v !== null && v !== "" ? v : d;
    }
    let report = "";
    function main(): void {
        const keys: string[] = ["w", "h", "mode"];
        for (const key of keys) report += num(key, -1) + ":" + str(key, "none") + ";";
        report += num("w", 4) + ":" + qs.has("wire");
    }
    main();
    const moduleKeys: string[] = ["mode", "h"];
    for (const key of moduleKeys) report += "," + (qs.get(key) ?? "-");
    if (report !== "6:6;-1:none;-1:fly;6:true,fly,-") throw new Error(report);
`,
    { search: "?w=6&wire=1&mode=fly" },
);

check(
    "narrowed-type-parameters",
    `
    interface Save { size: number; }
    type Plan<S> = { kind: "fresh" } | { kind: "restore"; save: S };
    interface Intent<S> { plan: Plan<S>; skipSplash: boolean; }
    function plan<S>(save: S | null): Plan<S> {
        return save === null ? { kind: "fresh" } : { kind: "restore", save };
    }
    function intent<S>(plan: Plan<S>): Intent<S> {
        return { plan, skipSplash: false };
    }
    function pick<S>(candidate: S | null, fallback: S): S {
        return candidate === null ? fallback : candidate;
    }
    const saves: (Save | null)[] = [{ size: 3 }, null];
    const restored = plan(saves[Date.now() > 0 ? 0 : 1]);
    const fresh = intent(plan(saves[1]));
    const chosen = pick(saves[1], { size: 7 });
    if (restored.kind !== "restore" || restored.save.size !== 3 || fresh.plan.kind !== "fresh" || chosen.size !== 7) throw new Error("narrowed " + restored.kind + fresh.plan.kind);
    const index = Date.now() > 0 ? 1 : 0;
    let seen = "";
    if (saves[index] === null) seen += "null;";
    if (saves[index]) seen += "truthy;";
    if (seen !== "null;") throw new Error(seen);
`,
);

check(
    "class-inheritance-construction-order-and-super",
    `
    const log: string[] = [];
    function note(entry: string): number {
        log.push(entry);
        return log.length;
    }
    class Base {
        readonly order = note("base field");
        protected count = 0;
        #secret = 7;
        constructor(public label: string) {
            note("base body " + label);
        }
        get secret(): number {
            return this.#secret;
        }
        set secret(value: number) {
            this.#secret = value;
        }
        get doubled(): number {
            return this.count * 2;
        }
        bump(step: number = 1): number {
            this.count += step;
            return this.count;
        }
        name(): string {
            return "base";
        }
        who(): string {
            return this.name() + "/" + this.label;
        }
    }
    class Middle extends Base {
        readonly middle = note("middle field");
        constructor(label: string, public extra: number) {
            const prefix = "m-";
            note("middle before super");
            super(prefix + label);
            note("middle body " + this.extra);
        }
        override name(): string {
            return "middle(" + super.name() + ")";
        }
        override bump(step: number = 1): number {
            return super.bump(step * 10);
        }
        get doubled(): number {
            return super.doubled + 1;
        }
    }
    class Leaf extends Middle {
        readonly leaf = note("leaf field");
        override name(): string {
            return "leaf:" + super.name();
        }
    }
    const leaf = new Leaf("x", 5);
    if (log.join("|") !== "middle before super|base field|base body m-x|middle field|middle body 5|leaf field")
        throw new Error("construction order " + log.join("|"));
    if (leaf.order !== 2 || leaf.middle !== 4 || leaf.leaf !== 6) throw new Error("field initializer values");
    if (leaf.who() !== "leaf:middle(base)/m-x") throw new Error("virtual chain " + leaf.who());
    if (leaf.bump() !== 10 || leaf.bump(2) !== 30) throw new Error("super bump");
    if (leaf.doubled !== 61) throw new Error("super getter " + leaf.doubled);
    leaf.secret = 11;
    if (leaf.secret !== 11) throw new Error("inherited accessor pair");
    if (leaf.extra !== 5 || leaf.label !== "m-x") throw new Error("parameter properties");
    if (!(leaf instanceof Base) || !(leaf instanceof Middle) || !(leaf instanceof Leaf)) throw new Error("instanceof chain");
    const base = new Base("b");
    if (base instanceof Middle) throw new Error("base is not middle");
    if (base.who() !== "base/b" || base.doubled !== 0) throw new Error("base methods");
    class Plain extends Base {}
    const plain = new Plain("p");
    if (plain.who() !== "base/p" || plain.bump(3) !== 3) throw new Error("implicit constructor");
`,
);

check(
    "class-inheritance-generic-base",
    `
    class Box<T> {
        constructor(readonly value: T) {}
        get(): T {
            return this.value;
        }
        pair(other: T): T[] {
            return [this.value, other];
        }
    }
    class NumberBox extends Box<number> {
        doubled(): number {
            return this.get() * 2;
        }
    }
    class Labeled<T> extends Box<T> {
        constructor(value: T, readonly label: string) {
            super(value);
        }
    }
    const box = new NumberBox(3);
    if (box.get() + 1 !== 4 || box.doubled() !== 6 || box.pair(5).length !== 2) throw new Error("generic base");
    const labeled = new Labeled<string>("v", "l");
    if (labeled.get() + labeled.label !== "vl") throw new Error("generic chain");
`,
);

check(
    "class-hierarchy-virtual-dispatch-through-stored-references",
    `
    abstract class Shape {
        constructor(readonly name: string) {}
        abstract area(): number;
        describe(): string {
            return this.name + ":" + this.area();
        }
        get kind(): string {
            return "shape";
        }
    }
    class Square extends Shape {
        constructor(readonly side: number) {
            super("square");
        }
        area(): number {
            return this.side * this.side;
        }
        get kind(): string {
            return "square";
        }
    }
    class Circle extends Shape {
        radius: number;
        constructor(radius: number) {
            super("circle");
            this.radius = radius;
        }
        area(): number {
            return 3 * this.radius * this.radius;
        }
    }
    class Unit extends Square {
        constructor() {
            super(1);
        }
        describe(): string {
            return "unit/" + super.describe();
        }
    }
    const shapes: Shape[] = [new Square(2), new Circle(1), new Unit()];
    let total = 0;
    const names: string[] = [];
    for (const shape of shapes) {
        total += shape.area();
        names.push(shape.describe());
        names.push(shape.kind);
    }
    if (total !== 4 + 3 + 1) throw new Error("total " + total);
    if (names.join(",") !== "square:4,square,circle:3,shape,unit/square:1,square") throw new Error("names " + names.join(","));
    let squares = 0;
    for (const shape of shapes) {
        if (shape instanceof Square) squares++;
    }
    if (squares !== 2) throw new Error("instanceof " + squares);
    const areas = shapes.map((shape) => shape.area());
    if (areas.join(",") !== "4,3,1") throw new Error("areas " + areas.join(","));
`,
);

check(
    "class-hierarchy-with-callbacks-and-containers",
    `
    abstract class Animal {
        static population = 0;
        protected energy = 10;
        readonly listeners: Array<(animal: Animal) => void> = [];
        constructor(readonly name: string) {
            Animal.population++;
        }
        abstract speak(): string;
        get tired(): boolean {
            return this.energy < 5;
        }
        set boost(amount: number) {
            this.energy += amount;
        }
        act(times: number): number {
            for (let index = 0; index < times; index++) this.energy -= this.cost();
            for (const listener of this.listeners) listener(this);
            return this.energy;
        }
        protected cost(): number {
            return 1;
        }
    }
    class Dog extends Animal {
        tricks: string[] = [];
        speak(): string {
            return this.name + " barks";
        }
        protected override cost(): number {
            return 2;
        }
        set boost(amount: number) {
            this.energy += amount * 2;
        }
    }
    class Cat extends Animal {
        lives = 9;
        speak(): string {
            return this.name + " meows x" + this.lives;
        }
        override get tired(): boolean {
            return false;
        }
    }
    class Kitten extends Cat {
        override speak(): string {
            return "tiny " + super.speak();
        }
    }
    const zoo = new Map<string, Animal>();
    const seen = new Set<Animal>();
    const heard: string[] = [];
    function adopt(animal: Animal): void {
        zoo.set(animal.name, animal);
        animal.listeners.push((who) => {
            seen.add(who);
            heard.push(who.speak());
        });
    }
    adopt(new Dog("rex"));
    adopt(new Cat("tom"));
    adopt(new Kitten("kit"));
    if (Animal.population !== 3) throw new Error("population " + Animal.population);
    const energies: number[] = [];
    zoo.forEach((animal) => {
        energies.push(animal.act(3));
    });
    if (energies.join(",") !== "4,7,7") throw new Error("energies " + energies.join(","));
    if (heard.join("|") !== "rex barks|tom meows x9|tiny kit meows x9") throw new Error("heard " + heard.join("|"));
    if (seen.size !== 3) throw new Error("seen");
    const tired = [...zoo.values()].filter((animal) => animal.tired).map((animal) => animal.name);
    if (tired.join(",") !== "rex") throw new Error("tired " + tired.join(","));
    for (const animal of zoo.values()) animal.boost = 3;
    const after = [...zoo.values()].map((animal) => animal.act(0));
    if (after.join(",") !== "10,10,10") throw new Error("boost " + after.join(","));
    const cats = [...zoo.values()].filter((animal) => animal instanceof Cat).length;
    if (cats !== 2) throw new Error("cats " + cats);
    const rex = zoo.get("rex");
    if (rex instanceof Dog) rex.tricks.push("sit");
    const dog = zoo.get("rex");
    if (!(dog instanceof Dog) || dog.tricks.length !== 1) throw new Error("narrowed subclass field");
    const sorted = [...zoo.values()].sort((left, right) => left.speak().length - right.speak().length).map((animal) => animal.name);
    if (sorted.join(",") !== "rex,tom,kit") throw new Error("sorted " + sorted.join(","));
`,
);

check(
    "class-setter-on-stored-instance",
    `
    class Part {
        energy = 1;
        set boost(amount: number) {
            this.energy += amount;
        }
    }
    const parts: Part[] = [new Part(), new Part()];
    for (const part of parts) part.boost = 2;
    if (parts[0]!.energy !== 3) throw new Error("setter");
`,
);

check(
    "class-static-fields-and-blocks",
    `
    const order: string[] = [];
    class Counter {
        static created = 0;
        static readonly limit = 3;
        static names: string[] = [];
        static last = "";
        static {
            order.push("block " + Counter.created);
            this.last = "init";
        }
        static tail = Counter.created + 10;
        readonly id: number;
        constructor(readonly name: string) {
            Counter.created += 1;
            this.id = Counter.created;
            Counter.names.push(name);
            Counter.last = name;
        }
        static reset(): void {
            this.created = 0;
            this.names = [];
        }
        static describe(): string {
            return this.last + "#" + this.created + "/" + Counter.limit;
        }
        tag(): string {
            return this.name + "@" + this.id + "of" + Counter.created;
        }
    }
    order.push("after class");
    if (order.join(",") !== "block 0,after class") throw new Error("static block order " + order.join(","));
    if (Counter.tail !== 10 || Counter.last !== "init") throw new Error("static initializers");
    const a = new Counter("a");
    const b = new Counter("b");
    if (Counter.created !== 2 || Counter.names.join(",") !== "a,b") throw new Error("shared statics");
    if (a.tag() !== "a@1of2" || b.tag() !== "b@2of2") throw new Error("instance reads statics");
    Counter.created++;
    Counter.created *= 2;
    if (Counter.describe() !== "b#6/3") throw new Error("static method this " + Counter.describe());
    Counter.reset();
    if (Counter.created !== 0 || Counter.names.length !== 0) throw new Error("static reset");
    class Registry {
        static count = 0;
        static register(): number {
            return ++this.count;
        }
    }
    class Special extends Registry {
        static label = "special";
        static make(): string {
            const seen = Special.count;
            const next = Registry.register();
            return this.label + seen + next;
        }
    }
    Registry.register();
    if (Special.count !== 1) throw new Error("inherited static read");
    if (Special.make() !== "special12") throw new Error("inherited static method " + Special.count);
    if (Registry.count !== 2) throw new Error("shared inherited storage");
    function makeLocal(start: number): number {
        class Local {
            static value = start;
            static { Local.value *= 2; }
        }
        Local.value += 1;
        return Local.value;
    }
    if (makeLocal(3) !== 7 || makeLocal(5) !== 11) throw new Error("local class statics");
`,
);

check(
    "class-static-class-typed-fields",
    `
    class Settings {
        static #instance: Settings | null = null;
        volume = 5;
        static get(): Settings {
            if (Settings.#instance === null) Settings.#instance = new Settings();
            return Settings.#instance;
        }
    }
    Settings.get().volume = 7;
    if (Settings.get().volume !== 7) throw new Error("singleton");
    class Pool {
        static items: number[] = [];
        static take(): number {
            return this.items.length > 0 ? this.items.pop()! : -1;
        }
    }
    Pool.items.push(3, 4);
    if (Pool.take() !== 4 || Pool.take() !== 3 || Pool.take() !== -1) throw new Error("pool");
`,
);

check(
    "class-private-brand-checks",
    `
    class Token {
        #value: number;
        static #issued = 0;
        constructor(value: number) {
            this.#value = value;
            Token.#issued++;
        }
        static isToken(candidate: object): boolean {
            return #value in candidate;
        }
        static isTokenClass(candidate: object): boolean {
            return #issued in candidate;
        }
        equals(other: Token | Other): boolean {
            return #value in other && other.#value === this.#value;
        }
    }
    class Derived extends Token {}
    class Other {
        value = 1;
    }
    const token = new Token(3);
    const derived = new Derived(3);
    const other = new Other();
    if (!Token.isToken(token) || !Token.isToken(derived) || Token.isToken(other)) throw new Error("instance brand");
    if (!token.equals(derived) || token.equals(other)) throw new Error("brand narrowing");
    const plain = { value: 1 };
    if (Token.isToken(plain)) throw new Error("plain object brand");
    if (!Token.isTokenClass(Token) || Token.isTokenClass(token)) throw new Error("static brand");
    if (Token.isTokenClass(Derived)) throw new Error("static brand is not inherited");
`,
);

check(
    "class-static-block-at-module-evaluation",
    `
    let hits = 0;
    class Counter {
        static readonly base = 2;
        static { hits = 5; }
        value(): number { return hits; }
    }
    class Unused { static { hits += 1; } }
    function main(): void {
        if (new Counter().value() !== 6 || Counter.base + hits !== 8) throw new Error("static blocks " + hits);
    }
    main();
`,
);

test("imported class static fields and blocks run when their module evaluates", async (t) => {
    const directory = resolve("artifacts/class-static-state-module");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "counter.ts"),
        `export class Counter {
            static count = 0;
            static readonly step = 2;
            static { Counter.count = 10; }
            static next(): number { this.count += Counter.step; return this.count; }
        }
        let evaluated = 0;
        class Unused { static { evaluated += 1; } }
        export function peek(): number { return Counter.count + evaluated * 100; }`,
    );
    const result = compileSource(
        `import { Counter, peek } from "./counter.js";
        if (Counter.next() !== 12 || peek() !== 112) throw new Error("imported statics " + peek());`,
        { fileName: join(directory, "entry.ts") },
    );
    await executeGeneratedAssertions(
        t,
        "class-static-state-module",
        result.cpp,
    );
});

test("class inheritance and static state refuse what one record or struct cannot represent", () => {
    const refusals: ReadonlyArray<readonly [string, RegExp]> = [
        [
            `class A { constructor(readonly x: number) {} }
            class B extends A { constructor(flag: boolean) { if (flag) { super(1); } else { super(2); } } }
            const b = new B(true); const unused = b.x;`,
            /super\(\.\.\.\) is lowered as a top-level statement/,
        ],
        [
            `class A { static count = 0; }
            class B extends A {}
            B.count++;`,
            /Static field 'count' is inherited by class 'B'/,
        ],
        [
            `class A { static count = 0; static bump(): void { this.count += 1; } }
            class B extends A {}
            B.bump();`,
            /Static field 'count' is inherited by class 'B'/,
        ],
        [
            `class Box<T> { constructor(readonly value: T) {} }
            class NumberBox extends Box<number> {}
            const boxes: Box<number>[] = [new NumberBox(1)];
            const unused = boxes.length;`,
            /is generic; a stored instance of a hierarchy needs one layout/,
        ],
        [
            `abstract class A {}
            class B extends A { tag = 1; }
            class C extends A { tag = "x"; }
            const all: A[] = [new B(), new C()];
            const unused = all.length;`,
            /Field 'tag' has a different native type in class 'C'/,
        ],
        [
            `class Failure extends Error { constructor() { super("x"); } }
            const failure = new Failure(); const unused = failure.message;`,
            /extends 'Error', which is not a local class with a body/,
        ],
        [
            `class A { #x = 1; readA(): number { return this.#x; } }
            class B extends A { #x = 2; readB(): number { return this.#x; } }
            const b = new B(); const unused = b.readA() + b.readB();`,
            /Private name '#x' is declared by both 'A' and 'B'/,
        ],
        [
            `class TreeNode {
                children: TreeNode[] = [];
                constructor(readonly value: number) {}
                sum(): number { let total = this.value; for (const child of this.children) total += child.sum(); return total; }
            }
            const root = new TreeNode(1); root.children.push(new TreeNode(2));
            const unused = root.sum();`,
            /calls itself on another stored instance/,
        ],
        [
            `class A { value = 1; }
            class B extends A { value!: number; }
            const b = new B(); const unused = b.value;`,
            /redeclares an inherited field without an initializer/,
        ],
        [
            `class A { value = 1; }
            class B extends A { read(): number { return super.value; } }
            const b = new B(); const unused = b.read();`,
            /'super\.value' reads a base class accessor/,
        ],
    ];
    for (const [source, message] of refusals) {
        assert.throws(() => compileSource(source), message);
    }
});

test("promise rejection callbacks refuse parameters the rejection cannot supply", () => {
    assert.throws(
        () =>
            compileSource(`
        let calm = 0;
        async function risky(): Promise<void> { calm++; }
        void risky().catch((error, extra) => { if (error || extra) calm++; });
    `),
        /declares more parameters than the operation supplies/,
    );
});
