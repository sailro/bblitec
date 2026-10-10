import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { AbsentRecordProperties } from "../src/compiler/absent-record-properties.js";
import { ClassHierarchy } from "../src/compiler/class-members.js";
import { DataTypeRegistry } from "../src/compiler/data-types.js";
import { demandedStorageType } from "../src/compiler/dynamic-binding-storage.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        const frontend = createCompilerProgram(
            source,
            "record-storage-carrier.ts",
        );
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(frontend.program)
                .map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(
                        diagnostic.messageText,
                        " ",
                    ),
                ),
            [],
        );
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `record-storage-carriers/${name}`,
            result.cpp,
            {
                timeoutMs: 10_000,
            },
        );
    });
}

check(
    "mapped records retain concrete fields after an array predicate erases checker members",
    `
    interface Section { name:string; data:Uint8Array; meta:{count:number} }
    const input:Section[]=[];
    for(let i=0;i<2;i++) input.push({name:String(i),data:new Uint8Array(i+2),meta:{count:i}});
    function encode(input:readonly Section[]) {
        if(!Array.isArray(input)) throw new Error('array');
        let offset=0;
        return input.map(section=>{
            const current=offset;
            offset+=section.data.byteLength;
            return {name:section.name,offset:current,byteLength:section.data.byteLength,meta:section.meta};
        });
    }
    const result=encode(input);
    if(result[0]!.offset!==0||result[1]!.offset!==2||result[1]!.byteLength!==3)
        throw new Error('map order');
    if(result[0]!.meta!==input[0]!.meta) throw new Error('nested identity');
    result[0]!.meta.count=9;
    if(input[0]!.meta.count!==9) throw new Error('nested alias');
`,
);

check(
    "map preserves abrupt callback effects and empty results",
    `
    const input:number[]=[];
    for(let i=0;i<2;i++) input.push(i);
    let calls=0;
    const fail=(value:number):never=>{calls+=value+1;throw new Error('stop');};
    let caught=false;
    try { input.map(fail); } catch { caught=true; }
    if(!caught||calls!==1) throw new Error('abrupt map');
    const empty:number[]=[];
    const result=empty.map(fail);
    if(result.length!==0||calls!==1) throw new Error('empty map');
`,
);

check(
    "nested dictionary views retain shared fields through conditional parent records",
    `
    interface Status {key:string;params?:Record<string,string>;kind:'error'}
    function create(flag:boolean) {
        let active:Status={key:'empty',kind:'error'};
        const read=()=>active;
        const set=(message:Status)=>{active=message;};
        const params={action:'move',other:'a',key:'x'};
        set(flag?{key:'yes',params,kind:'error'}:{key:'no',kind:'error'});
        params.action='later';
        if(flag) {
            if(read().params!==params||read().params!.action!=='later') throw new Error('nested alias');
            read().params!.key='changed';
            if(params.key!=='changed') throw new Error('reverse alias');
        }
        return read();
    }
    const flags:boolean[]=[];flags.push(true,false);
    const results=flags.map(create);
    if(results[0]!.key!=='yes'||results[1]!.key!=='no') throw new Error('parent');
`,
);

check(
    "open document projections retain discriminants extra properties and shallow copy identity",
    `
    type Item={kind:'a'|'b';x:number;label?:string};
    function view(source:Record<string,unknown>):Item {
        const result={...source,kind:source.kind,x:source.x} as unknown as Item;
        if(typeof source.label!=='string') delete result.label;
        return result;
    }
    const source:Record<string,unknown>={kind:'a',x:2,label:17,extra:4};
    const item=view(source),alias=item as unknown as Record<string,unknown>;
    alias.x=7;
    if(item.kind!=='a'||item.x!==7||alias.extra!==4||'label' in item||source.x!==2)
        throw new Error('document');
    alias.label='again';
    if(item.label!=='again'||Object.keys(alias).join()!=='kind,x,extra,label')
        throw new Error('reinsert order');
    const assigned=Object.assign(item,{x:8,extra:5});
    if(assigned!==item||alias.x!==8||Number(alias.extra)!==5)throw new Error('assign alias');
`,
);

