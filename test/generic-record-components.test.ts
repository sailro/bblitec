import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import {
    instantiatedRecord,
    recordComponents,
    recordIdentity,
} from "../src/compiler/record-components.js";
import { ReplayStorage } from "../src/compiler/replay-storage.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, (t) => {
        const fileName = resolve(`${name}.ts`);
        const { program } = createCompilerProgram(source, fileName);
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
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
        const result = compileSource(source, { fileName });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `generic-record-components/${name}`,
            result.cpp,
        );
    });
}

const commandFactory = `
    type Result<K extends string> = {changed:true;value:number}|{changed:false;reason:K|'skip'};
    interface Command<K extends string> {run(value:number):Result<K>}
    function create<K extends string>(missing:K):Command<K> {
        type Outcome=Result<K>;
        const history:Outcome[]=[];
        const refuse=(reason:Exclude<Outcome,{changed:true}>['reason']):Outcome=>{
            const result:Outcome={changed:false,reason};
            history.push(result);
            return history[history.length-1]!;
        };
        const pick=(value:number):Outcome=>value>0?{changed:true,value}:refuse(missing);
        return {run:value=>pick(value)};
    }
`;

check(
    "retained-generic-factory-results",
    commandFactory +
        `
    function first():Command<'missing'>{return create<'missing'>('missing');}
    function second():Command<'empty'>{return create<'empty'>('empty');}
    const factories:Array<typeof first>=[first];
    const commands=[factories[0]!()];
    const other=[second()];
    const run=commands[0]!.run;
    if(run!==commands[0]!.run)throw new Error('callback identity');
    const result=run(0);
    const different=other[0]!.run(0);
    if(result.changed || result.reason!=='missing' || different.changed || different.reason!=='empty')
        throw new Error('factory substitutions');
    const success=run(4);
    if(!success.changed || success.value!==4)throw new Error('conditional success');
    const alias=result;
    alias.reason='skip';
    if(String(result.reason)!=='skip')throw new Error('result alias');
`,
);

check(
    "generic-record-parameter-and-result-aliases",
    `
    interface Cell<T>{value:T}
    interface Store<T>{read():Cell<T>;replace(value:Cell<T>):Cell<T>}
    function create<T>(initial:Cell<T>):Store<T>{
        let current=initial;
        return {read:()=>current,replace:value=>{const previous=current;current=value;return previous;}};
    }
    function numbers():Store<number>{return create<number>({value:3});}
    function strings():Store<string>{return create<string>({value:'start'});}
    const factories:Array<typeof numbers>=[numbers];
    const numeric=[factories[0]!()];
    const text=[strings()];
    const before=numeric[0]!.read();
    const next={value:8};
    if(numeric[0]!.replace(next)!==before || numeric[0]!.read()!==next)throw new Error('record aliases');
    next.value=9;
    if(numeric[0]!.read().value!==9 || text[0]!.read().value!=='start')throw new Error('separate substitutions');
    const nextText={value:'end'};
    text[0]!.replace(nextText);
    if(text[0]!.read()!==nextText)throw new Error('string aliases');
`,
);

check(
    "generic-conditional-result-presence",
    `
    interface Speeds {walk?:number;run?:number;carryWalk?:number;carryRun?:number}
    interface Profile {speeds?:{walk:number;run:number;carryWalk:number;carryRun:number}}
    function choose(recipe:Pick<Speeds,'walk'|'run'>,model:Profile):Speeds {
        const own=model.speeds;
        return own?{walk:own.walk,run:own.run,carryWalk:own.carryWalk,carryRun:own.carryRun}:{walk:recipe.walk,run:recipe.run};
    }
    const choices:Array<typeof choose>=[choose];
    const values=[choices[0]!({walk:2},{speeds:{walk:3,run:4,carryWalk:5,carryRun:6}}),choices[0]!({walk:2},{})];
    if(values[0]!.carryWalk!==5 || Object.hasOwn(values[1]!,'carryWalk') || !Object.hasOwn(values[1]!,'run'))
        throw new Error('conditional own fields');
`,
);

check(
    "optional-scalar-record-own-undefined",
    `
    interface State {count?:number;label?:string;enabled?:boolean;tag?:'ready'|'done'}
    function create(present:boolean):State {
        return present?{count:undefined,label:undefined,enabled:undefined,tag:undefined}:{};
    }
    const factories:Array<typeof create>=[create];
    const present=factories[0]!(true), absent=factories[0]!(false);
    if(Object.keys(present).join(',')!=='count,label,enabled,tag' || Object.keys(absent).length!==0)
        throw new Error('own undefined');
    if(present.count!==undefined || present.label!==undefined || present.enabled!==undefined || present.tag!==undefined)
        throw new Error('undefined payload');
    const alias=present;
    delete alias.count;
    if(Object.hasOwn(present,'count') || !Object.hasOwn(present,'label'))throw new Error('independent keys');
    alias.count=4;
    alias.enabled=false;
    if(present.count!==4 || present.enabled!==false || !Object.hasOwn(present,'enabled'))throw new Error('mutable alias');
    function clear(state:State):void {state.count=undefined;state['enabled']=undefined;}
    const clearers:Array<typeof clear>=[clear];
    clearers[0]!(absent);
    if(!Object.hasOwn(absent,'count') || !Object.hasOwn(absent,'enabled') || absent.count!==undefined || absent.enabled!==undefined)
        throw new Error('own undefined after creation');
`,
);

