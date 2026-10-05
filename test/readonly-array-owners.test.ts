import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function check(name: string, source: string, cycles = false): void {
    test(name, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        const cpp = cycles
            ? `#define main generated_main
${result.cpp}
#undef main
int main() {
    const auto initial = bbl::js::managed_node_count();
    for (int i = 0; i < 20; ++i) {
        if (generated_main() != 0) return 1;
        bbl::js::collect_cycles();
        if (bbl::js::managed_node_count() != initial) return 2;
    }
}
`
            : result.cpp;
        runGeneratedProgram(tools, `readonly-array-owners/${name}`, cpp, {
            timeoutMs: 10000,
            expectedOutput: "",
        });
    });
}

check(
    "stored callbacks retain readonly arrays and observe later growth",
    `
interface Item { value:number }
const saved:Array<readonly Item[]>=[];
const stores:Array<(items:readonly Item[])=>void>=[items=>saved.push(items)];
const input:Item[]=[{value:1}];
stores[0]!(input);
stores[0]!(input);
input[0]!.value=7;
for(let i=0;i<64;i++) input.push({value:i});
if(saved[0]!==input||saved[1]!==input||saved[0]!.length!==65||saved[0]![0]!.value!==7)
    throw new Error('retained identity and growth');
`,
);

check(
    "native readonly parameters retain their owner through returned records",
    `
interface Item { value:number }
function select(items:readonly Item[]):{items:readonly Item[]} {
    const chosen=items.length?items:[{value:3}];
    return {items:chosen};
}
function create(seed:number):{items:readonly Item[]} {
    const items:Item[]=[{value:seed}];
    return select(items);
}
const input:Item[]=[{value:1}];
const result=select(input);
if(result.items!==input)throw new Error('owner');
input.push({value:4});
if(result.items.length!==2||result.items[1]!.value!==4)throw new Error('growth');
const first=create(5),second=create(6);
if(first.items===second.items||first.items[0]!.value!==5||second.items[0]!.value!==6)
    throw new Error('factory lifetime');
const fallback=select([]);
if(fallback.items[0]!.value!==3)throw new Error('fallback lifetime');
`,
);

check(
    "numeric tuples retain one array identity across readonly callbacks",
    `
function total(values:readonly number[]):number {return values.reduce((a,b)=>a+b,0);}
function retain(values:readonly number[]):()=>readonly number[] {return ()=>values;}
const calls:Array<typeof retain>=[retain];
const tuple:[number,number,number]=[1,2,3];
const read=calls[0]!(tuple);
const result=read();
if(result!==tuple||total(tuple)!==6)throw new Error('tuple transport');
tuple[1]=9;
if(result[1]!==9||read()!==result||total(tuple)!==13)throw new Error('tuple alias');
`,
);

check(
    "readonly array equality compares owners including nullable empty arrays",
    `
function same(left:readonly number[],right:readonly number[]):boolean {return left===right;}
function maybeSame(left:readonly number[]|null,right:readonly number[]|null):boolean {return left===right;}
const comparisons:Array<typeof same>=[same];
const nullable:Array<typeof maybeSame>=[maybeSame];
const first:number[]=[],second:number[]=[];
if(!same(first,first)||same(first,second)||!comparisons[0]!(first,first)||comparisons[0]!(first,second))
    throw new Error('empty identities');
first.push(1);second.push(1);
if(same(first,second)||!nullable[0]!(first,first)||nullable[0]!(first,null)||!nullable[0]!(null,null))
    throw new Error('nullable identities');
`,
);

check(
    "readonly callback owners participate in cycle collection",
    `
interface Row { value:number; read:()=>readonly Row[] }
function keep(rows:readonly Row[]):()=>readonly Row[] {return ()=>rows;}
function create():void {
    const rows:Row[]=[];
    const holders:Array<typeof keep>=[keep];
    const read=holders[0]!(rows);
    rows.push({value:3,read});
    if(read()!==rows||rows[0]!.read()!==rows||read()[0]!.value!==3)
        throw new Error('cycle owner');
}
create();
`,
    true,
);

check(
    "readonly readers consume stable table views without owning conversions",
    `
const table:readonly(readonly number[])[]=[[1,2],[3,4]];
function row(i:number):readonly number[]{return table[i]!;}
function sum(values:readonly number[]):number{return values.reduce((a,b)=>a+b,0);}
if(sum(row(0))!==3||sum(row(1))!==7)throw new Error('table view');
`,
);

test("array views without represented owners refuse reference equality", () => {
    for (const type of ["ArrayLike<number>", "ArrayLike<number>|null"]) {
        assert.throws(
            () =>
                compileSource(`
function same(left:${type},right:${type}):boolean {return left===right;}
const calls:Array<typeof same>=[same];
const first:number[]=[],second:number[]=[];
if(calls[0]!(first,second))throw new Error('different owners');
`),
            /A borrowed array view cannot preserve JavaScript object identity in a comparison/,
        );
    }
});
