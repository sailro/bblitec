import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("computed optional methods retain their receiver and lazy argument order", (t) => {
    const source = `
        interface Item {value:number;before?(n:number):void;after(n:number):void;}
        const first:Item={value:1,before(n){this.value+=n;},after(n){this.value*=n;}};
        const second:Item={value:3,after(n){this.value-=n;}};
        const rows=[first,second] as const;
        let effects=0;
        function argument():number {effects++;return 2;}
        function run(step:'before'|'after'):void {
            for(const row of rows)row[step]?.(argument());
        }
        const runners:Array<typeof run>=[run];
        runners[0]!('before');runners[0]!('after');
        if(first.value!==6||second.value!==1||effects!==3)
            throw new Error('receiver or lazy arguments');
        let owner=first;
        let trace='';
        function receiver():Item {trace+='r';return owner;}
        function key():'before'|'after' {trace+='k';owner=second;return 'before';}
        function value():number {trace+='a';owner=second;return 3;}
        receiver()[key()]?.(value());
        if(trace!=='rka'||first.value!==9||second.value!==1)throw new Error('call receiver');
        owner=first;trace='';
        owner[key()]?.(value());
        if(trace!=='ka'||first.value!==12||second.value!==1)throw new Error('named receiver');
        function replace():number {trace+='a';first.before=undefined;return 4;}
        owner=first;trace='';
        owner[key()]?.(replace());
        if(trace!=='ka'||first.value!==16)throw new Error('selected callback snapshot');
        owner=first;trace='';
        owner[key()]?.(value());
        if(trace!=='k'||first.value!==16)throw new Error('absent callback arguments');
        let nullable:Item|null=null;
        trace='';nullable?.[key()]?.(value());
        if(trace!=='')throw new Error('absent receiver key');
        nullable=second;trace='';
        nullable?.['after']?.(value());
        if(trace!=='a'||second.value!==-2)throw new Error('present optional receiver');
        function failingReceiver():Item {trace+='r';if(effects===3)throw new Error('receiver');return second;}
        function failingKey():'before'|'after' {trace+='k';if(effects===3)throw new Error('key');return 'after';}
        function failingArgument():number {trace+='a';if(effects===3)throw new Error('argument');return 1;}
        let failures=0;
        trace='';
        try {failingReceiver()[key()]?.(value());}catch {failures++;}
        if(trace!=='r'||failures!==1)throw new Error('receiver throw order');
        trace='';
        try {second[failingKey()]?.(value());}catch {failures++;}
        if(trace!=='k'||failures!==2)throw new Error('key throw order');
        trace='';
        try {second['after']?.(failingArgument());}catch {failures++;}
        if(trace!=='a'||failures!==3||second.value!==-2)throw new Error('argument throw order');
        const action=(amount:number):void=>{effects+=amount;};
        const callbacks={first:action,second:action};
        function select(name:'first'|'second') {return callbacks[name];}
        if(select('first')!==select('second')||select('first')!==action)
            throw new Error('callback identity');
        const name:'first'|'second'=effects===3?'first':'second';
        callbacks[name]?.(5);
        if(effects!==8)throw new Error('computed callback call');
        const previous=first.value++;
        const next=++first.value;
        if(previous!==16||next!==18||first.value!==18)throw new Error('numeric accessor updates');
        function replaceValue():number{first.value=100;return 2;}
        first.value+=replaceValue();
        if(first.value!==20)throw new Error('accessor read precedes RHS');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(tools, "computed-method-calls", result.cpp);
});

test("computed method extraction keeps dynamic this refusal", () => {
    assert.throws(
        () =>
            compileSource(`
        interface Item {value:number;first():void;second():void;}
        const owner:Item={value:0,first(){this.value++;},second(){this.value--;}};
        function extract(key:'first'|'second') {return owner[key];}
        extract('first')();
    `),
        /reads its function value, which could call it with another receiver/,
    );
});