test("record components and replay keep source instantiations separate", () => {
    const { checker, sourceFile } = createCompilerProgram(
        `
        interface Generic<T>{value:T}
        interface Numeric{value:number}
        interface Textual{value:string}
    `,
        resolve("generic-component-keys.ts"),
    );
    const declarations = sourceFile.statements.filter(
        ts.isInterfaceDeclaration,
    );
    const types = declarations.map((declaration) =>
        checker.getTypeAtLocation(declaration.name),
    );
    const [generic, numeric, textual] = types;
    assert.ok(generic && numeric && textual);
    const parameter = declarations[0]!.typeParameters![0]!;
    const parameterSymbol = checker.getTypeAtLocation(parameter).symbol;
    assert.ok(parameterSymbol);
    const numberArgument = checker.getTypeOfSymbol(
        numeric.getProperty("value")!,
    );
    const stringArgument = checker.getTypeOfSymbol(
        textual.getProperty("value")!,
    );
    const numbers = instantiatedRecord(generic, [numberArgument]);
    const strings = instantiatedRecord(generic, [stringArgument]);
    const joins = [
        {
            source: generic,
            target: numeric,
            sourceInstantiation: numbers,
            kind: "value" as const,
        },
        {
            source: textual,
            target: generic,
            targetInstantiation: strings,
            kind: "value" as const,
        },
    ];
    const components = recordComponents(checker, joins);
    assert.equal(
        components.get(numbers),
        components.get(recordIdentity(checker, numeric)),
    );
    assert.equal(
        components.get(strings),
        components.get(recordIdentity(checker, textual)),
    );
    assert.notEqual(components.get(numbers), components.get(strings));
    assert.equal(components.has(recordIdentity(checker, generic)), false);
    const storage = new ReplayStorage(checker);
    const numericRequest = {
        kind: "record" as const,
        demand: {
            identity: "record-component:0",
            instantiation: numbers,
            type: generic,
            node: parameter,
            frames: [new Map([[parameterSymbol, numberArgument]])],
            joins: [joins[0]!],
        },
    };
    const stringRequest = {
        kind: "record" as const,
        demand: {
            identity: "record-component:0",
            instantiation: strings,
            type: generic,
            node: parameter,
            frames: [new Map([[parameterSymbol, stringArgument]])],
            joins: [joins[1]!],
        },
    };
    assert.equal(storage.add(numericRequest), true);
    assert.equal(storage.add(stringRequest), true);
    assert.equal(storage.add(numericRequest), false);
    assert.equal(storage.records.size, 2);
    assert.equal(
        storage.records.get(numbers)?.frames[0]?.get(parameterSymbol),
        numberArgument,
    );
    assert.equal(
        storage.records.get(strings)?.frames[0]?.get(parameterSymbol),
        stringArgument,
    );
    assert.equal(storage.joinsAlreadyHeld(numericRequest), true);
    assert.equal(storage.joinsAlreadyHeld(stringRequest), true);
});

check(
    "optional-scalar-own-undefined-logical-and-assign",
    `
    interface Logical {value?:number}
    const logical:Logical[]=[{}];
    logical[0]!.value??=undefined;
    if(!Object.hasOwn(logical[0]!,'value') || logical[0]!.value!==undefined)throw new Error('logical own undefined');
    let calls=0;
    function missing():undefined {calls++;return undefined;}
    logical[0]!.value=2;
    logical[0]!.value??=missing();
    logical[0]!.value||=missing();
    if(calls!==0 || logical[0]!.value!==2)throw new Error('logical laziness');
    logical[0]!.value&&=missing();
    if(Number(calls)!==1 || !Object.hasOwn(logical[0]!,'value'))throw new Error('logical truthy store');
    const previous=logical[0]!;
    function replace():undefined {logical[0]={};return undefined;}
    logical[0]!.value??=replace();
    if(!Object.hasOwn(previous,'value') || Object.hasOwn(logical[0]!,'value'))throw new Error('logical target snapshot');
    interface Assigned {label?:string}
    const assigned:Assigned[]=[{}];
    Object.assign(assigned[0]!,{label:undefined});
    if(!Object.hasOwn(assigned[0]!,'label') || assigned[0]!.label!==undefined)throw new Error('assigned own undefined');
    interface Copy {enabled?:boolean}
    const source:{enabled:boolean|undefined}={enabled:undefined};
    const copies:Copy[]=[{...source}];
    if(!Object.hasOwn(copies[0]!,'enabled') || copies[0]!.enabled!==undefined)throw new Error('spread own undefined');
`,
);
