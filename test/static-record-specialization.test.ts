import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { parameterIsMutated } from "../src/compiler/parameter-effects.js";
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
        const result = compileSource(source);
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `static-record-specialization/${name}`,
            result.cpp,
        );
    });
}

check(
    "closed calls specialize conditional record shapes",
    `
    let effects=0;
    function label(type:number):string {
        effects++;
        return type===1?'scalar':type===2?'array':'object';
    }
    function build(type:number,value:number|number[]|{x:number;y:number}|null):string {
        const extra:Record<string,unknown>={type};
        if(value!==null){extra.valueType=label(type);extra.value=value;}
        return Object.keys({...extra}).join(',');
    }
    const scalar=build(1,7);
    const array=build(2,[2,3]);
    const object=build(3,{x:1,y:2});
    const absent=build(4,null);
    if(scalar!=='type,valueType,value'||array!==scalar||object!==scalar||
       absent!=='type'||effects!==3) throw new Error('specialized fields');
`,
);

check(
    "closed record key calls preserve assignment and deletion order",
    `
    let trace='';
    function name():string {trace+='k';return 'item';}
    function value():number {trace+='v';return 4;}
    function build(key:string,initial:number,remove:boolean):string {
        const extra:Record<string,unknown>={first:1};
        extra[key]=initial;
        if(remove)delete extra[key];
        extra.last=3;
        return Object.keys(extra).join(',');
    }
    const present=build(name(),value(),false);
    const absent=build('item',9,true);
    if(present!=='first,item,last'||absent!=='first,last'||trace!=='kv')
        throw new Error('key order');
`,
);

check(
    "scalar projections keep facts while reference writes remain live",
    `
    const target={text:'',count:0};
    function copy(options:{enabled:boolean;count:number}):number {
        let local=options.count;
        local++;
        target.text=String(options.enabled===true);
        target.count=options.count;
        const extra:Record<string,unknown>={};
        if(options.enabled)extra.active=local;
        return Object.keys(extra).length;
    }
    const selected=copy({enabled:true,count:2});
    const absent=copy({enabled:false,count:4});
    if(selected!==1||absent!==0||target.text!=='false'||target.count!==4)
        throw new Error('scalar facts');
    function mutate(input:{child:{value:number}}):void {
        const alias=input.child;
        alias.value+=3;
    }
    const child={value:2};
    mutate({child});
    if(child.value!==5)throw new Error('reference alias');
`,
);

test("mutation facts distinguish copies from aliases and callback effects", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        const sink={text:'',value:0};
        const saved:Array<{value:number}>=[];
        function scalar(input:{value:number}) {
            let copy=input.value; copy++;
            sink.text=String(input.value); sink.value=input.value;
        }
        function reference(input:{value:number}) { saved.push(input); }
        function alias(input:{child:{value:number}}) {const copy=input.child;copy.value++;}
        function callback(input:{value:number}) {
            [1].forEach(()=>{input.value++;});
        }
        function nested(input:{value:number}) {
            function write(value:{value:number}):number {value.value++;return value.value;}
            sink.value=write(input);
        }
        function defaults(input:{value:number},ignored:number=(input.value=8)) {return ignored;}
    `,
        "test/static-record-effect-facts.ts",
    );
    const actual = sourceFile.statements
        .filter(ts.isFunctionDeclaration)
        .map((declaration) => {
            const parameter = declaration.parameters[0]!.name;
            assert.ok(ts.isIdentifier(parameter));
            return parameterIsMutated(checker, declaration, parameter);
        });
    assert.deepEqual(actual, [false, true, true, true, true, true]);
});

check(
    "scalar getter projections retain receiver effects and read order",
    `
    const sink={value:false};
    const input={other:0,get flag():boolean {this.other++;return this.other===1;}};
    function read(value:{other:number;flag:boolean}):number {
        const before=value.other;
        sink.value=value.flag;
        return before*10+value.other;
    }
    const first=read(input);
    const second=read(input);
    if(first!==1||second!==12||input.other!==2||sink.value!==false)
        throw new Error('getter receiver effects');
    let reads=0;
    const immutable={tag:3,get enabled():boolean {reads++;return true;}};
    const extra:Record<string,unknown>={};
    if(immutable.enabled&&immutable.tag===3)extra.selected=1;
    if(Object.keys(extra).length!==1||reads!==1)
        throw new Error('scalar closure getter facts');
`,
);

test("async scalar stores preserve generation-known engine options", () => {
    for (const enabled of [false, true]) {
        const result = compileSource(`
            import {createEngine} from 'babylon-lite';
            const target={text:''};
            async function setup(options:{enabled:boolean;floating?:boolean}):Promise<void> {
                const engine=await createEngine({}, {
                    useHighPrecisionMatrix:options.enabled,
                    useFloatingOrigin:options.floating===true,
                });
                target.text=String(options.floating===true);
            }
            setup({enabled:${enabled},floating:${enabled}}).catch(error=>console.error(error));
        `);
        assert.equal(
            result.manifest.features.includes("renderer:high-precision-matrix"),
            enabled,
        );
        assert.equal(
            result.manifest.features.includes("renderer:floating-origin"),
            enabled,
        );
    }
});

test("stored runtime record factories retain explicit shape refusals", () => {
    assert.throws(
        () =>
            compileSource(`
        function build(enabled:boolean):number {
            const extra:Record<string,unknown>={};
            if(enabled)extra.active=1;
            return Object.keys(extra).length;
        }
        const callbacks:Array<(enabled:boolean)=>number>=[build];
        callbacks[0]!(true);
    `),
        /A compile-time record cannot be populated from runtime control flow/,
    );
    assert.throws(
        () =>
            compileSource(`
        function build(key:string):number {
            const extra:Record<string,unknown>={};
            extra[key]=1;
            return Object.keys(extra).length;
        }
        const callbacks:Array<(key:string)=>number>=[build];
        callbacks[0]!('active');
    `),
        /A compile-time record assignment requires a static string key/,
    );
});
