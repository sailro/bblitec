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
        const native = optionalNativeFixtureTools(false);
        if (!native) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            native,
            `class-field-initialization/${name}`,
            result.cpp,
        );
    });
}

check(
    "constructor tuple fields keep typed mutable storage",
    `
    type Triple=[number,number,number];
    class Position {
        readonly origin:Triple;
        readonly label:string;
        constructor(seed:Triple,label:string) {
            this.origin=[seed[0],seed[1],seed[2]];
            this.label=label;
        }
        advance(delta:number):void {
            this.origin[0]+=delta;
            this.origin[1]=this.origin[0]*2;
        }
    }
    const seed:Triple=[1,2,3];
    const first=new Position(seed,'first');
    first.advance(4);
    const alias=first.origin;
    alias[2]=9;
    if(first.origin[0]!==5||first.origin[1]!==10||first.origin[2]!==9||
       seed[0]!==1||first.label!=='first')throw new Error('tuple field');
    let total=0;
    for(let value=2;value<=4;value+=2) {
        const position=new Position([value,0,0],'runtime');
        position.advance(1);
        total+=position.origin[0]+position.origin[1];
    }
    if(total!==24)throw new Error('runtime tuple constructor');
`,
);

check(
    "runtime constructors retain record and collection argument identities",
    `
    interface State {value:number;}
    let effects='';
    const states:State[]=[{value:1},{value:4}];
    const counts=new Map<string,number>();
    function state(index:number):State {effects+='s';return states[index]!;}
    function collection():Map<string,number> {effects+='m';return counts;}
    class Holder {
        readonly state:State;
        readonly counts:Map<string,number>;
        private readonly initial:number;
        constructor(value:State,counts:Map<string,number>) {
            effects+='c';
            this.state=value;
            this.counts=counts;
            this.initial=value.value;
        }
        update():number {
            this.state.value+=2;
            this.counts.set('last',this.state.value);
            return this.initial;
        }
    }
    let originals=0;
    for(let index=0;index<2;index++) {
        const holder=new Holder(state(index),collection());
        originals+=holder.update();
        if(holder.state!==states[index]||holder.counts!==counts)
            throw new Error('field identity');
    }
    if(originals!==5||states[0]!.value!==3||states[1]!.value!==6||
       counts.get('last')!==6||effects!=='smcsmc')throw new Error('constructor order');
`,
);
