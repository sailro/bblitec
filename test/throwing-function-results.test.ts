import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("throwing value functions preserve result types, exception identity and operand order", (t) => {
    const source = `
        interface Item { value:number; before?(amount:number):void; after(amount:number):void; }
        const item:Item={value:1,after(amount){this.value+=amount;}};
        const expected=new Error('expected');
        const other=new Error('other');
        let trace='';
        let failures=0;
        function receiver():Item {trace+='r';throw expected;}
        function key():'before'|'after' {trace+='k';return 'after';}
        function argument():number {trace+='a';return 2;}
        function failedKey():'before'|'after' {trace+='k';throw expected;}
        function failedArgument():number {trace+='a';throw expected;}
        function scalar():number {trace+='n';throw expected;}
        function record(flag:boolean):Item {trace+='b';if(flag)throw expected;throw other;}
        function finalized():number {try {trace+='t';throw expected;}finally {trace+='f';}}
        try {receiver()[key()]?.(argument());} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='r'||failures!==1)throw new Error('receiver order');
        trace='';
        try {item[failedKey()]?.(argument());} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='k'||failures!==2||item.value!==1)throw new Error('key order');
        trace='';
        try {item[key()]?.(failedArgument());} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='ka'||failures!==3||item.value!==1)throw new Error('argument order');
        trace='';
        try {const unused=scalar()+argument();void unused;} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='n'||failures!==4)throw new Error('scalar order');
        trace='';
        try {const unused=record(failures===4).value;void unused;} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='b'||failures!==5)throw new Error('record branch');
        trace='';
        try {const unused=finalized()+argument();void unused;} catch(error) {if(error!==expected)throw error;failures++;}
        if(trace!=='tf'||failures!==6)throw new Error('finally order');
        trace='';
        item['before']?.(failedArgument());
        let nullable:Item|null=null;
        nullable?.[failedKey()]?.(failedArgument());
        if(trace!==''||failures!==6)throw new Error('absent call operands');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("The native fixture compiler is unavailable.");
    runGeneratedProgram(tools, "throwing-function-results", result.cpp);
});

test("throwing void functions cannot become represented result values", () => {
    assert.throws(
        () =>
            compileSource(`
        function fail():void {throw new Error('expected');}
        fail()['callback']?.();
    `),
        /Element access is not supported for void/,
    );
});

test("throwing native-owner functions cannot invent owner provenance", () => {
    assert.throws(
        () =>
            compileSource(`
        import type { Mesh } from '@babylonjs/lite';
        function fail():Mesh {throw new Error('expected');}
        const position=fail().position;
    `),
        /A mesh value is not associated with an engine/,
    );
});
