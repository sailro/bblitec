import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

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
    const gathered:string[]=[];
    function append(rows:[number,string][]):{start:number;end:number} {
        const start=gathered.length;
        for(const [amount,label] of rows) gathered.push(amount+label);
        return {start,end:gathered.length};
    }
    async function main(){
        const items:number[]=[2,3]; const held=identity(items); items.push(4);
        if(useCopy(items)!==18 || held.length!==3 || held[2]!==4) throw new Error("input ownership");
        if(sumRow(0)!==10 || sumRow(1)!==26) throw new Error("table row lifetime");
        const values=local(); if(values[0]!==11 || values[1]!==13) throw new Error("returned local lifetime");
        const first=append([[1,"a"],[2,"b"]]);
        const second=append([[7,"z"]]);
        const repeated=append([[1,"a"],[2,"b"]]);
        if(first.start!==0 || first.end!==2 || second.start!==2 || second.end!==3 || repeated.start!==3 || repeated.end!==5 || gathered.join(",")!=="1a,2b,7z,1a,2b") throw new Error("constant arguments reused across calls");
        const original = {value:7};
        const records: {value:number}[] = [original];
        const saved = records[0];
        records.pop();
        if (!saved || saved !== original || saved.value !== 7) throw new Error("saved reference presence changed with its array");
        const holes = new Array<{value:number}>(2);
        if (holes[0]) throw new Error("uninitialized reference slot is truthy");
        class Owner {
            private values: number[] = [17, 19];
            reads = 0;
            read(present: boolean): number[] {
                this.reads++;
                if (present) return this.values;
                return [];
            }
        }
        const owner = new Owner();
        let selected = owner.read(true);
        const typed: number[] = owner.read(true);
        const retained = selected;
        selected = [];
        if (retained[0] !== 17 || typed !== retained || owner.reads !== 2)
            throw new Error("transferred call result alias");
        const record = {items: owner.read(true)};
        const firstRead = record.items;
        const secondRead = record.items;
        firstRead.push(23);
        if (secondRead !== firstRead || record.items.length !== 3 || owner.reads !== 3)
            throw new Error("reused compiler-backed property was moved");
        const callbacks: (() => number)[] = [];
        function capture(): void {
            const captured = owner.read(true);
            const alias = captured;
            callbacks.push(() => alias[2]!);
        }
        capture();
        if (callbacks[0]!() !== 23 || owner.reads !== 4)
            throw new Error("transferred result escaped through a callback");
        const originalArray: number[] = [31];
        const unusedAlias = originalArray;
        const borrowedAlias = originalArray;
        function rebindParameter(value: number[]): number[] {
            value = [37];
            return value;
        }
        const replacement = rebindParameter(originalArray);
        if (originalArray[0] !== 31 || borrowedAlias[0] !== 31 || replacement[0] !== 37)
            throw new Error("parameter rebinding changed an immutable owner");
        interface State { value: number; }
        function replaceState(state: State): State {
            state.value = 47;
            state = {value: 53};
            return state;
        }
        const originalState: State = {value: 41};
        const stateAlias = originalState;
        const replacedState = replaceState(originalState);
        if (originalState.value !== 47 || stateAlias.value !== 47 ||
            replacedState.value !== 53 || replacedState === originalState)
            throw new Error("object parameter mutation and rebinding");
    }
`;

test("native array signatures distinguish fresh results, stable table rows and returned aliases", () => {
    const result = compileSource(source);
    assert.match(result.cpp, /bbl::js::Span<const bbl::js::Tuple<2>> row\(/);
    assert.match(result.cpp, /copy\(bbl::js::Span<const double>/);
    assert.match(result.cpp, /identity\(const bbl::js::Array<double>&/);
    assert.match(result.cpp, /bbl::js::take_temporary\(bbl_method_\w+result\)/);
    assert.match(
        result.cpp,
        /\[\[maybe_unused\]\] bbl::js::Array<double>& v_unusedAlias = v_originalArray;/,
    );
    assert.match(result.cpp, /auto v_fn\d+_state = fn\d+_recursive_arg_0;/);
});

const tools = optionalNativeFixtureTools(false);
test(
    "returned array storage remains valid and preserves source aliases in native execution",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/array-return-storage");
        mkdirSync(output, { recursive: true });
        const file = join(output, "program.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(file, compileSource(source).cpp);
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/O2",
            `/Fo:${output}/`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            file,
        ]);
        assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
    },
);
