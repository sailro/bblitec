import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const controls = {
    erased: `
        interface Item { count:number }
        type Pair=readonly[string,unknown];
        const item={count:1};
        function pairs(){return new Set<Pair>([
            ['item',item],['null',null],['undefined',undefined],['number',12]
        ]);}
        function make(){
            const map=new Map(pairs()),object=Object.fromEntries(pairs());
            return ()=>({map,object});
        }
        const makers:Array<typeof make>=[make],read=makers[0]!();
        const first=read(),second=read();item.count=7;
        if(first.map!==second.map||first.object!==second.object||
           first.map.get('item')!==item||first.object.item!==item)
            throw new Error('retained identity');
        if(first.map.get('null')!==null||first.map.get('undefined')!==undefined||
           !first.map.has('undefined')||first.map.has('missing')||
           first.object.null!==null||first.object.undefined!==undefined||
           !Object.hasOwn(first.object,'undefined')||Object.hasOwn(first.object,'missing'))
            throw new Error('erased absence');
        if(first.map.get('number')!==12||first.object.number!==12||
           (first.map.get('item') as Item).count!==7||(first.object.item as Item).count!==7)
            throw new Error('erased payload');
    `,
    nullable: `
        interface Item { count:number }
        type Pair=readonly[string,Item|null|undefined];
        const item={count:1};
        function* pairs():Generator<Pair>{
            yield ['item',item];yield ['null',null];yield ['undefined',undefined];
        }
        function make(){
            const map=new Map(pairs()),object=Object.fromEntries(pairs());
            return ()=>({map,object});
        }
        const makers:Array<typeof make>=[make],read=makers[0]!();
        const first=read(),second=read();item.count=7;
        const mapItem=first.map.get('item'),objectItem=first.object.item;
        if(mapItem==null||objectItem==null)throw new Error('present item');
        if(first.map!==second.map||first.object!==second.object||mapItem!==item||objectItem!==item)
            throw new Error('retained identity');
        if(first.map.get('null')!==null||first.map.get('undefined')!==undefined||
           first.map.get('missing')!==undefined||!first.map.has('undefined')||
           first.object.null!==null||first.object.undefined!==undefined||
           !Object.hasOwn(first.object,'undefined')||Object.hasOwn(first.object,'missing')||
           Object.keys(first.object).join()!=='item,null,undefined')
            throw new Error('nullable absence');
        if(first.map.get('item')!.count!==7||first.object.item!.count!==7)
            throw new Error('shared mutation');
    `,
    keys: `
        interface Item { count:number }
        const item:Item={count:1};
        const values=new Set<Item|null|undefined>([item,null,undefined]);
        if(values.size!==3||!values.has(item)||!values.has(null)||!values.has(undefined))
            throw new Error('distinct nullable keys');
        values.delete(null);
        if(values.has(null)||!values.has(undefined)||!values.has(item))
            throw new Error('nullable deletion');
        const map=new Map<Item|null|undefined,number>([[item,1],[null,2],[undefined,3]]);
        if(map.size!==3||map.get(item)!==1||map.get(null)!==2||map.get(undefined)!==3)
            throw new Error('nullable Map keys');
        const copy=new Map(map.entries());
        item.count=4;
        if(copy.get(item)!==1||copy.get(null)!==2||copy.get(undefined)!==3)
            throw new Error('retained nullable keys');
        const mixed=new Map<Item|string,number>([[item,4],['label',5]]);
        const widened=new Map(mixed.entries());
        if(widened.get(item)!==4||widened.get('label')!==5)
            throw new Error('projected union key');
    `,
    snapshots: `
        interface Item { count:number }
        const item:Item={count:1};
        const map=new Map<string,Item|null|undefined>();
        map.set('item',item);map.set('null',null);map.set('undefined',undefined);
        let reads=0;
        function key(){reads++;return 'null';}
        const before=map.get(key());
        map.set('null',item);
        if(before!==null||reads!==1||map.get('null')!==item)throw new Error('read snapshot');
        const present=map.get('item');map.delete('item');item.count=9;
        if(present!==item||present!.count!==9||map.get('item')!==undefined)
            throw new Error('owned read');
        const copy=new Map(map.entries()),object=Object.fromEntries(map.entries());
        if(copy.get('null')!==item||copy.get('undefined')!==undefined||
           object.null!==item||object.undefined!==undefined||
           !Object.hasOwn(object,'undefined')||Object.hasOwn(object,'missing'))
            throw new Error('tagged entry copy');
        const cursor=map.entries(),alias=cursor;cursor.next();map.set('late',null);
        const tail=new Map(alias);
        if(tail.has('null')||!tail.has('undefined')||tail.get('late')!==null)
            throw new Error('live shared cursor');
        function retained(){
            const local=new Map<string,Item|null|undefined>();
            local.set('item',item);local.set('null',null);local.set('undefined',undefined);
            return local.entries();
        }
        const factories:Array<typeof retained>=[retained],held=new Map(factories[0]!());
        if(held.get('item')!==item||held.get('null')!==null||!held.has('undefined'))
            throw new Error('retained cursor owner');
        interface Box { value:Item|null|undefined }
        function wrap(value:Item|null|undefined):Box{return {value};}
        const wrappers:Array<typeof wrap>=[wrap];
        const missing=wrappers[0]!(undefined),empty=wrappers[0]!(null),full=wrappers[0]!(item);
        if(!Object.hasOwn(missing,'value')||missing.value!==undefined||
           empty.value!==null||full.value!==item)throw new Error('required own field');
    `,
};

for (const [name, source] of Object.entries(controls)) {
    test(`entry payload storage preserves ${name} values`, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `erased-entry-payloads/${name}`,
            result.cpp,
        );
    });
}

test("erased entry lanes refuse callbacks without JSON storage", () => {
    assert.throws(() =>
        compileSource(`
            const entries=new Set<readonly[string,unknown]>([['callback',()=>1]]);
            Object.fromEntries(entries);
        `),
    );
});
