import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { GenericFunctionStorage } from "../src/compiler/generic-function-storage.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("alpha-equivalent generic callback families require exact schemas", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        interface Item { value:number; }
        interface WiderItem { value:number; extra?:string; }
        type Base = <T>(radius:number, callback:()=>T)=>T;
        type Renamed = <U>(amount:number, action:()=>U)=>U;
        type Optional = <T>(radius:number, callback?:()=>T)=>T;
        type Extra = <T>(radius:number, callback:()=>T, extra?:number)=>T;
        type Rest = <T>(radius:number, ...callback:Array<()=>T>)=>T;
        type Receiver = <T>(this:Item, radius:number, callback:()=>T)=>T;
        type Constraint = <T extends string>(radius:number, callback:()=>T)=>T;
        type ConstraintRenamed = <U extends string>(radius:number, callback:()=>U)=>U;
        type OtherConstraint = <T extends number>(radius:number, callback:()=>T)=>T;
        type Default = <T=string>(radius:number, callback:()=>T)=>T;
        type OtherDefault = <T=number>(radius:number, callback:()=>T)=>T;
        type Const = <const T>(radius:number, callback:()=>T)=>T;
        type ItemLeaf = <T>(item:Item, callback:()=>T)=>T;
        type WiderLeaf = <T>(item:WiderItem, callback:()=>T)=>T;
        type Nested = <T>(callback:<U>(left:T, right:Array<U>)=>U)=>T;
        type NestedRenamed = <U>(callback:<T>(left:U, right:Array<T>)=>T)=>U;
        type NestedSwapped = <T>(callback:<U>(left:U, right:Array<T>)=>U)=>T;
        type Fixed = (radius:number, callback:()=>number)=>number;
        type FixedCopy = (radius:number, callback:()=>number)=>number;
        function implementation<T>(radius:number, callback:()=>T):T { return callback(); }
        type ExecutableFunction = typeof implementation;
        const arrow = <T>(radius:number, callback:()=>T):T => callback();
        type ExecutableArrow = typeof arrow;
        const methods = { run<T>(radius:number, callback:()=>T):T { return callback(); } };
        type ExecutableMethod = typeof methods.run;
        `,
        resolve("artifacts/generic-function-families/schema.ts"),
    );
    const storage = new GenericFunctionStorage();
    const families = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isTypeAliasDeclaration(statement)) continue;
        const signature = checker
            .getTypeAtLocation(statement)
            .getCallSignatures()[0]!;
        const family = storage.family(checker, signature, []);
        assert.equal(storage.family(checker, signature, []), family);
        families.set(statement.name.text, family);
        if (statement.name.text === "Base") {
            const symbol = signature.typeParameters![0]!.symbol;
            const captured = new Map([[symbol, checker.getNumberType()]]);
            const numberFamily = storage.family(checker, signature, [captured]);
            assert.notEqual(numberFamily, family);
            assert.equal(
                storage.family(checker, signature, [new Map(captured)]),
                numberFamily,
            );
            captured.set(symbol, checker.getStringType());
            assert.notEqual(
                storage.family(checker, signature, [captured]),
                numberFamily,
            );
        }
    }
    const family = (name: string): string => families.get(name)!;
    assert.equal(family("Base"), family("Renamed"));
    assert.equal(family("Constraint"), family("ConstraintRenamed"));
    assert.equal(family("Nested"), family("NestedRenamed"));
    for (const name of [
        "Optional",
        "Extra",
        "Rest",
        "Receiver",
        "Constraint",
        "Default",
        "Const",
        "Fixed",
        "ExecutableFunction",
        "ExecutableArrow",
        "ExecutableMethod",
    ])
        assert.notEqual(family("Base"), family(name), name);
    for (const [left, right] of [
        ["Constraint", "OtherConstraint"],
        ["Default", "OtherDefault"],
        ["ItemLeaf", "WiderLeaf"],
        ["Nested", "NestedSwapped"],
        ["Fixed", "FixedCopy"],
    ])
        assert.notEqual(family(left!), family(right!), `${left}/${right}`);
});

test("retained exports forward alpha-equivalent generic callbacks", () => {
    compileSource(
        `
        interface Source { run<T>(radius:number, callback:()=>T):T; }
        interface Sink { run<U>(radius:number, callback:()=>U):U; }
        export function consume(deps:Sink) {
            return ()=>deps.run(1,()=>({value:2}));
        }
        export function create(options:Source) {
            return consume({run:options.run});
        }
        const first:Array<typeof consume>=[consume];
        const second:Array<typeof create>=[create];
        `,
        { fileName: "retained-generic-callbacks.ts" },
    );
});

test("forwarded generic callbacks share identity, captures and specializations", (t) => {
    const source = `
        interface Source { run<T>(radius:number, callback:()=>T):T; count():number; }
        interface Sink { run<U>(radius:number, callback:()=>U):U; }
        function copy(options:Source):Sink { return {run:options.run}; }
        const copies:Array<typeof copy>=[copy];
        function make():Source {
            let calls=0;
            return {run<T>(radius:number, callback:()=>T):T {
                calls+=radius; return callback();
            },count:()=>calls};
        }
        const states:Source[]=[make(),make()];
        const original=states[0]!, other=states[1]!;
        const result=copies[0]!(original), saved=result.run;
        if(result.run!==original.run || result.run===other.run)
            throw new Error('function identity');
        if(result.run(1,()=>3)!==3 || original.run(2,()=>'text')!=='text')
            throw new Error('number and string specialization');
        const item={value:4};
        if(saved(3,()=>item)!==item || original.count()!==6 || other.count()!==0)
            throw new Error('record identity and shared captures');
        original.run=other.run;
        if(saved===original.run || result.run(4,()=>5)!==5 || original.count()!==10)
            throw new Error('retained callback after field replacement');
        type Track=<T>(label:string,work:()=>T)=>T;
        let labels='';
        const tracks:Track[]=[(label,work)=>{labels+=label;return work();}];
        const work=()=>7;
        tracks[0]!('direct',work);
        const wrapper=<V>(label:string,work:()=>V):V=>tracks[0]!(label,work);
        const wrappers:Array<typeof wrapper>=[wrapper];
        if(wrappers[0]!('wrapped',work)!==7 || wrappers[0]!('text',()=>'kept')!=='kept' || labels!=='directwrappedtext')
            throw new Error('first-demand order and wrapper specializations');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source, {
        fileName: "forwarded-generic-callbacks.ts",
    });
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "generic-function-families/forwarded-callbacks",
        result.cpp,
    );
});

test("recursive generic calls through equivalent source views still refuse", () => {
    for (const argument of ["value", "[value]"]) {
        const recursive = `(state as View).read(${argument},depth-1)${argument === "value" ? "" : "[0]!"}`;
        assert.throws(
            () =>
                compileSource(`
                interface Source { read<T>(value:T,depth:number):T; ready():boolean; }
                interface View { read<U>(value:U,depth:number):U; ready():boolean; }
                function make():Source {
                    return {ready:()=>true,read<T>(value:T,depth:number):T {
                        return depth>0 ? ${recursive} : value;
                    }};
                }
                const saved:Array<()=>boolean>=[];
                saved.push(()=>state.ready());
                const state=make();
                state.read(3,2);
            `),
            /Recursive stored generic functions require an already represented signature/,
        );
    }
});
