import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source, { fileName: `${name}.ts` });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(tools, `record-absence-layout/${name}`, result.cpp);
    });
}

check(
    "conditional-spreads-retain-absent-keys-and-record-identity",
    `
    type Need={kind:'per';count:number}|{kind:'ratio';units:number};
    interface Entry{id:number;need?:Need;label:string;}
    let calls=0;
    function make(need:Need|undefined):Entry {
        return {id:1,...((n)=>{calls++;return n?{need:n}:{};})(need),label:'entry'};
    }
    const kept:Array<typeof make>=[make];
    const need:Need={kind:'per',count:2};
    const absent=kept[0]!(undefined), present=kept[0]!(need);
    const ratio=kept[0]!({kind:'ratio',units:3});
    if(calls!==3||Object.keys(absent).join()!=='id,label'||'need' in absent)
        throw new Error('absent spread and evaluation');
    if(Object.keys(present).join()!=='id,need,label'||present.need!==need)
        throw new Error('present spread and identity');
    if(present.need?.kind!=='per'||present.need.count!==2||ratio.need?.kind!=='ratio'||ratio.need.units!==3)
        throw new Error('union payload');
    `,
);

check(
    "conditional-shorthand-spreads-retain-own-keys",
    `
    function make(value:number|undefined):{id:number;value?:number} {
        return {id:1,...(value===undefined?{}:{value})};
    }
    const saved:Array<typeof make>=[make];
    if(Object.keys(saved[0]!(undefined)).join()!=='id'||Object.keys(saved[0]!(0)).join()!=='id,value')
        throw new Error('shorthand keys');
    `,
);

check(
    "null-initialized-fields-share-optional-array-storage",
    `
    interface Wide{value:number;list?:number[]|null;}
    function read(item:Wide):number{return item.list?.length??0;}
    const wide:Wide[]=[];
    const narrow={value:1,list:null};
    wide.push(narrow);wide.push({value:2});
    const item=wide[0]!, absent=wide[1]!;
    if(item.list!==null||item.list===undefined||!('list' in item)||'list' in absent)
        throw new Error('null and missing');
    if(Object.keys(narrow).join()!=='value,list'||Object.keys(absent).join()!=='value')
        throw new Error('null and missing keys');
    const values=[3];item.list=values;
    if(narrow!==item||read(narrow)!==1||item.list!==values)
        throw new Error('shared layout and array identity');
    values.push(4);
    if(read(narrow)!==2)throw new Error('array mutation');
    item.list=null;
    if(read(narrow)!==0||item.list!==null||!('list' in narrow))throw new Error('null write');
    `,
);

check(
    "null-only-literal-fields-retain-keys",
    `
    const source={value:null};
    const values:Array<{value:null}>=[source];
    if(values[0]!==source||values[0]!.value!==null||values[0]!.value===undefined)
        throw new Error('null value and identity');
    if(Object.keys(source).join()!=='value'||JSON.stringify(source)!=='{"value":null}')
        throw new Error('null key');
    `,
);

test("authored-optional-undefined-union-presence-remains-distinct", () => {
    for (const shape of [
        `{value:number}|{value?:undefined}`,
        `{value:number}|Partial<{value:undefined}>`,
        `Box<number>|Partial<Box<undefined>>`,
    ])
        assert.throws(
            () =>
                compileSource(`
                    interface Box<T>{value:T;}
                    type Item=${shape};
                    function keys(item:Item):string{return Object.keys(item).join();}
                    const saved:Array<typeof keys>=[keys];
                    saved[0]!({value:1});saved[0]!({value:undefined});saved[0]!({});
                `),
            /Own-property presence.*not represented/,
        );
});

