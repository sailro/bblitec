import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [name, source] of [
    [
        "array references",
        `
        const items: Array<number | undefined> = [0, 0, undefined, 4];
        let index = 0, calls = 0;
        const first = (items[index++] ||= ++calls);
        const second = (items[index++] &&= ++calls);
        const third = (items[index++] ??= ++calls);
        items[index++] &&= ++calls;
        if (index !== 4 || calls !== 3 || first !== 1 || second !== 0 || third !== 2 || items[0] !== 1 || items[1] !== 0 || items[2] !== 2 || items[3] !== 3)
            throw new Error('key and lazy result');
        let values: unknown[] = [0];
        const original = values;
        index = 0;
        function replaceArray(): number {values = [9]; original.push(0); return 7;}
        const selected = (values[index++] ||= replaceArray());
        if (index !== 1 || selected !== 7 || original[0] !== 7 || values[0] !== 9)
            throw new Error('array owner and growth');
        const kept = (original[0] ||= ++calls);
        original[0] = 12;
        if (kept !== 7 || calls !== 3) throw new Error('result snapshot');
        let amount = 0;
        const stored = (amount ||= 6);
        amount = 8;
        let enabled = false;
        const accepted = (enabled ||= true);
        enabled = false;
        if (stored !== 6 || !accepted || amount !== 8 || enabled) throw new Error('local result snapshot');
    `,
    ],
    [
        "record and dictionary references",
        `
        let owner = {amount: 0};
        const original = owner;
        function replaceOwner(): number {owner = {amount: 9}; return 7;}
        const result = (owner.amount ||= replaceOwner());
        if (result !== 7 || original.amount !== 7 || owner.amount !== 9)
            throw new Error('record owner');
        const replacement = {amount: 13};
        original.amount = 0;
        owner = original;
        owner[(owner = replacement, 'amount')] ||= 11;
        if (original.amount !== 11 || replacement.amount !== 13) throw new Error('owner before key');
        let entries: Record<string, number> = {a: 0};
        const prior = entries;
        const keys = ['a', 'b'];
        let index = 0;
        function replaceEntries(): number {entries = {a: 99}; return 5;}
        const chosen = (entries[keys[index++]] ||= replaceEntries());
        if (chosen !== 5 || index !== 1 || prior.a !== 5 || entries.a !== 99)
            throw new Error('dictionary key and owner');
        const parsed = JSON.parse('{"nil":null,"zero":0}');
        parsed.nil ??= 7;
        parsed.zero ??= 8;
        if (parsed.nil !== 7 || parsed.zero !== 0) throw new Error('entry nullish value');
    `,
    ],
    [
        "accessor references",
        `
        let reads=0,writes=0,backing=0;
        const record={get amount():number{reads++;return backing;},set amount(value:number){writes++;backing=value+1;}};
        const records:Array<typeof record>=[record];
        const selected=(records[0]!.amount ||= 5);
        if(selected!==5||backing!==6||reads!==1||writes!==1)throw new Error('accessor selected RHS');
        const skipped=(records[0]!.amount ||= 8);
        if(skipped!==6||reads!==2||writes!==1)throw new Error('accessor previous value');
        records[0]!.amount &&= 9;
        if(backing!==10||reads!==3||writes!==2)throw new Error('accessor statement store');
    `,
    ],
    [
        "tagged record references",
        `
        interface Cell{value:number}
        const items:Array<Cell|null|undefined>=[undefined,null,{value:0}];
        let index=0;
        const selected=(items[index++] ??= {value:3});
        if(index!==1||selected!==items[0]||selected.value!==3||items[1]!==null||items[2]===undefined)throw new Error('tagged array selected');
        items[0]=undefined;
        if(selected.value!==3||items[0]!==undefined)throw new Error('tagged result snapshot');
        let held:Cell|null|undefined;
        let calls=0;
        function clear():void{held=undefined;}
        function replacement():Cell{calls++;return {value:4};}
        const chosen=(held ??= {value:3});
        clear();
        if(chosen.value!==3||held!==undefined)throw new Error('tagged local result');
        held=null;
        const absent=(held &&= replacement());
        if(absent!==null||calls!==0)throw new Error('tagged null result');
    `,
    ],
    [
        "array call references",
        `
let owners=0,keys=0,rights=0;
let current:Array<number|undefined>=[undefined];const original=current;
function owner():Array<number|undefined>{owners++;return current;}
function key():number{keys++;return 0;}
function right():number{rights++;current=[99];original.push(8);return 7;}
const selected=(owner()[key()] ??= right());
if(selected!==7||owners!==1||keys!==1||rights!==1||original[0]!==7||current[0]!==99)throw new Error('array calls');
const skipped=(owner()[key()] ||= right());
if(skipped!==99||owners!==2||keys!==2||rights!==1)throw new Error('array calls skip');
`,
    ],
    [
        "dictionary call references",
        `
let owners=0,keys=0,rights=0;
let current:Record<string,number>={a:0};const original=current;
function owner():Record<string,number>{owners++;return current;}
function key():string{keys++;current={a:99};return 'a';}
function right():number{rights++;return 7;}
const selected=(owner()[key()] ||= right());
if(selected!==7||owners!==1||keys!==1||rights!==1||original.a!==7||current.a!==99)throw new Error('dictionary calls');
const skipped=(owner()[key()] ||= right());
if(skipped!==99||owners!==2||keys!==2||rights!==1)throw new Error('dictionary calls skip');
`,
    ],
    [
        "record call references",
        `
let owners=0,keys=0,rights=0;
let current={a:0};const original=current;
function owner(){owners++;return current;}
function key():'a'{keys++;current={a:99};return 'a';}
function right():number{rights++;return 7;}
const selected=(owner()[key()] ||= right());
if(selected!==7||owners!==1||keys!==1||rights!==1||original.a!==7||current.a!==99)throw new Error('record calls');
const skipped=(owner().a ||= right());
if(skipped!==99||owners!==2||keys!==1||rights!==1)throw new Error('record calls skip');
`,
    ],
    [
        "accessor call references",
        `
let owners=0,keys=0,rights=0,reads=0,writes=0;
function create(seed:number){return {a:seed,b:seed,get first():number{reads++;return this.a;},set first(value:number){writes++;this.a=value+10;},get second():number{reads++;return this.b;},set second(value:number){writes++;this.b=value+20;}};}
let current=create(0);const original=current,replacement=create(99);
function owner(){owners++;return current;}
const names:Array<'first'|'second'>=['first','second'];
function key():'first'|'second'{return names[keys++]!;}
function right():number{rights++;current=replacement;return 7;}
const selected=(owner()[key()] ||= right());
if(selected!==7||owners!==1||keys!==1||rights!==1||reads!==1||writes!==1||original.a!==17||current.a!==99)throw new Error('accessor calls');
const skipped=(owner()[key()] ||= right());
if(skipped!==99||owners!==2||keys!==2||rights!==1||reads!==2||writes!==1)throw new Error('accessor calls skip');
`,
    ],
] as const) {
    test(`logical assignments retain ${name} and selected values`, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
        );
        const { cpp } = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `logical-assignment-references/${name.replaceAll(" ", "-")}`,
            cpp,
        );
    });
}