check(
    "shared record layouts distinguish missing undefined null and present payloads",
    `
    interface View {id:number;label?:string|null}
    function keep(value:View):View{return value;}
    const values:View[]=[];
    values.push({id:0},{id:1,label:undefined},{id:2,label:null},{id:3,label:'x'});
    const readers:Array<typeof keep>=[keep];
    const retained=values.map(value=>readers[0]!(value));
    const own=retained.map(value=>Object.hasOwn(value,'label')).join();
    const inherited=retained.map(value=>'label' in value).join();
    if(own!=='false,true,true,true'||inherited!==own)throw new Error('presence');
    const keys=retained.map(value=>Object.keys(value).join()).join(';');
    if(keys!=='id;id,label;id,label;id,label')throw new Error('keys');
    const serialized=retained.map(value=>JSON.stringify(value as unknown as Record<string,unknown>)).join(';');
    if(serialized!=='{"id":0};{"id":1};{"id":2,"label":null};{"id":3,"label":"x"}')
        throw new Error('payload');
    if(retained[0]!==values[0]||retained[2]!==values[2])throw new Error('identity');
    delete retained[2]!.label;
    if('label' in values[2]!)throw new Error('delete alias');
    retained[2]!.label=undefined;
    if(!Object.hasOwn(values[2]!,'label')||values[2]!.label!==undefined)throw new Error('readd');
`,
);

check(
    "optional dynamic payload serialization omits undefined and writes null",
    `
    interface Item {id:number;value?:string|null}
    const values:Item[]=[];
    values.push({id:0},{id:1,value:undefined},{id:2,value:null},{id:3,value:'v'});
    if(JSON.stringify(values)!=='[{"id":0},{"id":1},{"id":2,"value":null},{"id":3,"value":"v"}]')
        throw new Error('serialization');
`,
);

check(
    "unknown dictionary keys mutate shared fixed record storage",
    `
    interface Item{x:number;y:number;label:string}
    function clean(value:Item){
        const fields=value as unknown as Record<string,unknown>;
        for(const key of Object.keys(fields)){
            const current=fields[key];
            if(typeof current==='number')fields[key]=current+3;
        }
        return fields;
    }
    const value={x:1,y:2,label:'kept'},alias=value;
    const cleaned=clean(value);
    if(value.x!==4||alias.y!==5||value.label!=='kept'||cleaned!==value)
        throw new Error('shared dictionary');
`,
);

check(
    "record union callbacks use the checked field conversions of their record arm",
    `
    type Option=string|{name:string;type:'scalar'|'vector';value?:number};
    const fields:readonly(readonly[string,'scalar'|'vector'])[]=[['a','scalar'],['b','vector']];
    function project():Option[] {return fields.map(([name,type])=>({name,type}));}
    const retained:Array<typeof project>=[project],result=retained[0]!();
    if(typeof result[0]==='string'||result[0]!.name!=='a'||result[0]!.type!=='scalar')
        throw new Error('record arm');
    if(typeof result[1]==='string'||result[1]!.type!=='vector') throw new Error('second record');
`,
);

check(
    "conditional rest copies retain omitted fields through narrowed record storage",
    `
    interface Control {x:number;lat?:number}
    function normalize(raw:Record<string,unknown>) {return typeof raw.lat==='number'?raw.lat:0;}
    function map(controls:Control[]) {
        return controls.map(control=>{
            const {lat,...rest}=control;
            return control.x>0?{...control,lat:2}:rest;
        }).map(control=>normalize(control as unknown as Record<string,unknown>));
    }
    const retained:Array<typeof map>=[map],original=[{x:1,lat:7},{x:0,lat:9}];
    const result=retained[0]!(original);
    if(result[0]!==2||result[1]!==0||original[1]!.lat!==9) throw new Error('rest');
`,
);

