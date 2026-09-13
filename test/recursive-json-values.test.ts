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

test("recursive unknown boundaries retain parsed trees and returned scalar kinds", t => {
    nativeCheck("trees", `
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
