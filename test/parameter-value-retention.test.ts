import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("captured parameters retain argument values across caller reassignment", async (t) => {
    const source = `
        function keepMap(value:Map<number,number>) {
            return {read:()=>value.get(1),write:(next:number)=>value.set(1,next)};
        }
        let map=new Map<number,number>([[1,2]]);
        const original=map;
        const first=keepMap(map);
        map=new Map<number,number>([[1,7]]);
        const second=keepMap(map);
        if(first.read()!==2 || second.read()!==7)throw new Error('map parameter binding');
        first.write(3);
        if(original.get(1)!==3 || map.get(1)!==7)throw new Error('map shared identity');

        function keepSet(value:Set<number>) {return ()=>value.has(4);}
        let set=new Set<number>([4]);
        const originalSet=set, readSet=keepSet(set);
        set=new Set<number>();
        if(!readSet())throw new Error('set parameter binding');
        originalSet.delete(4);
        if(readSet())throw new Error('set shared identity');

        function keepArray(value:number[]) {return ()=>value[0];}
        let array=[5];
        const originalArray=array, readArray=keepArray(array);
        array=[8]; originalArray[0]=6;
        if(readArray()!==6)throw new Error('array parameter binding');

        function keepView(value:Float32Array) {return ()=>value[0];}
        let view=new Float32Array([9]);
        const originalView=view, readView=keepView(view);
        view=new Float32Array([10]); originalView[0]=11;
        if(readView()!==11)throw new Error('typed view parameter binding');

        function keepRecord(value:{item:number}) {return ()=>value.item;}
        let record={item:12};
        const originalRecord=record, readRecord=keepRecord(record);
        record={item:13}; originalRecord.item=14;
        if(readRecord()!==14)throw new Error('record parameter binding');

        function keepString(value:string) {return ()=>value;}
        let text='first';
        const readText=keepString(text);
        text='second';
        if(readText()!=='first')throw new Error('string parameter binding');

        function readAfter(value:Map<number,number>,run:()=>void):number {
            run(); return value.get(1)!;
        }
        if(readAfter(map,()=>{map=new Map<number,number>([[1,19]]);})!==7)
            throw new Error('argument value during reentrant reassignment');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "parameter-value-retention/caller-reassignment",
            result.cpp,
        );
    });
});
