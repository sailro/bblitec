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
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Requires the Windows native fixture compiler.");
            return;
        }
        runGeneratedProgram(
            tools,
            `contextual-record-arguments/${name}`,
            result.cpp,
            { timeoutMs: 10000, expectedOutput: "" },
        );
    });
}

check(
    "fresh record arguments retain generic callback containers",
    `
    interface Scope { releases:(()=>void)[]; disposed:boolean; }
    interface Box { value:number; }
    function own<T>(scope:Scope,value:T,release:(value:T)=>void):T {
        if(scope.disposed) {release(value);throw new Error('disposed');}
        scope.releases.push(()=>release(value));
        return value;
    }
    function owner(scope:Scope) {return {
        keep(box:Box,release:(box:Box)=>void) {return own(scope,box,release);},
        flush() {for(const release of scope.releases)release();scope.releases.length=0;scope.disposed=true;}
    };}
    const values:number[]=[];
    const list=owner({releases:[],disposed:false});
    const a:Box={value:1},b:Box={value:2};
    if(list.keep(a,box=>values.push(box.value))!==a)throw new Error('first identity');
    if(list.keep(b,box=>values.push(box.value))!==b)throw new Error('second identity');
    a.value=7;b.value=9;list.flush();list.flush();
    if(values.length!==2 || values[0]!==7 || values[1]!==9)throw new Error('live callback order');
`,
);

check(
    "contextual record containers retain aliases and replacement",
    `
    interface Scope { releases:(()=>void)[]; }
    const values:number[]=[];
    const first:(()=>void)[]=[];
    const second:(()=>void)[]=[];
    function bind(scope:Scope) {return {
        add(release:()=>void){scope.releases.push(release);},
        replace(releases:(()=>void)[]){scope.releases=releases;},
        flush(){for(const release of scope.releases)release();}
    };}
    const list=bind({releases:first});
    first.push(()=>values.push(1));list.add(()=>values.push(2));list.flush();
    list.replace(second);list.add(()=>values.push(3));second.push(()=>values.push(4));list.flush();
    if(first.length!==2 || second.length!==2 || values.join(',')!=='1,2,3,4')throw new Error('collection alias');
`,
);

check(
    "contextual containers reuse a previously aliased inferred list",
    `
    interface Scope { releases:(()=>void)[]; }
    const values:number[]=[];let created=0;
    function create(value:number):()=>void {created++;return ()=>values.push(value);}
    const callbacks=[create(1)];
    const before=callbacks;
    function register(scope:Scope):void {scope.releases.push(create(2));}
    register({releases:callbacks});
    if(callbacks!==before || before.length!==2 || created!==2)throw new Error('raw list owner');
    before[1]!();callbacks[0]!();
    if(values.join(',')!=='2,1')throw new Error('raw list callbacks');
`,
);

check(
    "contextual collection arguments evaluate once before later effects",
    `
    interface Scope { releases:(()=>void)[]; }
    const order:number[]=[];
    const callbacks:(()=>void)[]=[];
    function create(value:number):()=>void {order.push(value);return ()=>order.push(value+10);}
    function later():number {order.push(2);callbacks.push(create(3));return 0;}
    function run(scope:Scope,unused:number):void {void unused;scope.releases.push(create(4));for(const release of scope.releases)release();}
    run({releases:[create(1)]},later());
    if(order.join(',')!=='1,2,3,4,11,14' || callbacks.length!==1)throw new Error('argument order');
    run({releases:callbacks},0);
    if(order.join(',')!=='1,2,3,4,11,14,4,13,14' || callbacks.length!==2)throw new Error('argument alias');
`,
);

test("read-only contextual records keep nested composition facts", () => {
    const result = compileSource(`
        import {createEngine,createComputeShader,type EngineContext} from '@babylonjs/lite';
        function configure(engine:EngineContext,options:{shader:{source:string};sources:string[];entryPoint?:string}) {
            createComputeShader(engine,{computeSource:options.shader.source,entryPoint:options.entryPoint??'main',bindings:[]});
            return createComputeShader(engine,{computeSource:options.sources[0]!,bindings:[]});
        }
        async function main() {
            const engine=await createEngine(document.getElementById('renderCanvas') as HTMLCanvasElement);
            configure(engine,{shader:{source:'@compute @workgroup_size(1) fn main() {}'},sources:['@compute @workgroup_size(2) fn main() {}']});
        }
        void main();
    `);
    assert.deepEqual(
        result.manifest.computePrograms?.map((program) => program.source),
        [
            "@compute @workgroup_size(1) fn main() {}",
            "@compute @workgroup_size(2) fn main() {}",
        ],
    );
});