check(
    "document array views retain input and element identity through rest copies",
    `
    interface Control {x:number;lat?:number}
    function normalize(raw:Record<string,unknown>) {return typeof raw.lat==='number'?raw.lat:0;}
    function project(controls:Control[]) {
        const values=controls.map(control=>{
            const {lat,...rest}=control;
            return control.x>0?{...control,lat:2}:rest;
        }).map(control=>normalize(control as unknown as Record<string,unknown>));
        controls[0]!.x=8;
        controls.push({x:3,lat:4});
        return {controls,values};
    }
    const retained:Array<typeof project>=[project],original=[{x:1,lat:7},{x:0,lat:9}];
    const alias=original,first=original[0]!;
    const result=retained[0]!(original);
    if(result.controls!==original||alias!==result.controls||result.controls[0]!==first)
        throw new Error('shared array and element identities');
    if(result.values[0]!==2||result.values[1]!==0||first.x!==8||first.lat!==7||
        original.length!==3||original[1]!.lat!==9||original[2]!.lat!==4)
        throw new Error('rest omission and writes through original owner');
    alias[1]!.lat=5;
    if(result.controls[1]!.lat!==5) throw new Error('later alias mutation');
    `,
);

check(
    "finite generic keys retain optional constraint fields and original aliases",
    `
    interface Fields {wall?:string;body?:string}
    function edit<State extends Fields>(source:State,key:'wall'|'body',text:string) {
        const next={...source};
        next[key]=text;
        return next;
    }
    const input={body:'old'},keys:('wall'|'body')[]=[];
    keys.push('wall','body');
    const result:Fields[]=keys.map(key=>edit(input,key,'new'));
    if(result[0]!.wall!=='new'||result[0]!.body!=='old'||result[1]!.body!=='new'||input.body!=='old')
        throw new Error('finite keys');
`,
);

test("scalar dictionaries cannot project incompatible payload types", () => {
    assert.throws(
        () =>
            compileSource(`
            interface Named { label:string }
            const entries:[string,number][]=[['label',1]];
            const named=Object.fromEntries(entries) as unknown as Named;
            const readers:Array<(value:Named)=>string>=[value=>value.label];
            readers[0]!(named);
        `),
        /Open string record cannot project field 'label'/,
    );
});

test("a converted property without concrete source provenance still refuses", () => {
    const node = ts.createSourceFile(
        "absent.ts",
        "value.field",
        ts.ScriptTarget.Latest,
    );
    const absent = new AbsentRecordProperties((_, message) => {
        throw new Error(message);
    });
    absent.noteConversion("Narrow", ["field"]);
    assert.throws(
        () => absent.read("Narrow", "field", node),
        /Property 'field' is not stored by 'Narrow' records, but a record converted into that storage may carry it/,
    );
});

test("runtime-grown material arrays use the existing pinned handle representation", () => {
    const frontend = createCompilerProgram(
        `import {createStandardMaterial} from 'babylon-lite';
         type Material = ReturnType<typeof createStandardMaterial>;
         const materials:Material[]=[];
         interface StandardMaterialProps {label:string}
         const authored:StandardMaterialProps[]=[];`,
        "material-array-storage.ts",
    );
    assert.deepEqual(
        ts
            .getPreEmitDiagnostics(frontend.program)
            .map((diagnostic) =>
                ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
            ),
        [],
    );
    const dataTypes = new DataTypeRegistry(
        frontend.checker,
        (_, message) => {
            throw new Error(message);
        },
        new ClassHierarchy(frontend.checker, frontend.program),
    );
    const [materials, authored] = frontend.sourceFile.statements
        .filter(ts.isVariableStatement)
        .map((statement) => {
            const declaration = statement.declarationList.declarations[0]!;
            assert.ok(declaration.initializer);
            return demandedStorageType(
                { checker: frontend.checker, dataTypes },
                declaration,
                "array",
                declaration.initializer,
            );
        });
    assert.deepEqual(materials, {
        kind: "vector",
        element: { kind: "handle", handle: "material" },
    });
    assert.ok(
        authored?.kind === "vector" && authored.element.kind !== "handle",
    );
});
