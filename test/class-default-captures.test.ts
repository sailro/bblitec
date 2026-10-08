import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const source = `
    let defaults = 0, reads = 0;
    function fallback(): number { defaults++; return 7; }
    class Receiver {
        base = 10;
        pick(value = fallback()): () => number {
            const read = () => value;
            value += 1;
            return read;
        }
        ordered(first = this.base, second = first + 1): () => number {
            const read = () => first * 100 + second;
            first++;
            return read;
        }
        nullable(value: number | null = fallback()): () => number | null {
            const read = () => value;
            return read;
        }
    }
    const rows: Array<{value?: number}> = [{}, {value: 3}];
    const receiver = new Receiver();
    function argument(index: number): number | undefined { reads++; return rows[index]!.value; }
    const first = receiver.pick(argument(0)), second = receiver.pick(argument(1));
    rows[1]!.value = 20;
    if (first() !== 8 || second() !== 4 || defaults !== 1 || reads !== 2)
        throw new Error('defaulted captured argument values');
    const missing: [number?, number?] = [];
    const provided: [number?, number?] = [2, 5];
    if (receiver.ordered(...missing)() !== 1111 || receiver.ordered(...provided)() !== 305)
        throw new Error('spread defaults and earlier parameter');
    if (receiver.nullable(null)() !== null || defaults !== 1)
        throw new Error('null does not take a default');
    const after = receiver.ordered(undefined, (() => { receiver.base = 30; return 4; })());
    if (after() !== 3104) throw new Error('all arguments precede defaults');

    let documentDefaults = 0, documentReads = 0, order = '';
    function documentFallback(): number { documentDefaults++; order += 'd'; return 11; }
    const document = JSON.parse('{"present":3,"empty":null}') as {
        missing?: number; present?: number; empty?: number | null;
    };
    function input(): number | undefined { documentReads++; order += 'a'; return document.missing; }
    function later(): number { order += 'b'; return 2; }
    class Box {
        constructor(public value: number | null = documentFallback(), extra = 0) { value; extra; }
        choose(value: number | null = documentFallback(), extra = 0): () => number | null {
            extra; return () => value;
        }
    }
    function choose(value: number | null = documentFallback(), extra = 0): number | null { extra; return value; }
    const box = new Box(input(), later());
    if (box.value !== 11 || order !== 'abd') throw new Error('document constructor default order');
    order = '';
    const read = box.choose(input(), later());
    if (read() !== 11 || order !== 'abd') throw new Error('document captured method default order');
    order = '';
    if (choose(input(), later()) !== 11 || order !== 'abd') throw new Error('document function default order');
    const present = new Box(document.present), empty = new Box(document.empty);
    if (present.value !== 3 || empty.value !== null || box.choose(document.empty)() !== null ||
        choose(document.present) !== 3 || documentDefaults !== 3 || documentReads !== 3)
        throw new Error('document null and present values keep their argument');
`;

test("class defaults preserve undefined until the callee binds captured parameters", () => {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    compileSource(source);
});

test(
    "native class defaults preserve captures, null and argument evaluation order",
    { skip: !optionalNativeFixtureTools() },
    () => {
        runGeneratedProgram(
            optionalNativeFixtureTools()!,
            "class-default-captures",
            compileSource(source).cpp,
        );
    },
);

test("retained array defaults keep fresh owners, aliases and initializer order", () => {
    const arrays = `
        interface Row { value:number; }
        class Holder {
            values:readonly Row[]=[];
            saved:readonly Row[]=[];
            set(values:readonly Row[]=[], alias=values):void {
                this.values=values; this.saved=alias;
            }
            set reset(value:number) { value; this.set(); }
        }
        const first=new Holder(),second=new Holder();
        first.set(); second.set(undefined);
        if(first.values!==first.saved || second.values!==second.saved || first.values===second.values)
            throw Error('fresh default owner');
        const supplied:Row[]=[{value:3}];
        first.set(supplied);
        if(first.values!==supplied || first.saved!==supplied)throw Error('supplied alias');
        supplied.push({value:4}); supplied[0]!.value=8;
        if(first.values.length!==2 || first.saved[0]!.value!==8)throw Error('retained writes');
        const previous=second.values;
        second.reset=1;
        if(previous===second.values || second.values!==second.saved)throw Error('setter default');

        class Constructed { constructor(public values:readonly Row[]=[]) {} }
        const built1=new Constructed(),built2=new Constructed(undefined),built3=new Constructed(supplied);
        if(built1.values===built2.values || built3.values!==supplied)throw Error('constructor owners');
        function capture(values:readonly Row[]=[],alias=values):()=>readonly Row[] {
            if(values!==alias)throw Error('function default alias');
            return()=>values;
        }
        const read1=capture(),read2=capture(),read3=capture(supplied);
        if(read1()===read2() || read3()!==supplied)throw Error('captured default owner');

        let order='',created=0;
        function missing():undefined {order+='a';return undefined;}
        function later():number {order+='b';return 1;}
        function makeRow():Row {order+='d';created++;return {value:created};}
        class LiteralDefaults {
            values:readonly Row[]=[];
            saved:readonly Row[]=[];
            set(values:readonly Row[]=[makeRow()],alias=values,last=0):void {
                last; this.values=values; this.saved=alias;
            }
        }
        const literal1=new LiteralDefaults(),literal2=new LiteralDefaults();
        literal1.set(missing(),undefined,later());
        literal2.set();
        if(order!=='abdd' || created!==2 || literal1.values===literal2.values ||
            literal1.values[0]===literal2.values[0] || literal1.values!==literal1.saved ||
            literal2.values!==literal2.saved || literal1.saved[0]!.value!==1)
            throw Error('literal default once and in order');
        const row=literal1.saved[0]!; row.value=9;
        if(literal1.values[0]!.value!==9)throw Error('literal row alias');
        literal1.set(supplied);
        if(order!=='abdd' || created!==2 || literal1.values!==supplied || literal1.saved!==supplied)
            throw Error('supplied argument skips literal initializer');
    `;
    runInNewContext(
        ts.transpileModule(arrays, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(arrays);
    const tools = optionalNativeFixtureTools();
    if (tools)
        runGeneratedProgram(tools, "class-default-array-retention", result.cpp);
});

test("default array ownership does not admit retention of borrowed arguments", () => {
    for (const body of [
        `const saved:Array<readonly Item[]>=[];
         const stores:Array<(items:ArrayLike<Item>)=>void>=[items=>saved.push(items as readonly Item[])];`,
        `const saved:Array<{items:readonly Item[]}>=[];
         const stores:Array<(items:ArrayLike<Item>)=>void>=[items=>saved.push({items:items as readonly Item[]})];`,
    ])
        assert.throws(
            () =>
                compileSource(`interface Item {value:number;}
                    ${body} stores[0]!([{value:1}]);`),
            /A borrowed array view cannot retain JavaScript array identity in owning storage/,
        );
});
