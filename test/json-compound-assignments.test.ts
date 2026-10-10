import assert from "node:assert/strict";
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
        const tools = optionalNativeFixtureTools(false);
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        runGeneratedProgram(
            tools,
            `json-compound-assignments/${name}`,
            result.cpp,
        );
    });
}

check(
    "primitive-compound-operators",
    `
    const data = JSON.parse('{"n":5,"text":"x","numericText":"4","nil":null}') as {
        n:number; text:string; numericText:number; nil:number; missing:number;
    };
    data.n += 3;
    data.n -= 2;
    data.n *= 4;
    data.n /= 3;
    data.n %= 3;
    data.n **= 3;
    data.n <<= 2;
    data.n >>= 1;
    data.n >>>= 2;
    data.n |= 8;
    data.n &= 10;
    data.n ^= 3;
    if (data.n !== 11) throw new Error("numeric operators");
    data.text += 2;
    data.numericText += 3;
    data.nil += 4;
    data.missing -= 1;
    if (data.text !== "x2" || String(data.numericText) !== "43" || data.nil !== 4 || !Number.isNaN(data.missing))
        throw new Error("primitive conversions");
    data.n = -7;
    data.n %= 3;
    if (data.n !== -1) throw new Error("floating remainder");
    data.n = -1;
    data.n >>>= 0;
    if (data.n !== 4294967295) throw new Error("unsigned shift");
    const added = (data.n = 3, data.n += 4);
    function retain(value:number):number{return value;}
    if (added !== 7 || retain(data.n *= 2) !== 14) throw new Error("assignment values");
    data.n = -2;
    if (data.n += 2) throw new Error("zero truthiness");
    if (!(data.n += 1)) throw new Error("positive truthiness");
    if (data.n < 0 && (data.n += 20)) throw new Error("lazy right");
    if (data.n !== 1) throw new Error("short-circuit effects");
`,
);

check(
    "compound-owner-key-and-old-value-order",
    `
    interface Item {n:number; text:string;}
    const first=JSON.parse('{"n":1,"text":"a"}') as Item;
    let owner=first;
    let trace="";
    function receiver():Item {trace+="r";return owner;}
    function key():"n" {trace+="k";owner=JSON.parse('{"n":90,"text":"b"}') as Item;return "n";}
    function right():number {trace+="v";first.n=30;return 2;}
    const stored=(receiver()[key()]+=right());
    if(trace!=="rkv"||stored!==3||first.n!==3||owner.n!==90)throw new Error("numeric order");
    const second=owner;
    owner.n += (owner=first, 4);
    if(second.n!==94||first.n!==3||owner!==first)throw new Error("rebound owner");
    trace="";
    function suffix():string {trace+="s";first.text="changed";return "!";}
    const text=(first.text+=suffix());
    if(text!=="a!"||first.text!=="a!"||trace!=="s")throw new Error("string snapshot");
    let calls=0;
    function abrupt():number {calls++;throw new Error("right");}
    try { first.n += abrupt(); } catch {}
    if(calls!==1||first.n!==3)throw new Error("abrupt right");
`,
);

test("dynamic compound assignment refuses BigInt and object coercion", (t) => {
    assert.throws(
        () =>
            compileSource(`
        const value=JSON.parse('{}') as {n:bigint};
        value.n += 1n;
    `),
        /BigInt|bigint/,
    );
    const result = compileSource(`
        const value=JSON.parse('{"n":{}}') as {n:number};
        let refused=false;
        try { value.n += 1; } catch { refused=true; }
        if (!refused) throw new Error("unrepresented object conversion");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "json-compound-assignments/object-refusal",
        result.cpp,
    );
});

check(
    "nullish-compound-targets-read-before-right-side",
    `
    interface Item { n:number; }
    const document=JSON.parse('{"nil":null}') as {nil:Item; missing:Item};
    let trace="";
    let caught=0;
    function key():"n" {trace+="k";return "n";}
    function right():number {trace+="r";return 2;}
    ${["document.nil", "document.missing"]
        .map(
            (owner) => `
        try { ${owner}[key()] += right(); }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
        try { ${owner}.n ||= right(); }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
        try { ${owner}.n &&= right(); }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
        try { ${owner}.n ??= right(); }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
        try { ++${owner}[key()]; }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
        try { ${owner}[key()]--; }
        catch(error) { if (!(error instanceof TypeError)) throw error; caught++; }
    `,
        )
        .join("")}
    if(caught!==12 || trace!=="kkkkkk")
        throw new Error("nullish target read must follow key and precede right side");
`,
);

test("scalar compound value targets fail without recursive fallback", () => {
    assert.throws(
        () => compileSource("let value=1; console.log(value+=2);"),
        /compound assignment target has no represented expression value/,
    );
});

check(
    "logical-json-assignment-values-are-selected-lazily",
    `
    const value=JSON.parse('{"n":1}') as {n:number};
    console.log(value.n ||= 2);
    let calls=0;
    function right():number {calls++;return 2;}
    function consume(result:number):number {value.n=9;return result;}
    const present=consume(value.n ||= right());
    if(present!==1||value.n!==9||calls!==0)throw new Error("present logical result");
    value.n=0;
    const assigned=consume(value.n ||= right());
    if(assigned!==2||value.n!==9||calls!==1)throw new Error("assigned logical result");
`,
);
