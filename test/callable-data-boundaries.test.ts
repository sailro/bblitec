import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function checkNative(t: test.TestContext, name: string, source: string): void {
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(
        result.manifest.features.includes("data:json"),
    );
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        `callable-data-boundaries/${name}`,
        result.cpp,
        { timeoutMs: 10000 },
    );
}

test("contextual optional methods retain omission, explicit undefined and defaults", (t) =>
    checkNative(
        t,
        "contextual-optional",
        `
    interface Visitor { visit(value?: number): number; }
    function create(): Visitor {
        let total = 0;
        return {visit(value) { total += value === undefined ? 1 : value; return total; }};
    }
    const visitor = create();
    if(visitor.visit()!==1 || visitor.visit(undefined)!==2 || visitor.visit(4)!==6) throw new Error("contextual omission");
    let defaults = 0;
    function makeDefault(): number { defaults++; return 7; }
    const fallback: Visitor = {visit(value = makeDefault()) { return value; }};
    if(fallback.visit()!==7 || fallback.visit(undefined)!==7 || fallback.visit(2)!==2 || defaults!==2) throw new Error("default evaluation");
    const callbacks: Array<(value?: number) => number> = [value => value === undefined ? 3 : value];
    if(callbacks[0]!()!==3 || callbacks[0]!(8)!==8) throw new Error("stored contextual callable");
    const pair: {sum(first?:number,last?:number):number} = {sum(first=3,last){return first+(last??4);}};
    if(pair.sum()!==7 || pair.sum(undefined,8)!==11) throw new Error("default before contextual optional");
`,
    ));

test("required parameters remain required through direct call validation", () => {
    assert.throws(
        () =>
            compileSource(
                `function read(value: number | undefined): number {return value ?? 1;} read();`,
            ),
        /requires argument 'value'/,
    );
});

test("ArrayBuffer.isView distinguishes binary views, unions and effectful nonviews", (t) =>
    checkNative(
        t,
        "binary-predicate",
        `
    const bytes = new Uint8Array([1,2,3,4]);
    const buffer = bytes.buffer;
    if(!ArrayBuffer.isView(bytes) || !ArrayBuffer.isView(new DataView(buffer)) || ArrayBuffer.isView(buffer)) throw new Error("binary classes");
    if(!ArrayBuffer.isView(new Int8Array(1)) || !ArrayBuffer.isView(new Int16Array(1)) || !ArrayBuffer.isView(new Uint16Array(1)) || !ArrayBuffer.isView(new Int32Array(1)) || !ArrayBuffer.isView(new Uint32Array(1)) || !ArrayBuffer.isView(new Float32Array(1)) || !ArrayBuffer.isView(new Float64Array(1))) throw new Error("typed views");
    let effects = 0;
    function scalar(): number { effects++; return 3; }
    function view(): Uint8Array { effects++; return bytes; }
    if(ArrayBuffer.isView(scalar()) || !ArrayBuffer.isView(view()) || effects!==2) throw new Error("operand effects");
    if(ArrayBuffer.isView(null) || ArrayBuffer.isView(undefined) || ArrayBuffer.isView([1,2]) || ArrayBuffer.isView({length:2})) throw new Error("nonviews");
    const values: (Uint8Array | number)[] = [bytes, 2];
    let matched = 0;
    for(const value of values) if(ArrayBuffer.isView(value)) matched++;
    if(matched!==1) throw new Error("finite union");
    const optional: (Uint8Array | undefined)[] = [bytes, undefined];
    for(const value of optional) if(ArrayBuffer.isView(value)) matched++;
    if(matched!==2) throw new Error("optional view");
    function count(values: readonly unknown[]): number {
        let result=0;
        for(const value of values) if(ArrayBuffer.isView(value) && !(value instanceof DataView)) result+=value.byteLength;
        return result;
    }
    if(count([null,2,bytes,new DataView(buffer),buffer,[1,2]])!==4) throw new Error("unknown array view guard");
    function absent(): void {effects++;}
    if(ArrayBuffer.isView(absent()) || effects!==3) throw new Error("void operand effects");
    function shadowed(): boolean { const ArrayBuffer = {isView(value:number) {return value===3;}}; return ArrayBuffer.isView(3); }
    if(!shadowed()) throw new Error("authored predicate");
`,
    ));

test("numeric ArrayLike calls retain typed view aliases and callback writes", (t) =>
    checkNative(
        t,
        "typed-array-like",
        `
    function sum(values: ArrayLike<number>): number { let total=0; for(let i=0;i<values.length;i++) total+=values[i]??0; return total; }
    if(sum(new Uint8Array([1,2]))!==3 || sum(new Int8Array([-1,2]))!==1 || sum(new Uint16Array([300,4]))!==304 || sum(new Int16Array([-300,4]))!==-296 || sum(new Uint32Array([70000,4]))!==70004 || sum(new Int32Array([-70000,4]))!==-69996 || sum(new Float32Array([1.5,2.5]))!==4 || sum(new Float64Array([1.25,2.5]))!==3.75) throw new Error("numeric lanes");
    const owner = new Uint8Array([2,3,4,5]);
    const subview = new Uint8Array(owner.buffer,1,2);
    if(sum(subview)!==7) throw new Error("buffer view offset");
    function observe(values: ArrayLike<number>, mutate: () => void): number { const first = values[0]??0; mutate(); return first + (values[1]??0); }
    if(observe(subview, () => {owner[2]=9;})!==12 || subview[1]!==9) throw new Error("live mutation");
    function reader(values: ArrayLike<number>): () => number { return () => values[0]??0; }
    const read = reader(subview); owner[1]=11;
    if(read()!==11) throw new Error("retained view");
`,
    ));

test("guarded optional arrays and captured nullable scalars keep their narrowed arguments", (t) =>
    checkNative(
        t,
        "optional-arguments",
        `
    function sum(values: readonly number[]): number {let total=0;for(const value of values)total+=value;return total;}
    function totals(groups: readonly (readonly number[] | undefined)[]): number {let result=0;for(const group of groups)if(group)result+=sum(group);return result;}
    if(totals([[1,2],undefined,[4]])!==7) throw new Error("guarded array");
    type Hooks<Input, T> = { select(value:Input): T|null; compare(value:Input, selected:T): boolean; };
    function selected<Input, T>(values: readonly Input[], input:Input, hooks: Hooks<Input, T>): Input[] | null {
        const value = hooks.select(input);
        if(value===null) return null;
        return values.filter(item => hooks.compare(item, value));
    }
    type Item = {value:number};
    const items: Item[] = [{value:1},{value:2},{value:3}];
    const hooks: Hooks<Item, number> = {select: item=>item.value<0?null:item.value, compare:(item,value)=>item.value===value};
    const output = selected(items, {value:2}, hooks);
    if(!output || output.length!==1 || output[0]!==items[1]) throw new Error("captured narrowed scalar");
    if(selected(items, {value:-1}, hooks)!==null) throw new Error("absent scalar");
    function afterNull<T>(value:T|null, read:(present:T)=>number):number {if(value===null)return -1;return read(value);}
    function afterUndefined<T>(value:T|undefined, read:(present:T)=>number):number {if(value===undefined)return -1;return read(value);}
    const nullable = (value:number|null):number => value===null?9:value;
    const optional = (value:number|undefined):number => value===undefined?8:value;
    if(afterUndefined<number|null>(null,nullable)!==9 || afterUndefined<number|null>(2,nullable)!==2) throw new Error("remaining null");
    if(afterNull<number|undefined>(undefined,optional)!==8 || afterNull<number|undefined>(3,optional)!==3) throw new Error("remaining undefined");
`,
    ));
