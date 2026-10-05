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
        const compiled = compileSource(source);
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `optional-record-boundaries/${name}`,
            compiled.cpp,
        );
    });
}

check(
    "logical-record-fallbacks",
    `
    interface Item {name:string;cell:{value:number}}
    const found:Item={name:'found',cell:{value:2}};
    const fallback:Item={name:'fallback',cell:{value:3}};
    let trace='';
    function key(value:string|undefined):string|undefined {trace+='k';return value;}
    function find(value:string):Item|undefined {trace+='f';return value==='found'?found:undefined;}
    function otherwise():Item {trace+='b';return fallback;}
    function choose(value:string|undefined):Item {
        return (key(value) && find(value!)) || otherwise();
    }
    const calls:Array<typeof choose>=[choose];
    if(calls[0]!(undefined)!==fallback || trace!=='kb') throw new Error('undefined guard');
    trace='';
    if(calls[0]!('')!==fallback || trace!=='kb') throw new Error('empty guard');
    trace='';
    if(calls[0]!('missing')!==fallback || trace!=='kfb') throw new Error('missing item');
    trace='';
    const selected=calls[0]!('found');
    if(selected!==found || trace!=='kf') throw new Error('present identity');
    selected.cell.value=9;
    if(found.cell.value!==9) throw new Error('retained alias');
`,
);

check(
    "logical-record-chains-and-nullability",
    `
    interface Item {value:number}
    let trace='';
    function guard(value:boolean):boolean {trace+='g';return value;}
    function item(value:Item|null):Item|null {trace+='i';return value;}
    function fallback(value:Item|null):Item|null {trace+='f';return value;}
    function choose(enabled:boolean, value:Item|null, other:Item|null):Item|null {
        const result=(guard(enabled) && guard(enabled) && item(value)) || fallback(other);
        return result;
    }
    const calls:Array<typeof choose>=[choose];
    const first:Item={value:2};
    const second:Item={value:3};
    if(calls[0]!(false,first,second)!==second || trace!=='gf') throw new Error('guard chain');
    trace='';
    if(calls[0]!(true,null,second)!==second || trace!=='ggif') throw new Error('nullable left');
    trace='';
    if(calls[0]!(true,first,second)!==first || trace!=='ggi') throw new Error('lazy fallback');
    trace='';
    if(calls[0]!(true,null,null)!==null || trace!=='ggif') throw new Error('nullable fallback');
`,
);

check(
    "asserted-numeric-coercion",
    `
    interface Input {duration?:number}
    function guarded(input:Input):number {
        const duration=input.duration;
        if(!Number.isFinite(duration)||!(duration!>0)) return 0;
        return duration!*2;
    }
    function optional(value:number|undefined):number {return value!*2;}
    function nullable(value:number|null):number {return value!+3;}
    function field(value:Input):number {return value.duration!*2;}
    const guards:Array<typeof guarded>=[guarded];
    const optionals:Array<typeof optional>=[optional];
    const nullables:Array<typeof nullable>=[nullable];
    const fields:Array<typeof field>=[field];
    if(guards[0]!({duration:3})!==6 || guards[0]!({})!==0 || guards[0]!({duration:NaN})!==0)
        throw new Error('guard');
    if(!Number.isNaN(optionals[0]!(undefined)) || optionals[0]!(4)!==8)
        throw new Error('undefined coercion');
    if(nullables[0]!(null)!==3 || nullables[0]!(4)!==7)
        throw new Error('null coercion');
    if(!Number.isNaN(fields[0]!({})) || fields[0]!({duration:4})!==8)
        throw new Error('field coercion');
`,
);

check(
    "array-predicate-union-narrowing",
    `
    type Input=number|string|readonly number[];
    function length(table:Record<string,Input>, key:string):number {
        const values=table[key];
        if(!Array.isArray(values)||!values.every(value=>typeof value==='number'&&Number.isFinite(value))) return -1;
        return values.length;
    }
    const calls:Array<typeof length>=[length];
    const table:Record<string,Input>={a:[1,2],b:3,c:'text',d:[NaN],e:[]};
    if(calls[0]!(table,'a')!==2 || calls[0]!(table,'b')!==-1 || calls[0]!(table,'c')!==-1 ||
       calls[0]!(table,'missing')!==-1 || calls[0]!(table,'d')!==-1 || calls[0]!(table,'e')!==0)
        throw new Error('array guard');
`,
);

