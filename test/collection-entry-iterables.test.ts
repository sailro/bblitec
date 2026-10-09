import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("entry collections consume Sets and retained cursors in order with shared values", (t) => {
    const source = `
        interface Item { count:number }
        type Pair = readonly [string,Item];
        const first={count:1},last={count:2};
        const entries=new Set<Pair>([['a',first],['b',last],['a',last]]);
        const map=new Map(entries);
        if(map.size!==2||map.get('a')!==last||[...map.keys()].join()!=='a,b')throw new Error('set order');
        map.get('a')!.count++;
        if(last.count!==3||entries.size!==3)throw new Error('shared values');
        const cursor=map.entries(),alias=cursor;
        cursor.next();
        const tail=new Map(alias);
        if(tail.size!==1||tail.get('b')!==last||!cursor.next().done)throw new Error('retained position');
        tail.delete('b');
        if(map.size!==2)throw new Error('fresh collection');
        const object=Object.fromEntries(entries);
        if(object.a!==last||object.b!==last||Object.keys(object).join()!=='a,b')throw new Error('object entries');
        object.a.count++;
        if(Number(last.count)!==4)throw new Error('object value identity');
        function copy(input?:Set<Pair>|null){return new Map(input);}
        const factories:Array<typeof copy>=[copy];
        if(factories[0]!().size!==0||factories[0]!(null).size!==0||factories[0]!(entries).get('a')!==last)
            throw new Error('optional set');
    `;
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
        "collection-entry-iterables/sets-cursors",
        result.cpp,
    );
});

test("entry generators read each pair before advancing and retain nullable iterator owners", (t) => {
    const source = `
        interface Item { count:number }
        type Pair = [string,Item];
        const first={count:1},second={count:2};
        let trace='',calls=0;
        function* pairs():Generator<Pair> {
            const pair:Pair=['a',first];
            try {
                trace+='a';yield pair;
                pair[0]='b';pair[1]=second;
                trace+='b';yield pair;
            } finally {trace+='f';}
        }
        function produce(){calls++;return pairs();}
        const iterator=produce(),map=new Map(iterator);
        if(trace!=='abf'||calls!==1||map.get('a')!==first||map.get('b')!==second||!iterator.next().done)
            throw new Error('yield order');
        trace='';
        const object=Object.fromEntries(produce());
        if(trace!=='abf'||Number(calls)!==2||object.a!==first||object.b!==second)throw new Error('fromEntries order');
        function copy(input?:Generator<Pair>|null){return new Map(input);}
        const copies:Array<typeof copy>=[copy];
        if(copies[0]!().size!==0||copies[0]!(null).size!==0||copies[0]!(produce()).get('a')!==first)
            throw new Error('optional iterator');
        const failure=new Error('source');
        let closed=0;
        function* failing():Generator<readonly [string,number]> {
            try {yield ['before',1];throw failure;}
            finally {closed++;}
        }
        let caught=false;
        try {new Map(failing());}catch(error){caught=error===failure;}
        if(!caught||closed!==1)throw new Error('iterator failure');
    `;
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
        "collection-entry-iterables/generators",
        result.cpp,
    );
});

