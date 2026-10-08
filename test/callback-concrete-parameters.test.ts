import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string): void {
    test(name, async (t) => {
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
                `callback-concrete-parameters/${name}`,
                result.cpp,
            );
        });
    });
}

check(
    "captured-parameters-retain-concrete-native-children",
    `
    interface Clock { getTime():number; setTime(value:number):number; }
    interface Options { clock:Clock|null; }
    function advance(clock:Clock|null):number {
        if(!clock)return -1;
        return clock.setTime(clock.getTime()+1);
    }
    function build(options:Options):()=>number {
        return ()=>advance(options.clock);
    }
    const retained:Array<typeof build>=[build];
    if(retained.length!==1)throw new Error('retained function');
    const first=new Date(10);
    const literal=build({clock:first});
    first.setTime(20);
    if(literal()!==21 || first.getTime()!==21)throw new Error('native child alias');
    const options={clock:first};
    const aliased=build(options);
    const replacement=new Date(30);
    options.clock=replacement;
    if(aliased()!==31 || replacement.getTime()!==31)throw new Error('parent alias');
    if(first.getTime()!==21)throw new Error('replaced child');
    if(build({clock:null})()!==-1)throw new Error('null child');
    let reads=0;
    const owner={get clock():Date { reads++; return first; }};
    if(advance(owner.clock)!==22 || reads!==1)throw new Error('getter evaluated once');
    `,
);

check(
    "stored-arraylike-parameters-borrow-typed-arrays",
    `
    function read(input:ArrayLike<number>):number { return input[0]!; }
    const retained:Array<typeof read>=[read];
    const input=new Float32Array([3]);
    if(retained[0]!(input)!==3)throw new Error('initial view');
    input[0]=7;
    if(retained[0]!(input)!==7)throw new Error('updated view');
    function visit(limit:number):number {
        const walk=(index:number,values:ArrayLike<number>):number=>{
            if(index===limit)return values[0]!;
            const next=new Float32Array([values[0]!+1]);
            return walk(index+1,next);
        };
        return walk(0,input);
    }
    const visits:Array<typeof visit>=[visit];
    if(visits[0]!(2)!==9)throw new Error('recursive view');
    `,
);
