import test from "node:test";
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
