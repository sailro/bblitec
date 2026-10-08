import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const programs = {
    "nullable-logical-unions": `
        type Item={kind:'first';id:number}|{kind:'second';id:number};
        let leftReads=0,rightReads=0;
        function read(item:Item|null):Item|null {leftReads++;return item;}
        function text(item:Item):string|null {rightReads++;return item.kind==='first'?'item:'+item.id:null;}
        function select(item:Item|null):string|null {return read(item)&&text(item!);}
        const inputs:Array<Item|null>=[null,{kind:'first',id:2},{kind:'second',id:3}];
        if(select(inputs[0]!)!==null||leftReads!==1||rightReads!==0)throw new Error('absent lazy branch');
        if(select(inputs[1]!)!=='item:2'||leftReads!==2||rightReads!==1)throw new Error('selected branch');
        if(select(inputs[2]!)!==null||leftReads!==3||rightReads!==2)throw new Error('absent right result');
        function optional(item:Item|undefined):number|undefined {return item&&item.id;}
        if(optional(undefined)!==undefined||optional({kind:'second',id:4})!==4)throw new Error('undefined branch');
        function literal(value:'ready'|undefined):number|undefined {return value&&5;}
        if(literal(undefined)!==undefined||literal('ready')!==5)throw new Error('literal branch');
        function falsy(value:0|1|undefined):number|undefined {return value&&7;}
        if(falsy(0)!==0||falsy(1)!==7||falsy(undefined)!==undefined)throw new Error('falsy scalar retained');
    `,
    "ordinary-length-fields": `
        class Samples {
            private capacity:number;
            private data:Float64Array;
            length=0;
            constructor(size=2){this.capacity=size;this.data=new Float64Array(size);}
            clear():void {this.length=0;}
            push(value:number):void {
                if(this.length>=this.capacity){
                    const copy=new Float64Array(this.capacity*2);
                    copy.set(this.data);this.data=copy;this.capacity*=2;
                }
                this.data[this.length++]=value;
            }
            at(index:number):number {return this.data[index]!;}
            adjust(value:number):void {this.length+=value;}
        }
        const buffer=new Samples(1);
        buffer.push(3);buffer.push(4);
        if(buffer.length!==2||buffer.at(0)!==3||buffer.at(1)!==4)throw new Error('buffer growth');
        buffer.clear();buffer.push(5);buffer.adjust(2);buffer.length-=1;
        if(buffer.length!==2||buffer.at(0)!==5)throw new Error('class length writes');
        const record={length:3};record.length=8;record.length-=2;
        if(record.length!==6)throw new Error('record length writes');
        const rows:Array<{length:number}>=[{length:3}];let reads=0;
        const host={get child():{length:number}{reads++;return rows[0]!;}};
        host.child.length=7;
        if(reads!==1||rows[0]!.length!==7)throw new Error('length receiver getter');
        const array=[1,2,3,4];array.length-=1;array.length=1;
        if(array.join()!=='1')throw new Error('array truncation');
    `,
};

for (const [name, source] of Object.entries(programs)) {
    test(name, async (t) => {
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
                `logical-class-boundaries/${name}`,
                result.cpp,
            );
        });
    });
}

test("built-in readonly length remains unwritable", () => {
    assert.throws(() => compileSource(`const text='abc';text.length=1;`));
    assert.throws(() =>
        compileSource(`const view=new Float64Array(3);view.length=1;`),
    );
});
