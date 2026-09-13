import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

function nativeCheck(name: string, source: string, t: test.TestContext): void {
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/recursive-json-values", name);
    mkdirSync(directory, {recursive: true});
    const cpp = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/I${nativeFixtureVcpkgRoot}/include`, `/Fo:${directory}/`, `/Fe:${executable}`, cpp]);
    assert.equal(execFileSync(executable, {encoding: "utf8", timeout: 10000}), "");
}

test("typed arrays and tuples retain live storage across dynamic calls", t => {
    nativeCheck("typed-arrays", `
        function retain(value:unknown,depth:number):unknown { return depth>0 ? retain(value,depth-1) : value; }
        const values:number[]=[1,2];
        const boxed=retain(values,1);
        values.push(3);
        if(!Array.isArray(boxed)||boxed.length!==3||boxed[2]!==3||boxed!==retain(values,2)) throw new Error("array identity");
        const rows:Array<{size:number}>=[{size:1}];
        const records=retain(rows,1);
        rows[0]!.size=2;
        if((records as Array<{size:number}>)[0]!.size!==2) throw new Error("record element alias");
        const row:[number,string]=[1,"before"];
        const mixed=retain(row,1);
        row[1]="after";
        if((mixed as unknown[])[1]!=="after") throw new Error("tuple alias");
        const config={color:[0.2,0.4,0.6] as const, nested:[{size:1}] as const, empty:{}};
        const defaults=retain(config,1) as {color:unknown[],nested:Array<{size:number}>};
        if(defaults.color!==defaults.color || defaults.color.length!==3 || defaults.color[1]!==0.4)
            throw new Error("fixed tuple identity");
        config.nested[0].size=4;
        if(defaults.nested[0]!.size!==4) throw new Error("tuple nested record alias");
        const names=Object.keys(defaults);names.push("extra");
        if(Object.keys(defaults).length!==3) throw new Error("own keys snapshot");
        let count=0;
        for(const entry of boxed) { count++; if(entry===1) values.push(4); }
        if(count!==4) throw new Error("live iteration length");
        const filtered=boxed.filter(value=>value!==2);
        if(filtered.length!==3||filtered[2]!==4) throw new Error("typed array filter");
        const nested=retain([[1,2],[3]],1);
        if(!Array.isArray(nested)||nested.flat().length!==3) throw new Error("typed array flatten");
    `, t);
});

test("native exhaustive switch helpers compile with defined fallthrough", t => {
    nativeCheck("exhaustive-switch", `
        type Kind="first"|"second";
        export function select(kind:Kind):number {switch(kind) {case "first":return 3;case "second":return 7;}}
        const keys:Kind[]=["first","second"];
        let result=0;for(const key of keys)result+=select(key);
        if(result!==10)throw new Error("exhaustive switch");
    `, t);
});

test("dynamic array views refuse ambiguous absence and Map object entries", () => {
    const retain = `function retain(value:unknown,depth:number):unknown {return depth>0 ? retain(value,depth-1) : value;}`;
    assert.throws(() => compileSource(retain + `const row:[number|null,string]=[null,"text"];const boxed=retain(row,1);row[1]="after";`),
        /does not match the expected data json/);
    assert.throws(() => compileSource(retain + `const rows:Array<{items:Map<string,number>}>= [{items:new Map([["first",1]])}];retain(rows,1);`),
        /no retained value view for map/);
});

test("dynamic object spread copies outer properties and retains nested identity", t => {
    nativeCheck("dynamic-spread", `
        function plain(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
        function merge<T>(base:T,source:unknown):T{
            if(!plain(base)||!plain(source))return source===undefined?base:source as T;
            const result:Record<string,unknown>={...(base as unknown as Record<string,unknown>)};
            for(const key of Object.keys(source))result[key]=plain(result[key])?merge(result[key],source[key]):source[key];
            return result as unknown as T;
        }
        const base:unknown=JSON.parse('{"branch":{"size":1},"keep":{"value":2}}');
        const result=merge(base,JSON.parse('{"branch":{"size":3}}')) as Record<string,unknown>;
        if((result.branch as {size:number}).size!==3||result.keep!==(base as Record<string,unknown>).keep||result===base)
            throw new Error("merge identity");
        const copy:Record<string,unknown>={...(base as Record<string,unknown>),extra:4};
        copy.branch=2;
        if((base as {branch:{size:number}}).branch.size!==1||copy.extra!==4||copy.missing!==undefined||copy['missing']!==undefined)
            throw new Error("fresh root and missing keys");
        function spread(value:unknown,depth:number):unknown {
            if(depth>0)return spread(value,depth-1);
            return {before:1,...(value as Record<string,unknown>),after:2};
        }
        for(const value of JSON.parse('[null,false,4]'))if(Object.keys(spread(value,1) as object).join(',')!=="before,after")
            throw new Error("primitive spread");
        const array=spread(JSON.parse('[3,4]'),1) as Record<string,unknown>;
        if(array[0]!==3||Object.keys(array).join(',')!=="0,1,before,after")throw new Error("array spread");
        const text=spread("ab",1) as Record<string,unknown>;
        if(text[0]!=="a"||text[1]!=="b")throw new Error("string spread");
        if(Object.keys(spread(undefined,1) as object).join(',')!=="before,after")throw new Error("undefined spread");
        const ordered=spread(JSON.parse('{"after":8,"before":9,"middle":3}'),1) as Record<string,unknown>;
        if(ordered.before!==9||ordered.after!==2||Object.keys(ordered).join(',')!=="before,after,middle")
            throw new Error("overwrite order");
        let effects=0;
        function source():unknown {effects++;return base;}
        const once={...(source() as Record<string,unknown>),extra:effects};
        if(effects!==1||once.extra!==1)throw new Error("spread effects");
    `, t);
});

test("recursive unknown boundaries retain parsed trees and returned scalar kinds", t => {
    nativeCheck("trees", `
        function retain<T>(value:T, depth:number):T {return depth>0 ? retain(value,depth-1) : value;}
        const count = (value: unknown): number => {
            if(Array.isArray(value)) { let sum=0; for(const child of value) sum+=count(child); return sum; }
            return 1;
        };
        function named(value: unknown): number {
            if(Array.isArray(value)) { let sum=0; for(const child of value) sum+=named(child); return sum; }
            return 1;
        }
        const array = (values: readonly unknown[]): number => {
            let sum=0; for(const child of values) sum+=Array.isArray(child) ? array(child) : 1; return sum;
        };
        function first(value: unknown): unknown {
            if(Array.isArray(value)) return first(value[0]);
            if(value === null) return "empty";
            return value;
        }
        const tree: unknown = JSON.parse('[1,[2,[3,4]],5]');
        if(retain<unknown>(tree,2)!==tree)throw new Error("generic dynamic identity");
        if(count(tree)!==5 || named(tree)!==5 || array(tree as unknown[])!==5)
            throw new Error("recursive tree visits");
        if(first(JSON.parse('[[3]]'))!==3 || first(JSON.parse('[[true]]'))!==true ||
            first(JSON.parse('[[null]]'))!=="empty") throw new Error("dynamic recursive return");
    `, t);
});

test("dynamic recursion retains native object views, array aliases and builtin callbacks", t => {
    nativeCheck("views", `
        class Packet {
            constructor(public label: string, public items: readonly unknown[]) {}
        }
        function check(seed: unknown, depth: number): number {
            if (depth > 0) return check(seed, depth - 1);
            const isArray = Array.isArray;
            const callbacks = [Array.isArray];
            if (callbacks[0] !== isArray || !callbacks[0]!(seed) || callbacks[0]!(3))
                throw new Error("builtin identity and invocation");
            const dictionary: Record<string, unknown> = {};
            dictionary.first = seed;
            dictionary.label = "before";
            const erased: unknown = dictionary;
            dictionary.label = "after";
            const record = erased as Record<string, unknown>;
            if (record.label !== "after" || record.first !== seed || !("label" in record) ||
                !Object.hasOwn(record, "first") || Object.hasOwn(record, "toString"))
                throw new Error("live dictionary view");
            const values: unknown[] = JSON.parse('[1,[2,[3]],4]');
            const alias: unknown = values;
            values.push(5);
            if (JSON.stringify(alias) !== '[1,[2,[3]],4,5]') throw new Error("array alias");
            if (JSON.stringify(values.flat()) !== '[1,2,[3],4,5]' ||
                JSON.stringify(values.flat(0)) !== '[1,[2,[3]],4,5]' ||
                JSON.stringify(values.flat(Infinity)) !== '[1,2,3,4,5]') throw new Error("dynamic flat");
            const packet = new Packet("before", values);
            const boxed: unknown = packet;
            packet.label = "after";
            if (!(boxed instanceof Packet) || boxed.label !== "after" || boxed.items.length !== 4 ||
                !Object.hasOwn(boxed, "items")) throw new Error("live class view");
            return 1;
        }
        if (check(JSON.parse('[true]'), 2) !== 1) throw new Error("recursive result");
    `, t);
});

test("recursive groups inside stored callbacks retain branch laziness and captures", t => {
    nativeCheck("groups", `
        const visit = (source: unknown): number => {
            const visited: number[] = [];
            const walk = (value: unknown): void => {
                if (Array.isArray(value)) { walkArray(value); return; }
                const names = typeof value === "object" && value !== null
                    ? new Set(Object.keys(value).sort()) : new Set(["leaf"]);
                visited.push(names.size);
            };
            const walkArray = (values: readonly unknown[]): void => {
                for (const value of values) walk(value);
            };
            walk(source);
            return visited.length;
        };
        const callbacks = [visit];
        if (callbacks[0]!(JSON.parse('[1,[2,{"b":3,"a":4}]]')) !== 3)
            throw new Error("mutual recursion and lazy set construction");
    `, t);
});

test("default array sorting uses UTF-16 text order and comparator ties stay stable", t => {
    nativeCheck("sorting", `
        const words: string[] = ["\\uE000", "\\u{10000}", "z", "a"];
        const same = words.sort();
        if (same !== words || words.join(",") !== "a,z,\\u{10000},\\uE000") throw new Error("UTF-16 order");
        const numbers = [2, 10, -1, 1];
        numbers.sort();
        if (numbers.join(",") !== "-1,1,10,2") throw new Error("numeric text order");
        const records: Array<{group: number; index: number}> = [];
        for (let index=0; index<32; index++) records.push({group:index%2,index});
        records.sort((left,right)=>left.group-right.group);
        for(let index=0;index<16;index++) {
            if(records[index]!.index!==index*2 || records[index+16]!.index!==index*2+1)
                throw new Error("stable comparator ties");
        }
    `, t);
});

test("typed dictionaries retain scalar, enum and record aliases through dynamic boundaries", t => {
    nativeCheck("typed-dictionaries", `
        function retain(value: unknown, depth: number): unknown {
            return depth > 0 ? retain(value, depth - 1) : value;
        }
        const numbers: Record<string, number> = {first: 1};
        const boxedNumbers = retain(numbers, 1) as Record<string, unknown>;
        numbers.first = 2;
        numbers.second = 3;
        if (boxedNumbers.first !== 2 || Object.keys(boxedNumbers).length !== 2 ||
            retain(numbers, 1) !== boxedNumbers) throw new Error("number dictionary alias");
        const tags: Record<string, "open" | "closed"> = {first: "open"};
        const boxedTags = retain(tags, 1) as Record<string, unknown>;
        tags.first = "closed";
        if (boxedTags.first !== "closed") throw new Error("enum dictionary alias");
        const records: Record<string, {size: number}> = {first: {size: 1}};
        const boxedRecords = retain(records, 1) as Record<string, unknown>;
        records.first!.size = 3;
        if ((boxedRecords.first as {size: number}).size !== 3)
            throw new Error("record dictionary alias");
        function retainTyped(value: {nested: {size: number}}, depth: number): unknown {
            return depth > 0 ? retainTyped(value, depth - 1) : value;
        }
        const typed = {nested: {size: 5}};
        const first = retainTyped(typed, 1);
        typed.nested.size = 7;
        if (first !== retainTyped(typed, 1) || (first as {nested:{size:number}}).nested.size !== 7)
            throw new Error("captured record keeps caller storage and identity");
    `, t);
});
