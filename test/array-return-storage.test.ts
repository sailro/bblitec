import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    type Cell = readonly [number,number];
    const TABLE: readonly (readonly Cell[])[] = [[[1,2],[3,4]],[[5,6],[7,8]]];
    function row(index:number): readonly Cell[] {return TABLE[index]!;}
    function sumRow(index:number):number {let sum=0; for(const [x,y] of row(index)) sum+=x+y; return sum;}
    function copy(items:readonly number[]):number[] {
        const result:number[]=[]; for(const item of items) result.push(item*2); return result;
    }
    function useCopy(items:readonly number[]):number {const values=copy(items); let sum=0; for(const value of values) sum+=value; return sum;}
    function identity(items:readonly number[]):readonly number[] {return items;}
    function local():readonly number[] {const values:number[]=[11,13]; return values;}
    async function main(){
        const items:number[]=[2,3]; const held=identity(items); items.push(4);
        if(useCopy(items)!==18 || held.length!==3 || held[2]!==4) throw new Error("input ownership");
        if(sumRow(0)!==10 || sumRow(1)!==26) throw new Error("table row lifetime");
        const values=local(); if(values[0]!==11 || values[1]!==13) throw new Error("returned local lifetime");
    }
`;

test("native array signatures distinguish fresh results, stable table rows and returned aliases", () => {
    const result=compileSource(source);
    assert.match(result.cpp, /bbl::js::Span<const bbl::js::Tuple<2>> row\(/);
    assert.match(result.cpp, /copy\(bbl::js::Span<const double>/);
    assert.match(result.cpp, /identity\(const bbl::js::Array<double>&/);
});

const tools=optionalNativeFixtureTools(false);
test("returned array storage remains valid and preserves source aliases in native execution", {skip:!tools}, () => {
    const output=resolve("artifacts/array-return-storage"); mkdirSync(output,{recursive:true});
    const file=join(output,"program.cpp"), executable=join(output,"check.exe");
    writeFileSync(file,compileSource(source).cpp);
    runNativeFixtureCompiler(tools!,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",
        `/Fo:${output}/`,`/Fe:${executable}`,"/I","native/include",file]);
    assert.equal(execFileSync(executable,{encoding:"utf8"}),"");
});
