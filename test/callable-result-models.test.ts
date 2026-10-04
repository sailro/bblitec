import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const cases = {
    "object-identity-mappers": `
        interface Row {name:string;value:number;}
        const rows:Row[]=[{name:'first',value:1},{name:'last',value:2}];
        const frozen=Object.freeze(rows.map(Object.freeze));
        const sealed=rows.map(Object.seal);
        const closed=rows.map(Object.preventExtensions);
        if(frozen===rows||frozen[0]!==rows[0]||sealed[1]!==rows[1]||closed[0]!==rows[0])throw new Error('mapper identities');
        if(JSON.stringify(frozen)!=='[{"name":"first","value":1},{"name":"last","value":2}]')throw new Error('mapper fields');
    `,
    "guarded-array-result": `
        interface Row {readonly seconds:number;readonly phase?:number;}
        let visits=0;
        function normalize(input:readonly(Row|null)[]):readonly(Row|null)[]{
            if(!Array.isArray(input)||input.length>4)throw new Error('input');
            return Object.freeze(Array.from({length:4},(_,index)=>{
                visits++;
                const row=input[index];if(row==null)return null;
                return Object.freeze({seconds:row.seconds,...(row.phase===undefined?{}:{phase:row.phase})});
            }));
        }
        const input:(Row|null)[]=[];
        input.push({seconds:2},null,{seconds:3,phase:0});
        const values=normalize(input);
        if(visits!==4)throw new Error('mapper count');
        if(values[0]?.seconds!==2||values[1]!==null||values[2]?.phase!==0||values[3]!==null)throw new Error('rows');
        if('phase' in values[0]!||!('phase' in values[2]!))throw new Error('presence');
    `,
    "generic-intersection-result": `
        interface Row {tag?:number;label:string;cell:{value:number};}
        function adopt<T extends {tag?:number}>(values:readonly T[]):(T&{tag:number})[]{
            return values.map((value,index)=>({...value,tag:value.tag??index}));
        }
        const row:Row={label:'kept',cell:{value:3}};
        const result=adopt<Row>([row])[0]!;
        if(result===row||result.cell!==row.cell||result.label!=='kept'||result.tag!==0)throw new Error('intersection identity');
        if('tag' in row||!('tag' in result)||!('label' in result)||!('cell' in result))throw new Error('intersection presence');
        result.cell.value=7;if(row.cell.value!==7)throw new Error('intersection alias');
    `,
};
for (const [name, source] of Object.entries(cases))
    test(name, () => {
        runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
        );
        const result = compileSource(source);
        const tools = optionalNativeFixtureTools(false);
        assert.ok(tools);
        runGeneratedProgram(
            tools,
            `callable-result-models/${name}`,
            result.cpp,
            { expectedOutput: "", timeoutMs: 10000 },
        );
    });
