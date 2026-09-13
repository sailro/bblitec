import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {optionalNativeFixtureTools, runNativeFixtureCompiler} from "./native-fixture.js";

test("runtime query reads match URLSearchParams decoding, absence and duplicate semantics", t => {
    const inputs = ["", "?", "??a=1", "?a=one&a=two", "a=&a=two", "&a&&b=&=empty&",
        "a=x=y", "a=hello+world", "%61=%2b%26%3d", "a=%", "a=%2", "a=%GG",
        "a=%F0%9F%8C%B2", "a=%EF%BB%BFtext", "a=%E2%82", "a=%E2%28%A1",
        "a=%ED%A0%80", "a=%F4%90%80%80", "a=%C0%AF", "a=%00", "a=\ud800", "\ud800=ok"];
    const cases = inputs.flatMap(input => ["a", "missing", "", "\ud800"].map(key => {
        const query = new URLSearchParams(input);
        const value = query.get(key);
        const expected = value === null ? "<missing>" : Array.from({length:value.length}, (_, index) => value.charCodeAt(index)).join(",");
        return {input, key, expected, present:query.has(key), second:query.has(key, "two")};
    }));
    const result = compileSource(`
        function verify(input:string,key:string,expected:string,present:boolean,second:boolean):void {
            const query = new URLSearchParams(input);
            const alias:URLSearchParams = query;
            if(alias !== query) throw new Error("query identity");
            const value = alias.get(key);
            let units = value === null ? "<missing>" : "";
            if(value!==null)for(let index=0;index<value.length;index++) {
                if(index>0)units+=",";
                units+=value.charCodeAt(index);
            }
            if(units !== expected || query.has(key) !== present || query.has(key,"two") !== second)
                throw new Error("query decoding or lookup: " + input + " / " + key);
        }
        const rows:Array<{input:string;key:string;expected:string;present:boolean;second:boolean}> = ${JSON.stringify(cases)};
        for(const row of rows) verify(row.input,row.key,row.expected,row.present,row.second);
        let effects=0;
        function text():string {effects++;return "?a=ok";}
        function key():string {effects++;return "a";}
        const query = new URLSearchParams(text());
        if(query.get(key()) !== "ok" || effects!==2) throw new Error("query evaluation effects");
        if(new URLSearchParams(text()).get(key()) !== "ok" || effects!==4) throw new Error("inline query effects");
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/runtime-search-params");
    mkdirSync(directory, {recursive:true});
    const cpp = join(directory,"check.cpp"), exe = join(directory,"check.exe");
    writeFileSync(cpp,result.cpp);
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD","/utf-8",
        "/I","native/include",`/Fo:${directory}/`,`/Fe:${exe}`,cpp]);
    assert.equal(execFileSync(exe,{encoding:"utf8",timeout:10000}), "");
});

test("runtime query operations outside represented reads refuse", () => {
    assert.throws(() => compileSource(`
        const inputs:string[]=["?a=1"];
        const query = new URLSearchParams(inputs[0]!);
        query.append("a","2");
    `), /Runtime URLSearchParams.append is not lowered/);
});

test("fixed queries compare optional has values", () => {
    const result = compileSource(`
        const query = new URLSearchParams(location.search);
        if(query.has("a","wrong") || !query.has("a","two")) throw new Error("query value filter");
    `, {search:"?a=one&a=two"});
    assert.doesNotMatch(result.cpp, /query value filter/);
});