check(
    "optional-array-map-spread",
    `
    interface Item {value:number;note?:string;cell:{value:number}}
    function clone(items:readonly Item[]|undefined):Item[]{return items?.map(item=>({...item}))??[];}
    const calls:Array<typeof clone>=[clone];
    const cell={value:3};
    const input:Item[]=[{value:2,cell},{value:4,note:'present',cell}];
    const result=calls[0]!(input);
    if(result===input || result[0]===input[0] || result[0]!.cell!==cell || result[1]!.note!=='present')
        throw new Error('copy identity');
    if('note' in result[0]! || !('note' in result[1]!) || calls[0]!(undefined).length!==0)
        throw new Error('optional presence');
    result[0]!.value=9;
    if(input[0]!.value!==2) throw new Error('independent copy');
`,
);

check(
    "runtime-object-rest",
    `
    interface Input {key:string;value:number;note?:string;cell:{value:number}}
    type Result={value:number;note?:string;cell:{value:number}};
    let sources=0;
    function source(input:Input):Input {sources++;return input;}
    function copy(input:Input):Result {const {key:ignored,...rest}=source(input);return rest;}
    const calls:Array<typeof copy>=[copy];
    const cell={value:3};
    const input:Input={key:'excluded',value:2,cell};
    const result=calls[0]!(input);
    const present=calls[0]!({key:'excluded',value:4,note:'present',cell});
    if(sources!==2 || result.value!==2 || result.cell!==cell || 'key' in result || 'note' in result || present.note!=='present')
        throw new Error('rest fields');
    result.value=9;
    result.cell.value=7;
    if(input.value!==2 || input.cell.value!==7 || result===calls[0]!(input))
        throw new Error('rest identity');
`,
);

check(
    "rest-source-snapshot-and-lazy-defaults",
    `
    interface Input {omitted?:number;value:number}
    const state:{current:Input}={current:{value:1}};
    let defaults=0;
    function replace():number {defaults++;state.current={value:2};return 0;}
    function read():number {
        const {omitted=replace(),...rest}=state.current;
        return rest.value;
    }
    if(read()!==1 || state.current.value!==2 || defaults!==1)
        throw new Error('selected owner');
    state.current={omitted:4,value:3};
    if(read()!==3 || state.current.value!==3 || defaults!==1)
        throw new Error('lazy default');
    `,
);

check(
    "rest-extracted-field-snapshots",
    `
    interface Input {cell:{value:number};items:number[];optional?:number;value:number}
    function read(source:Input):number {
        const {cell,items,optional,...rest}=source;
        source.cell={value:30};source.items=[40];source.optional=50;
        cell.value=3;items.push(5);
        if(optional!==7 || items.length!==2 || items[0]!==4 || rest.value!==2)
            throw new Error('field snapshots');
        return cell.value+rest.value;
    }
    const calls:Array<typeof read>=[read];
    const cell={value:1},items=[4];
    if(calls[0]!({cell,items,optional:7,value:2})!==5 || cell.value!==3 || items.length!==2)
        throw new Error('field identity');
    `,
);

check(
    "rest-null-does-not-default",
    `
    interface Input {omitted:number|null;value:number}
    let defaults=0;
    function fallback():number {defaults++;return 9;}
    function read(source:Input):number {
        const {omitted=fallback(),...rest}=source;
        if(omitted!==null) throw new Error('null preserved');
        return rest.value;
    }
    const calls:Array<typeof read>=[read];
    if(calls[0]!({omitted:null,value:2})!==2 || defaults!==0)
        throw new Error('null default');
    `,
);

check(
    "rest-literal-exclusion-keys",
    `
    interface Input {1:number;2:number;name:string;value:number}
    function read(source:Input):number {
        const {1:first,[2]:second,['name']:name,...rest}=source;
        if(first!==3 || second!==4 || name!=='selected' || Object.keys(rest).join(',')!=='value')
            throw new Error('excluded keys');
        return rest.value;
    }
    const calls:Array<typeof read>=[read];
    if(calls[0]!({1:3,2:4,name:'selected',value:5})!==5)
        throw new Error('rest value');
    `,
);

check(
    "rest-excluded-accessor",
    `
    interface Input {omitted:number;value:number}
    let reads=0;
    const input:Input={get omitted(){reads++;return 4;},value:2};
    function read(source:Input):number {
        const {omitted,...rest}=source;
        if(omitted!==4 || Object.keys(rest).join(',')!=='value') throw new Error('excluded accessor');
        return rest.value;
    }
    const calls:Array<typeof read>=[read];
    if(calls[0]!(input)!==2 || reads!==1) throw new Error('getter reads');
    `,
);

test("runtime object rest refuses dynamic exclusion keys", () => {
    assert.throws(
        () =>
            compileSource(`
        function read(source:{value:number;other:number}, key:'value'|'other'):number {
            const {[key]:value,...rest}=source;
            return value;
        }
        const calls:Array<typeof read>=[read];
        if(calls[0]!({value:3,other:4},'other')!==4) throw new Error('computed key');
    `),
        /Object destructuring requires a literal property key/,
    );
});