test("short entry arrays retain their explicit refusal and close the iterator without replacing its error", (t) => {
    const result = compileSource(`
        let closed=0,message='';
        function* entries():Generator<number[]> {
            try {yield [1];}
            finally {closed++;throw new Error('cleanup');}
        }
        const iterator=entries();
        try {new Map(iterator as Iterable<[number,number]>);}
        catch(error){if(error instanceof Error)message=error.message;}
        if(closed!==1||message!=='Collection entry requires a key and value'||!iterator.next().done)
            throw new Error('iterator close refusal');
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "collection-entry-iterables/close-refusal",
        result.cpp,
    );
});

test("Object.fromEntries converts represented numeric keys without changing Map keys", (t) => {
    const source = `
        function* entries():Generator<readonly [number,number]>{yield [2,4];yield [-0,6];yield [2,8];}
        const object=Object.fromEntries(entries());
        if(object['2']!==8||object['0']!==6||Object.keys(object).join()!=='0,2')throw new Error('generator keys');
        const pairs=new Set<readonly [number,number]>([[3,9],[1,7]]);
        const fromSet=Object.fromEntries(pairs);
        if(fromSet['3']!==9||fromSet['1']!==7||Object.keys(fromSet).join()!=='1,3')throw new Error('set keys');
        const map=new Map(pairs),fromMap=Object.fromEntries(map);
        if(map.get(3)!==9||typeof [...map.keys()][0]!=='number'||fromMap['3']!==9)throw new Error('map keys');
        let key=5;
        const literal=Object.fromEntries([[key++,10],[key,11]]);
        if(literal['5']!==10||literal['6']!==11)throw new Error('literal keys');
        const dynamic:number[]=[];for(let i=0;i<2;i++)dynamic.push(i);
        const mapped=Object.fromEntries(dynamic.map(value=>[value,value*2] as const));
        if(mapped['0']!==0||mapped['1']!==2)throw new Error('mapped numeric keys');
    `;
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
        "collection-entry-iterables/property-keys",
        result.cpp,
    );
});

test("entry collections refuse asynchronous and nonpair iterables", () => {
    for (const source of [
        `new Map(new Set([1,2]) as unknown as Iterable<[number,number]>);`,
        `function* entries():Generator<number>{yield 1;}Object.fromEntries(entries() as unknown as Iterable<[string,number]>);`,
        `async function* entries():AsyncGenerator<[string,number]>{yield ['a',1];}new Map(entries() as unknown as Iterable<[string,number]>);`,
    ])
        assert.throws(
            () => compileSource(source),
            /Collection entries (must be arrays of key\/value pairs|require a represented synchronous iterable)/,
        );
});

test("dictionary projections order index keys before names and snapshot shared values", (t) => {
    const source = `
        interface Item { count:number }
        type Pair = readonly [string,Item];
        const zero={count:0},two={count:2},zed={count:3};
        const pairs=new Set<Pair>([['z',zed],['2',two],['01',{count:4}],['1',{count:1}],
            ['-0',{count:5}],['4294967295',{count:6}],['0',zero],['a',{count:7}]]);
        const dictionary=Object.fromEntries(pairs),alias=dictionary;
        let reads=0;
        function read(){reads++;return dictionary;}
        const keys=Object.keys(read()),values=Object.values(read());
        alias.extra={count:8};alias.z={count:9};two.count=12;
        if(reads!==2||keys.join()!=='0,1,2,z,01,-0,4294967295,a')throw new Error('key ordering and snapshots');
        if(values.map(value=>value.count).join()!=='0,1,12,3,4,5,6,7'||values[0]!==zero||values[3]!==zed)
            throw new Error('ordered shared values');
        if(Object.keys(alias).join()!=='0,1,2,z,01,-0,4294967295,a,extra'||dictionary.z.count!==9)
            throw new Error('insertion ordering and alias');
    `;
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
        "collection-entry-iterables/property-order",
        result.cpp,
    );
});

test("Object.fromEntries converts literal keys after evaluating every entry and keeps their original owners", (t) => {
    const source = `
        let key:string[]=['a'];
        const original=key;
        let calls=0;
        function change(){calls++;key=['replacement'];original.push('b');return calls;}
        const object=Object.fromEntries<number>([[key as unknown as string,7],['changed',change()]]);
        original.push('c');
        if(calls!==1||object['a,b']!==7||object.changed!==1||Object.keys(object).join()!=='a,b,changed')
            throw new Error('literal key evaluation');
        if(key.join()!=='replacement'||original.join()!=='a,b,c')throw new Error('key owners');
    `;
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
        "collection-entry-iterables/literal-key-evaluation",
        result.cpp,
    );
});

test("yielded entry aliases preserve Map key distinctions and Object.fromEntries property collisions", (t) => {
    const source = `
        interface Item {count:number}
        type Pair=[number|string,Item];
        const first={count:1},last={count:2};
        function* pairs():Generator<Pair>{
            const pair:Pair=[2,first];
            yield pair;pair[0]='2';pair[1]=last;yield pair;
            pair[0]=-0;pair[1]=first;yield pair;
            pair[0]='0';pair[1]=last;yield pair;
            pair[0]='-0';pair[1]=first;yield pair;
        }
        const object=Object.fromEntries(pairs()),map=new Map(pairs());
        if(Object.keys(object).join()!=='0,2,-0'||object['2']!==last||object['0']!==last||object['-0']!==first)
            throw new Error('property collision');
        if(map.size!==5||map.get(2)!==first||map.get('2')!==last||map.get(0)!==first||map.get('0')!==last)
            throw new Error('map distinct keys');
        first.count=8;last.count=9;
        if(object['2'].count!==9||map.get(2)!.count!==8)throw new Error('payload owners');
    `;
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
        "collection-entry-iterables/yielded-key-collisions",
        result.cpp,
    );
});

test("nullable iterable captures and returned copies retain payload owners after reseating", (t) => {
    const source = `
        interface Item {count:number}
        type Pair=readonly[string,Item];
        const item={count:1};
        function pairs(){return new Set<Pair>([['item',item]]);}
        function make(){let current:Set<Pair>|null|undefined=null;return {
            set:(value:Set<Pair>|null|undefined)=>{current=value;},copy:()=>new Map(current)
        };}
        const makers:Array<typeof make>=[make],box=makers[0]!();
        if(box.copy().size!==0)throw new Error('initial absence');
        const source=pairs();box.set(source);const first=box.copy();
        if(first.get('item')!==item||box.copy().size!==1)throw new Error('present source');
        source.clear();
        if(box.copy().size!==0||first.get('item')!==item)throw new Error('fresh copy');
        box.set(undefined);if(box.copy().size!==0)throw new Error('undefined source');
        box.set(pairs());const second=box.copy();item.count=4;
        if(first===second||second.get('item')!==item||first.get('item')!.count!==4)throw new Error('copy owners');
        box.set(null);if(box.copy().size!==0)throw new Error('null source');
    `;
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
        "collection-entry-iterables/captured-source-owners",
        result.cpp,
    );
});

test("entry constructors preserve a generator finally error and complete its retained cursor", (t) => {
    const source = `
        const original=new Error('source'),replacement=new Error('finally');
        let closed=0,caught=false;
        function* pairs():Generator<readonly[string,number]>{
            try{yield ['first',1];throw original;}
            finally{closed++;throw replacement;}
        }
        const iterator=pairs();
        try{Object.fromEntries(iterator);}catch(error){caught=error===replacement;}
        if(!caught||closed!==1||!iterator.next().done)throw new Error('finally replacement');
    `;
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
        "collection-entry-iterables/generator-finally-error",
        result.cpp,
    );
});
