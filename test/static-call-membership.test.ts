import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const inheritedNames = Object.getOwnPropertyNames(Object.prototype);
const cases = [
    {
        name: "absent-optional-callbacks-suppress-arguments",
        source: `
let argumentsRun=0,calls=0;
function argument():number{argumentsRun++;return 5;}
function invoke(callback?:((value:number)=>number)|null):number{
 return callback?.(argument())??17;
}
if(invoke()!==17||invoke(undefined)!==17||invoke(null)!==17||argumentsRun!==0)
 throw new Error('absent invocation');
if(invoke(value=>{calls++;return value+1;})!==6||argumentsRun!==1||calls!==1)
 throw new Error('present invocation');
function omitted(callback?:(value:unknown)=>void):void{
 callback?.(new FinalizationRegistry(()=>{}));
}
omitted();
`,
    },
    {
        name: "async-optional-callbacks-retain-order-and-lifetime",
        realm: true,
        source: `
let argumentsRun=0;
function argument():number{argumentsRun++;return 3;}
function make(){
 return {async run<T>(operation:()=>T|Promise<T>,prepare?:((value:number)=>void)|null):Promise<T>{
  prepare?.(argument());await Promise.resolve();return await operation();
 }};
const owner={count:0};
(async()=>{
 const api=make();
 if(await api.run<number>(()=>7)!==7||argumentsRun!==0)throw new Error('missing callback');
 if(await api.run<number>(()=>8,null)!==8||argumentsRun!==0)throw new Error('null callback');
 const pending=api.run<number>(()=>owner.count,value=>{owner.count+=value;});
 if(owner.count!==3||argumentsRun!==1)throw new Error('synchronous preparation');
 if(await pending!==3)throw new Error('retained owner');
 globalThis.close();
})();
`,
    },
    {
        name: "static-membership-prunes-branches-with-prototype-semantics",
        source: `
type Choice={flag:string}|{all:readonly {flag:string}[]};
function match(value:Choice):boolean{
 if('flag' in value)return value.flag==='yes';
 for(const child of value.all){if(child.flag!=='yes')return false;}
 return true;
}
if(!match({all:[{flag:'yes'}]})||match({all:[{flag:'no'}]}))throw new Error('union branch');
const literal={all:true};
if('absent' in literal)new FinalizationRegistry(()=>{});
if(!('all' in literal))throw new Error('own field');
${inheritedNames.map((name) => `if(!(${JSON.stringify(name)} in literal)||Object.hasOwn(literal,${JSON.stringify(name)}))throw new Error('prototype field');`).join("\n")}
const names:string[]=${JSON.stringify([...inheritedNames, "absent"])};
let matches=0;
for(const name of names)if(name in literal)matches++;
if(matches!==${inheritedNames.length})throw new Error('dynamic prototype membership');
let order='';
function key():'absent'{order+='K';return 'absent';}
function owner():{all:boolean}{order+='O';return {all:true};}
if(key() in owner())throw new Error('absent key');
if(order!=='KO')throw new Error('membership evaluation order');
`,
    },
];

for (const { name, source, realm } of cases) {
    test(name, async (t) => {
        await runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
            { close: () => {} },
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `static-call-membership/${name}`,
            result.cpp,
            {
                flags: realm ? ["/DBBLITE_WORKERS=1"] : [],
                timeoutMs: 10000,
            },
        );
    });
}

test("a required call of an absent callback remains a refusal", () => {
    assert.throws(
        () =>
            compileSource(
                `function run(callback?:()=>void):void{callback!();}run();`,
            ),
        /Call 'callback' does not resolve/,
    );
});
