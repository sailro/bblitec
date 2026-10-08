import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("returned Map cursors retain owner, position and live entries", async (t) => {
    const source = `
        interface Item { value:number; }
        interface View {
            entries():MapIterator<[number,Item]>;
            keys():MapIterator<number>;
            values():MapIterator<Item>;
        }
        function view(map:Map<number,Item>):View {
            return {entries:()=>map.entries(),keys:()=>map.keys(),values:()=>map.values()};
        }
        const retained:Array<typeof view>=[view];
        const first={value:1}, second={value:2}, third={value:3};
        let map=new Map<number,Item>([[1,first],[2,second]]);
        const original=map;
        const access=retained[0]!(map);
        const entries=access.entries(), alias=entries, other=access.entries();
        if(entries===other || entries!==alias)throw new Error('cursor identities');
        const head=entries.next();
        if(head.done || head.value![0]!==1 || head.value![1]!==first)throw new Error('first entry');
        map.delete(2); map.set(3,third);
        map=new Map<number,Item>([[9,{value:9}]]);
        const tail=alias.next();
        if(tail.done || tail.value![0]!==3 || tail.value![1]!==third)throw new Error('live owner');
        if(!entries.next().done)throw new Error('exhaustion');
        original.set(4,{value:4});
        if(!entries.next().done)throw new Error('permanent exhaustion');
        const independent=other.next();
        if(independent.done || independent.value![1]!==first)throw new Error('independent position');
        if(Array.from(access.keys()).join()!=='1,3,4')throw new Error('keys order');
        const values=access.values();
        if(values.next().value!==first)throw new Error('value identity');
        original.set(3,second);
        if(values.next().value!==second)throw new Error('updated value');
        if(original.values().next().value!==first)throw new Error('direct next');
        const empty=new Map<number,Item>();
        const fallback=empty.values().next().value??first;
        if(fallback!==first)throw new Error('empty fallback');
        const bank:View[]=[view(original)];
        const stored=bank[0]!.entries();
        if(stored.next().value![1]!==first)throw new Error('stored method result');
        let total=0;
        for(const [key,value] of access.entries()) total+=key+value.value;
        if(total!==15)throw new Error('entry iteration');
        let missingReturn=false;
        try{access.values().return!();}catch(error){missingReturn=error instanceof TypeError;}
        if(!missingReturn)throw new Error('missing Map return method');
        missingReturn=false;
        try{new Set([1]).values().return!();}catch(error){missingReturn=error instanceof TypeError;}
        if(!missingReturn)throw new Error('missing Set return method');
        const interrupted=access.keys();
        for(const key of interrupted){if(key!==1)throw new Error('early key');break;}
        if(interrupted.next().value!==3)throw new Error('internal close leaves cursor open');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "map-cursor-boundaries/returned-live-cursors",
            result.cpp,
        );
    });
});

test("Map cursors distinguish yielded null references from completion", async (t) => {
    const source = `
        interface Item {value:number;}
        const item:Item={value:3};
        const map=new Map<number,Item|null>([[0,null],[1,item]]);
        const iterator=map.values();
        const first=iterator.next();
        if(first.done||first.value!==null)throw new Error('yielded null');
        map.set(0,item);
        if(first.done||first.value!==null)throw new Error('snapshot of null');
        const second=iterator.next();
        if(second.done||second.value!==item)throw new Error('following identity');
        const end=iterator.next();
        if(!end.done||end.value!==undefined||end.value===null)throw new Error('exhaustion');
        if(!iterator.next().done)throw new Error('permanent exhaustion');
        map.set(0,null);
        const copied=Array.from(map.values());
        if(copied.length!==2||copied[0]!==null||copied[1]!==item)throw new Error('array iteration');
        let count=0;
        for(const value of map.values()){if(count===0&&value!==null)throw new Error('first null');count++;}
        if(count!==2)throw new Error('iteration after null');
        const keys=new Map<Item|null,number>([[null,1],[item,2]]).keys();
        if(keys.next().value!==null||keys.next().value!==item||!keys.next().done)throw new Error('nullable keys');
        const set=new Set<Item|null>([null,item]);
        const values=set.values();
        if(values.next().value!==null||values.next().value!==item||!values.next().done)throw new Error('nullable Set');
        const kept=map.values();
        const held:Array<IteratorResult<Item|null,undefined>>=[kept.next(),kept.next(),kept.next()];
        if(held[0]!.done||held[0]!.value!==null||!held[2]!.done||held[2]!.value!==undefined)
            throw new Error('retained result absence');
        function pull(input:MapIterator<Item|null>):IteratorResult<Item|null,undefined>{return input.next();}
        const readers:Array<typeof pull>=[pull];
        const returned=readers[0]!(map.values());
        if(returned.done||returned.value!==null)throw new Error('returned null result');
        const optional=new Map<number,Item|undefined>([[0,undefined],[1,item]]).values();
        const absent=optional.next();
        if(absent.done||absent.value!==undefined||absent.value===null)
            throw new Error('yielded undefined');
        if(optional.next().value!==item||!optional.next().done)throw new Error('after undefined');
        const optionalValues=new Map<number,Item|undefined>([[0,undefined]]).values();
        const storedOptional:Array<IteratorResult<Item|undefined,undefined>>=[optionalValues.next(),optionalValues.next()];
        if(storedOptional[0]!.done||storedOptional[0]!.value!==undefined||storedOptional[0]!.value===null||
            !storedOptional[1]!.done||storedOptional[1]!.value!==undefined)
            throw new Error('retained undefined result');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "map-cursor-boundaries/nullable-references",
            result.cpp,
        );
    });
});

test("Map cursor values refuse unrepresented mixed absence comparisons", () => {
    for (const read of ["values.next().value", "first.value"]) {
        assert.throws(
            () =>
                compileSource(`
            interface Item {value:number;}
            const values=new Map<number,Item|null|undefined>([[0,null],[1,undefined]]).values();
            ${read === "first.value" ? "const first=values.next();" : ""}
            if(${read}!==null)throw new Error('null yield');
        `),
            /may be null or undefined is compared strictly with null/,
        );
    }
});
