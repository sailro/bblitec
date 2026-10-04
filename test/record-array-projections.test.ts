import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { discoverWindowsBuildTools } from "../src/development-tools.js";
import { runGeneratedProgram } from "./native-fixture.js";

test("record array and readonly projections preserve all elements with warning-clean native loops", (t) => {
    const source = `
        interface Point {x:number;y:number;}
        interface Labeled {x:number;y:number;label:string;}
        function sum(points:readonly Point[]):number {
            let value=0;
            for(const point of points)value+=point.x+point.y;
            return value;
        }
        const points:Labeled[]=[{x:1,y:2,label:'first'},{x:3,y:4,label:'second'}];
        points.push({x:5,y:6,label:'third'});
        const groups:Point[][]=[points];
        const reads:Array<(points:readonly Point[])=>number>=[sum];
        if(groups[0]!.length!==3||sum(groups[0]!)!==21||reads[0]!(points)!==21)
            throw new Error('record projection elements');
        const empty:Labeled[]=[];
        const emptyGroups:Point[][]=[empty];
        if(emptyGroups[0]!.length!==0||reads[0]!(empty)!==0)
            throw new Error('empty record projection');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    if (process.platform !== "win32")
        return t.skip("The clang-cl native fixture requires Windows.");
    let tools;
    try {
        tools = discoverWindowsBuildTools("clangcl");
    } catch {
        return t.skip("The clang-cl native fixture compiler is unavailable.");
    }
    runGeneratedProgram(tools, "record-array-projections", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});
