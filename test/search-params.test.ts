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

test("runtime query reads and mutations match URLSearchParams ordering, identity and encoding", (t) => {
    const inputs = [
        "",
        "?",
        "??a=1",
        "?a=one&a=two",
        "a=&a=two",
        "&a&&b=&=empty&",
        "a=x=y",
        "a=hello+world",
        "%61=%2b%26%3d",
        "a=%",
        "a=%2",
        "a=%GG",
        "a=%F0%9F%8C%B2",
        "a=%EF%BB%BFtext",
        "a=%E2%82",
        "a=%E2%28%A1",
        "a=%ED%A0%80",
        "a=%F4%90%80%80",
        "a=%C0%AF",
        "a=%00",
        "a=\ud800",
        "\ud800=ok",
    ];
    const cases = inputs.flatMap((input) =>
        ["a", "missing", "", "\ud800"].map((key) => {
            const query = new URLSearchParams(input);
            const value = query.get(key);
            const expected =
                value === null
                    ? "<missing>"
                    : Array.from({ length: value.length }, (_, index) =>
                          value.charCodeAt(index),
                      ).join(",");
            return {
                input,
                key,
                expected,
                present: query.has(key),
                second: query.has(key, "two"),
            };
        }),
    );
    const mutations = inputs.flatMap((input) =>
        ["a", "", "\ud800", "space +~!'()*🌲"].map((key) => {
            const query = new URLSearchParams(input);
            const value = "new +~=&#?🌲\ud800";
            query.set(key, value);
            return { input, key, value, expected: query.toString() };
        }),
    );
    const result = compileSource(
        `
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
        const mutations:Array<{input:string;key:string;value:string;expected:string}> = ${JSON.stringify(mutations)};
        for(const row of mutations) {
            const original = new URLSearchParams(row.input);
            const alias = original;
            alias.set(row.key,row.value);
            if(original.toString() !== row.expected || alias !== original)
                throw new Error("query mutation or serialization: " + row.input);
        }
        const deployment = new URLSearchParams(location.search);
        const alias = deployment;
        function write(target:URLSearchParams):void {target.set("first","changed");}
        write(alias);
        if(deployment.get("first") !== "changed" || deployment.toString() !== "first=changed&second=2")
            throw new Error("deployment query mutation retained through helper");
        let name="before";
        function changeName():string {name="after";return "value";}
        deployment.set(name,changeName());
        if(deployment.get("before")!=="value" || deployment.has("after"))
            throw new Error("query argument evaluation order");
        function create():URLSearchParams {return new URLSearchParams("same=1");}
        const left=create(),right=create();
        left.set("same","2");
        if(left===right || right.get("same")!=="1") throw new Error("fresh query identity");
        function queryBoolean(query:URLSearchParams,key:string,fallback:boolean):boolean {
            const value=query.get(key);
            return value===null?fallback:value==="true"||value==="1";
        }
        for(const text of ["true","1","false","0",""]) {
            deployment.set("enabled",text);
            if(queryBoolean(deployment,"enabled",true)!==(text==="true"||text==="1"))
                throw new Error("conditional query boolean");
        }
        if(!queryBoolean(deployment,"missing",true)||queryBoolean(deployment,"missing",false))
            throw new Error("conditional query fallback");
        if(\`value=\${deployment.get("missing")}\`!=="value=null")
            throw new Error("nullable query interpolation");
        deployment.set("present","hello");
        if(\`value=\${deployment.get("present")}\`!=="value=hello")
            throw new Error("present query interpolation");
    `,
        { search: "?first=1&second=2&first=3" },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/runtime-search-params");
    mkdirSync(directory, { recursive: true });
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/utf-8",
        "/I",
        "native/include",
        `/Fo:${directory}/`,
        `/Fe:${exe}`,
        cpp,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("runtime query operations outside represented reads refuse", () => {
    assert.throws(
        () =>
            compileSource(`
        const inputs:string[]=["?a=1"];
        const query = new URLSearchParams(inputs[0]!);
        query.append("a","2");
    `),
        /Runtime URLSearchParams.append is not lowered/,
    );
});

test("fixed queries compare optional has values", () => {
    const result = compileSource(
        `
        const query = new URLSearchParams(location.search);
        if(query.has("a","wrong") || !query.has("a","two")) throw new Error("query value filter");
    `,
        { search: "?a=one&a=two" },
    );
    assert.doesNotMatch(result.cpp, /query value filter/);
});

test("deployment queries retain their values through parameterized helpers", () => {
    const result = compileSource(
        `
        function queryNumber(query: URLSearchParams, key: string, fallback: number): number {
            const value = Number(query.get(key) ?? fallback);
            return Number.isFinite(value) ? value : fallback;
        }
        const query = new URLSearchParams(location.search);
        const resolution = queryNumber(query, "resolution", 256);
        if (resolution !== 128) throw new Error("parameterized query value");
        if (queryNumber(query, "missing", 30) !== 30) throw new Error("query fallback");
        if (queryNumber(query, "invalid", 5) !== 5) throw new Error("finite fallback");
    `,
        { search: "?resolution=128&invalid=Infinity" },
    );
    assert.doesNotMatch(
        result.cpp,
        /parameterized query value|query fallback|finite fallback/,
    );
});

test("reassigned query primitives use native storage", () => {
    const result = compileSource(
        `
        const query = new URLSearchParams(location.search);
        let enabled = query.has("enabled");
        function toggle(): void { enabled = !enabled; }
        toggle();
        if (enabled) throw new Error("query toggle failed");
    `,
        { search: "?enabled" },
    );
    assert.match(result.cpp, /bool .*enabled/);
    assert.match(result.cpp, /query toggle failed/);
});
