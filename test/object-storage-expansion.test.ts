import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { mergeNativeRecordStorage } from "../src/compiler/native-record-storage.js";
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
            { close() {} },
        ) as unknown);
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `object-storage-expansion/${name}`,
            result.cpp,
            {
                defines: result.manifest.features.includes("platform:workers")
                    ? ["BBLITE_WORKERS=1"]
                    : [],
                timeoutMs: 10_000,
            },
        );
    });
}

test("conflicting scalar dictionary demands refuse without changing the retained owner", () => {
    const frontend = createCompilerProgram(
        "interface Empty {}",
        "dictionary-demand.ts",
    );
    const [declaration] = frontend.sourceFile.statements;
    assert.ok(declaration && ts.isInterfaceDeclaration(declaration));
    const type = frontend.checker.getTypeAtLocation(declaration.name);
    const source = { identity: type, type, node: declaration, frames: [] };
    for (const [first, second] of [
        ["string", "number"],
        ["number", "string"],
    ] as const) {
        const previous = { ...source, dictionary: first };
        const next = { ...source, dictionary: second };
        const conflict = mergeNativeRecordStorage(previous, next);
        assert.ok(conflict);
        assert.equal(conflict.dictionary, first);
        assert.equal(mergeNativeRecordStorage(conflict, next), undefined);
        const registry = new DataTypeRegistry(
            frontend.checker,
            (_node, message) => {
                throw new Error(message);
            },
            new ClassHierarchy(frontend.checker, frontend.program),
        );
        assert.throws(
            () => registry.prepareRecordComponents(new Map(), [conflict]),
            /conflicting scalar dictionary storage/,
        );
        assert.throws(
            () => registry.prepareRecordComponents(new Map(), [previous, next]),
            /conflicting scalar dictionary storage/,
        );
    }
});

check(
    "runtime deletion promotes a fresh generic spread",
    `
    interface Frame { x:number; y:number; }
    interface Options { seed?:number; frame?:Readonly<Frame>; foot?:number; }
    const finite=(v:unknown):v is number => typeof v==='number' && Number.isFinite(v);
    function valid(v:unknown):v is Readonly<Frame> {
        if(!v || typeof v!=='object' || Array.isArray(v)) return false;
        const f=v as Frame;
        return finite(f.x) && finite(f.y);
    }
    function clean<T extends Options>(value:T):T {
        const copy={...value};
        if(!finite(copy.seed)) delete copy.seed;
        if(valid(copy.frame)) copy.frame=Object.freeze({x:copy.frame.x,y:copy.frame.y});
        else delete copy.frame;
        if(!copy.frame || !finite(copy.foot)) delete copy.foot;
        return copy;
    }
    function fields(value:Options):Pick<Options,'frame'|'foot'> {
        const copy=clean({frame:value.frame,foot:value.foot});
        return {...(copy.frame?{frame:copy.frame}:{}),
            ...(copy.foot!==undefined?{foot:copy.foot}:{})};
    }
    const kept:Array<typeof fields>=[fields];
    const original:Options={frame:{x:2,y:3},foot:4};
    const missing=kept[0]!({});
    const present=kept[0]!(original);
    if(Object.keys(missing).length!==0 || present.frame?.x!==2 || present.foot!==4)
        throw Error('projection');
    if(present.frame===original.frame || original.frame?.x!==2)
        throw Error('fresh frame copy');
`,
);

check(
    "runtime arrays retain unknown record lanes and aliases",
    `
    interface Entry { id:unknown; amount:number; }
    function gather(values:unknown[]):Entry[] {
        const entries:Entry[]=[];
        const alias=entries;
        for(let i=0;i<values.length;i++) {
            if(i%2===0) alias.push({id:values[i],amount:i});
        }
        return entries;
    }
    const kept:Array<typeof gather>=[gather];
    const owner={label:'shared'};
    const result=kept[0]!([owner,'skip',undefined,'skip',null]);
    if(result.length!==3 || result[0]!.id!==owner || result[1]!.id!==undefined || result[2]!.id!==null)
        throw Error('runtime growth and unknown identity');
    owner.label='changed';
    if((result[0]!.id as {label:string}).label!=='changed') throw Error('live owner');
`,
);