check(
    "partially-tagged-unions-share-nested-record-layouts",
    `
    interface Ref{group:'one'|'two';id:number;}
    type Request=
        |{kind:'dot';ref:Ref;point:{x:number}}
        |{kind:'other';ref:Ref;point:{x:number}}
        |{kind:'marker';ref:Ref;place:'free';point:{x:number}}
        |{kind:'marker';ref:{group:'one';id:number};place:'fixed';config:{angle:number}}
        |{kind:'marker';ref:{group:'two';id:number};place:'fixed';config:{size:number}};
    const recordOf=(value:unknown):Record<string,unknown>|null=>
        typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;
    const keys=(record:Record<string,unknown>,expected:readonly string[]):boolean=>{
        const own=Object.keys(record);
        return own.length===expected.length&&expected.every(key=>Object.hasOwn(record,key));
    };
    function read(raw:Request):number {
        const request=recordOf(raw);
        if(!request||typeof request.kind!=='string')return 0;
        if(request.kind==='dot'||request.kind==='other'){
            if(!keys(request,['kind','ref','point']))throw new Error('point keys');
            return (request.point as {x:number}).x;
        }
        if(request.place==='free')return (request.point as {x:number}).x;
        const ref=request.ref as Ref;
        if(!keys(request,['kind','ref','place','config']))throw new Error('fixed keys');
        if(ref.group==='one'){
            const config=request.config as {angle:number};
            if(Object.keys(config).join()!=='angle')throw new Error('angle key');
            config.angle+=2;return config.angle;
        }
        const config=request.config as {size:number};
        if(Object.keys(config).join()!=='size')throw new Error('size key');
        config.size+=3;return config.size;
    }
    const kept:Array<typeof read>=[read];
    const point={x:4},angle={angle:5},size={size:6};
    const rows:Request[]=[
        {kind:'dot',ref:{group:'one',id:1},point},
        {kind:'other',ref:{group:'two',id:2},point},
        {kind:'marker',ref:{group:'one',id:3},place:'free',point},
        {kind:'marker',ref:{group:'one',id:4},place:'fixed',config:angle},
        {kind:'marker',ref:{group:'two',id:5},place:'fixed',config:size},
    ];
    if(kept[0]!(rows[0]!)!==4||kept[0]!(rows[1]!)!==4||kept[0]!(rows[2]!)!==4)
        throw new Error('point arms');
    if(kept[0]!(rows[3]!)!==7||kept[0]!(rows[4]!)!==9||angle.angle!==7||size.size!==9)
        throw new Error('nested aliases');
    const fixed=rows[3]!;
    if(fixed.kind!=='marker'||fixed.place!=='fixed'||fixed.config!==angle)
        throw new Error('nested identity');
    `,
);

test("partially-tagged-unions-refuse-incompatible-payload-layouts", () => {
    for (const config of ["{value:string}", "number"])
        assert.throws(
            () =>
                compileSource(`
                    type Request={kind:'point';point:{x:number}}
                        |{kind:'config';config:{value:number}}
                        |{kind:'config';config:${config}};
                    function read(raw:Request):number {
                        const record=raw as unknown as Record<string,unknown>;
                        return record.kind==='point'?(record.point as {x:number}).x:0;
                    }
                    const kept:Array<typeof read>=[read];
                `),
            /Struct .* has no field 'point'/,
        );
});

check(
    "joined-record-fields-retain-typed-array-buffer-identity-and-brand",
    `
    interface Row { view:Float32Array<ArrayBufferLike>; pending:{value:number}|null; }
    const buffer=new ArrayBuffer(8),shared=new SharedArrayBuffer(8);
    const view=new Float32Array(buffer),sharedView=new Float32Array(shared);
    const narrow={view,pending:null},sharedNarrow={view:sharedView,pending:null};
    const rows:Row[]=[narrow,sharedNarrow];
    if(rows[0]!==narrow||rows[1]!==sharedNarrow||rows[0]!.view!==view||rows[1]!.view!==sharedView)
        throw new Error('record and view identities');
    if(rows[0]!.view.buffer!==buffer||rows[1]!.view.buffer!==shared||
        rows[0]!.view.buffer instanceof SharedArrayBuffer||!(rows[1]!.view.buffer instanceof SharedArrayBuffer))
        throw new Error('buffer identities and shared brand');
    rows[0]!.view[0]=3;rows[1]!.view[0]=5;
    if(view[0]!==3||sharedView[0]!==5||rows[0]!.pending!==null||rows[1]!.pending!==null)
        throw new Error('view writes and null fields');
    const pending={value:7};rows[0]!.pending=pending;
    if((narrow as Row).pending!==pending||sharedNarrow.pending!==null)
        throw new Error('joined nullable field');
    `,
);

test("record layouts refuse different typed-array element kinds", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Row { view:Float64Array; }
            const source={view:new Float32Array([1])};
            const rows:Row[]=[source as unknown as Row];
            if((rows[0] as unknown)!==source)throw new Error('identity');
        `),
        /no.*layout|data.*f64array|f32array.*f64array/,
    );
});
