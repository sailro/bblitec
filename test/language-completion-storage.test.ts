import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { doubleCpp, doubleLiteral } from "../src/cpp-literals.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, async (t) => {
        await (runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        ) as unknown);
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `language-completion-storage/${name}`,
            result.cpp,
        );
    });
}

test("double literals preserve both zero signs", () => {
    for (const spell of [doubleLiteral, doubleCpp]) {
        assert.equal(spell(-0), "-0.0");
        assert.equal(spell(0), "0.0");
        for (const value of [-0, 0, -1, 1, 1e21, 1e-21, Number.MIN_VALUE])
            assert.ok(Object.is(Number(spell(value)), value));
    }
});

test("synchronous async lowering refuses custom thenable completion", () => {
    for (const program of [
        `async function f(){return {then(resolve:(n:number)=>void){resolve(3);}};} f();`,
        `async function f(){return {then: (resolve:(n:number)=>void)=>resolve(3)};} f();`,
        `async function f(){return {then(resolve:(n:string)=>void){resolve('value');}};} f();`,
        `const callbacks=[async ()=>({then(resolve:(n:number)=>void){resolve(3);}})]; callbacks[0]!();`,
        `async function f(n:number){if(n>0)return {then(resolve:(n:number)=>void){resolve(n);}};return 0;} f(1);`,
        `async function f(){return {get then(){return 3;}};} f();`,
        `async function f(){return ({then(resolve:(n:number)=>void){resolve(3);}} as unknown as number);} f();`,
        `const callbacks=[async ()=>({then(resolve:(n:number)=>void){resolve(3);}} as unknown as number)]; callbacks[0]!();`,
        `const value={then(resolve:(n:number)=>void){resolve(3);}} as {}; async function f(){return value;} f();`,
        `const value={get then(){throw new Error('read');}} as {}; async function f(){return value;} f();`,
        `function receive(value:{}){async function f(){return value;}f();} receive({then(resolve:(n:number)=>void){resolve(3);}});`,
    ])
        assert.throws(() => compileSource(program), /thenable assimilation/);
    const thenable = `({then(resolve:(n:number)=>void){resolve(3);}} as unknown as number)`;
    for (const expression of [
        `true ? ${thenable} : 3`,
        `(3, ${thenable})`,
        `true && ${thenable}`,
        `false || ${thenable}`,
        `undefined ?? ${thenable}`,
    ])
        assert.throws(
            () => compileSource(`(async () => { return ${expression}; })();`),
            /thenable assimilation/,
        );
    for (const expression of [
        `void ${thenable}`,
        `(${thenable}, 3)`,
        `${thenable} && 3`,
    ])
        assert.doesNotThrow(() =>
            compileSource(`(async () => { return ${expression}; })();`),
        );
});

test("void comparisons refuse an erased non-undefined completion", () => {
    assert.throws(
        () =>
            compileSource(`
                const callback: () => void = () => 5;
                if ((callback() as unknown as number) === 5) throw new Error('observed');
            `),
        /proven undefined completion/,
    );
});

check(
    "plain-then-fields-remain-ordinary-async-results",
    `
    async function create() { return {then: 3, value: 7}; }
    async function run() {
        const result = await create();
        if (result.then !== 3 || result.value !== 7) throw new Error('plain then field');
        async function refined() { return Promise.resolve(3) as Promise<number> & {optional?: number}; }
        if (await refined() !== 3) throw new Error('refined native promise');
    }
    run();
    `,
);

check(
    "stored-callback-record-parameters-share-identity",
    `
    interface Point { x: number; }
    const p: Point = {x: 1};
    const q: Point = {x: 1};
    const callbacks: ((a: Point, b: Point) => void)[] = [(a, b) => {
        a.x = 7;
        if (b.x !== 7 || a !== b) throw new Error('parameter aliases');
        a = {x: 11};
        if (a === b || b.x !== 7) throw new Error('parameter rebinding');
    }];
    callbacks[0]!(p, p);
    if (p.x !== 7 || q.x !== 1 || p === q) throw new Error('caller aliases');
    `,
);

check(
    "stored-callback-optional-record-parameters-retain-the-caller",
    `
    interface Point { x: number; }
    const p: Point = {x: 2};
    const saved: (() => number)[] = [];
    const callbacks: ((a?: Point, b?: Point) => void)[] = [(a, b) => {
        if (!a || !b) return;
        saved.push(() => a.x);
        a.x = 9;
        if (a !== b || b.x !== 9) throw new Error('optional aliases');
    }];
    callbacks[0]!(p, p);
    callbacks[0]!();
    p.x = 12;
    if (saved.length !== 1 || saved[0]!() !== 12) throw new Error('retained alias');
    const defaults: ((a?: Point) => () => number)[] = [(a = {x: 3}) => () => a.x];
    const fromCaller = defaults[0]!(p);
    const fromDefault = defaults[0]!();
    p.x = 15;
    if (fromCaller() !== 15 || fromDefault() !== 3) throw new Error('defaulted parameter');
    `,
);

check(
    "type-predicate-filter-narrows-mixed-array-storage",
    `
    const values: (number | string | boolean)[] = [1, 'a', false, 2, 'b', true];
    let calls = 0;
    const numbers = values.filter((value): value is number => { calls++; return typeof value === 'number'; });
    if (numbers.join() !== '1,2' || calls !== 6) throw new Error('number filter');
    const text = values.filter((value): value is string => typeof value === 'string');
    if (text.join() !== 'a,b') throw new Error('string filter');
    const mixed = values.filter((value): value is number | boolean => typeof value !== 'string');
    if (mixed.length !== 4 || mixed[0] !== 1 || mixed[1] !== false || mixed[3] !== true) throw new Error('union filter');
    numbers.push(3);
    if (values.length !== 6) throw new Error('filter owns a new array');
    `,
);

check(
    "type-predicate-filter-narrows-parsed-array-values",
    `
    function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
    const parsed: unknown = JSON.parse('[1,"a",null,2,false]');
    if (Array.isArray(parsed)) {
        const numbers = parsed.filter(isNumber);
        const records = numbers.map((value) => ({value, doubled: value * 2}));
        if (numbers.join() !== '1,2' || records[1]!.doubled !== 4) throw new Error('parsed predicate');
    } else throw new Error('array');
    `,
);

check(
    "void-comparisons-preserve-completion-and-evaluation-order",
    `
    let effects = '';
    function complete(): void { effects += 'v'; }
    function number(): number { effects += 'n'; return 3; }
    function absent(): number | undefined { effects += 'u'; return undefined; }
    if ((complete() as unknown as number) === number()) throw new Error('undefined is not a number');
    if (effects !== 'vn') throw new Error('left before right');
    effects = '';
    if (number() === (complete() as unknown as number)) throw new Error('number is not undefined');
    if (effects !== 'nv') throw new Error('right after left');
    effects = '';
    if ((complete() as unknown as number) !== absent()) throw new Error('undefined completion');
    if (effects !== 'vu') throw new Error('optional operand');
    effects = '';
    if ((complete() as unknown as number) !== (complete() as unknown as number)) throw new Error('same completion');
    if (effects !== 'vv') throw new Error('both completions');
    if ((complete() as unknown) === null || null === (complete() as unknown)) throw new Error('null differs strictly');
    if ((complete() as unknown) != null || null != (complete() as unknown)) throw new Error('null matches loosely');
    effects = '';
    if (false && (complete() as unknown as number) === 3) throw new Error('unreachable');
    if (effects !== '') throw new Error('short circuit');
    `,
);