check(
    "template string fields keep ordinary string storage",
    `
    interface Row { id:string; count:number; }
    interface Item { key:\`item:\${string}\`; source:{count:number}; }
    function project(rows:Row[]):Item[] {
        return rows.map((row):Item=>({key:\`item:\${row.id}\`,source:{count:row.count}}));
    }
    const retained:Array<typeof project>=[project];
    const result=retained[0]!([{id:'a',count:7},{id:'b',count:9}]);
    if(result[0]!.key!=='item:a' || result[1]!.key!=='item:b' || result[1]!.source.count!==9)
        throw Error('template field');
`,
);

check(
    "nested fixed dictionary views keep the original owner",
    `
    interface Row { job?:string; }
    interface Copy { state:string; names?:Record<string,string>; }
    function project(rows:Row[]):Copy[] {
        return rows.map((row):Copy=>{
            const names=row.job?{job:row.job}:undefined;
            return {state:'ready',...(names?{names}:{})};
        });
    }
    const kept:Array<typeof project>=[project];
    const result=kept[0]!([{job:'work'},{}]);
    if(result[0]!.names?.job!=='work' || Object.hasOwn(result[1]!, 'names'))
        throw Error('conditional field');
    const original={job:'first'};
    const holder:{names:Record<string,string>}={names:original};
    const alias=holder.names;
    if(alias!==original) throw Error('dictionary identity');
    alias.job='second';
    original.job='third';
    alias.extra='new';
    if(alias.job!=='third' || Object.keys(original).join(',')!=='job,extra')
        throw Error('live writes and new key');
    delete alias.job;
    alias.job='last';
    if(Object.keys(original).join(',')!=='extra,job' || original.job!=='last')
        throw Error('delete and reinsert');
`,
);

check(
    "cached async records preserve nested parsed identity",
    `
    interface Info { manifest:{tag:string}; }
    const cache=new Map<string,Promise<Info>>();
    async function load(name:string):Promise<Info> {
        const manifest=JSON.parse('{"tag":"ready"}') as {tag:string};
        return {manifest};
    }
    function get(name:string):Promise<Info> {
        let p=cache.get(name);
        if(!p) {
            p=load(name);
            p.catch(()=>{if(cache.get(name)===p)cache.delete(name);});
            cache.set(name,p);
        }
        return p;
    }
    const kept:Array<typeof get>=[get];
    const first=kept[0]!('one');
    const second=kept[0]!('one');
    if(first!==second) throw Error('cached promise identity');
    first.then(value=>{
        const manifest=value.manifest;
        manifest.tag='changed';
        return second.then(again=>{
            if(again!==value || again.manifest!==manifest || again.manifest.tag!=='changed')
                throw Error('cached record identity');
            globalThis.close();
        });
    });
`,
);

check(
    "stored void or undefined callbacks preserve effects",
    `
    let calls=0;
    let enabled=true;
    const target={pause(value:number):void {calls+=value;}};
    function get():typeof target|undefined {return enabled?target:undefined;}
    const callbacks:Array<()=>void|undefined>=[];
    callbacks.push(()=>get()?.pause(2));
    const callback=callbacks.shift()!;
    callback();
    enabled=false;
    callback();
    if(calls!==2) throw Error('optional callback effects');
`,
);

