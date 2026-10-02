import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const factory = `
    interface Store {
        read(slot:0|1):{x:number;y:number};
        write(slot:0|1,x:number):void;
        inspect(slot:0|1):number;
    }
    function create():Store {
        const rows:[{x:number;y:number},{x:number;y:number}]=[{x:1,y:2},{x:3,y:4}];
        function read(slot:0|1):{x:number;y:number}{const out=rows[slot];return out;}
        function write(slot:0|1,x:number):void{rows[slot].x=x;}
        function inspect(slot:0|1):number{return rows[slot].x;}
        return {read,write,inspect};
    }
    const store=create();
`;

for (const [name, source] of [
    [
        "scalar-reads",
        factory +
            `
        const first=store.read(0).x;store.write(0,7);const second=store.read(0).x;
        if(first!==1||second!==7)throw new Error('scalar reads');
    `,
    ],
    [
        "method-aliases",
        factory +
            `
        const first=store.read(0);first.x=11;
        if(store.inspect(0)!==11)throw new Error('result mutation');
        store.write(0,23);
        if(first.x!==23)throw new Error('backing mutation');
        const second=store.read(1);second.x=31;
        if(first.x!==23||store.inspect(1)!==31)throw new Error('independent slots');
    `,
    ],
    [
        "callback-aliases",
        factory +
            `
        const callbacks:((slot:0|1)=>{x:number;y:number})[]=[store.read];
        const first=callbacks[0]!(0);first.x=11;
        if(store.inspect(0)!==11)throw new Error('stored result mutation');
        store.write(0,23);
        if(first.x!==23)throw new Error('stored backing mutation');
        if(callbacks[0]!(0).x!==23)throw new Error('repeated stored read');
    `,
    ],
    [
        "callback-identity",
        factory +
            `
        const callbacks:((slot:0|1)=>{x:number;y:number})[]=[store.read];
        const first=callbacks[0]!(0),again=callbacks[0]!(0),other=callbacks[0]!(1);
        if(first!==again||first===other)throw new Error('stored return identity');
        again.x=19;
        if(first.x!==19||store.inspect(0)!==19)throw new Error('identity aliases');
    `,
    ],
    [
        "optional-fields",
        `
        interface Store { read(slot:0|1):{x:number;extra?:number}; }
        function create():Store {
            const rows:[{x:number;extra?:number},{x:number;extra?:number}]=[{x:1,extra:2},{x:3}];
            return {read(slot:0|1):{x:number;extra?:number}{return rows[slot];}};
        }
        const store=create();
        const callbacks:((slot:0|1)=>{x:number;extra?:number})[]=[store.read];
        const first=callbacks[0]!(0);
        delete first.extra;
        if(Object.hasOwn(callbacks[0]!(0),'extra'))throw new Error('optional alias deletion');
        callbacks[0]!(0).extra=9;
        if(first.extra!==9||!Object.hasOwn(first,'extra'))throw new Error('optional alias assignment');
        if(Object.hasOwn(callbacks[0]!(1),'extra'))throw new Error('separate optional presence');
    `,
    ],
] as const) {
    test(`record layouts retain ${name}`, (t) => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.None,
                },
            }).outputText,
        );
        const result = compileSource(source, { fileName: `${name}.ts` });
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `record-layout-aliases/${name}`,
            result.cpp,
            {
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
}