check(
    "generic object rest retains a fresh shallow owner",
    `
    interface Fit { readonly scale?: number }
    function resize<T extends object>(value: T, scale: number): T & Fit {
        const { scale: ignored, ...rest } = value as T & Fit;
        void ignored;
        return (scale >= 1 ? rest : { ...rest, scale }) as T & Fit;
    }
    interface Shape { angle: number; child: { id: number }; scale?: number }
    const retained: Array<(value: Shape, scale: number) => Shape> = [resize];
    const original: Shape = { angle: 4, child: { id: 2 }, scale: 0.5 };
    const resized = retained[0]!(original, 2);
    const smaller = retained[0]!(original, 0.25);
    if (resized === original || resized.child !== original.child || 'scale' in resized || smaller.scale !== 0.25)
        throw new Error('rest ownership');
    resized.child.id = 7;
    if (original.child.id !== 7 || original.scale !== 0.5 || Object.keys(resized).join(',') !== 'angle,child')
        throw new Error('rest fields');
`,
);

check(
    "native structural views retain the original owner",
    `
    interface Clock { getTime():number; setTime(value:number):number }
    function clock():Clock { return new Date(4); }
    function same(value:Clock):Clock { return value; }
    const retained:Array<typeof clock>=[clock];
    const original=retained[0]!();
    const alias=same(original);
    const holders:Array<{clock:Clock}>=[{clock:alias}];
    if(alias!==original || holders[0]!.clock!==original)
        throw Error('native interface identity');
    alias.setTime(12);
    if(original.getTime()!==12 || holders[0]!.clock.getTime()!==12)
        throw Error('native interface mutation');
`,
);

test("native structural views refuse mixed authored owners", () => {
    assert.throws(
        () =>
            compileSource(`
        interface Clock { getTime():number; setTime(value:number):number }
        function clock(native:boolean):Clock {
            if(native)return new Date(4);
            return {getTime(){return 4;},setTime(value){return value;}};
        }
        const retained:Array<typeof clock>=[clock];
        void retained[0]!(false);
    `),
        /expected data.*date|expected data.*struct|native object|matching native/,
    );
});

check(
    "stored object spreads read receiver accessors into data",
    `
    interface Point { x:number; y:number }
    let reads='';
    const source:Point={x:2,y:4};
    const view=new Proxy(source,{
        get(target,key){reads+=String(key);if(key==='x')return target.x+1;return target[key as keyof Point];}
    });
    function copy(value:Point):Point { return {...value} as Point; }
    const copies:Array<typeof copy>=[copy];
    const copied=copies[0]!(view);
    if(copied===view || copied.x!==3 || copied.y!==4 || reads!=='xy')
        throw Error('getter spread');
    source.x=8;
    copied.y=9;
    if(copied.x!==3 || source.y!==4 || view.x!==9)
        throw Error('copied data');
`,
);

check(
    "generic method records share concrete callback argument storage",
    `
    interface Base { id:number }
    interface Detail extends Base { label:string }
    function operations<T extends Base>(deps:{read(value:T):number}):{
        begin(value:T):number; finish(value:T):number;
    } {
        return {begin(value){value.id++;return deps.read(value);},finish(value){return value.id;}};
    }
    interface Bundle<T extends Base=Detail>{command:ReturnType<typeof operations>}
    function generic<T extends Base>(deps:{read(value:T):number},replace:boolean):Bundle<T>{
        const command=operations(deps);
        if(replace)command.begin=command.finish;
        return {command};
    }
    function concrete(replace:boolean):Bundle<Detail>{
        return generic<Detail>({read(value){return typeof value.label==='undefined' ? -1 : value.label.length;}},replace);
    }
    const retained:Array<typeof concrete>=[concrete];
    const ordinary=retained[0]!(false),replaced=retained[0]!(true);
    const base:Base={id:2};
    const detail:Detail={id:3,label:'name'};
    if(ordinary.command.begin(base)!==-1||base.id!==3)throw Error('missing base field');
    if(ordinary.command.begin(detail)!==4||detail.id!==4)throw Error('concrete argument owner');
    if(replaced.command.begin!==replaced.command.finish||replaced.command.begin(base)!==3)
        throw Error('method assignment alias');
`,
);
