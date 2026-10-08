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

/** Exercise both wall-time disambiguations in the same zone as the native locale adapter. */
function transitionInputs(): string[] {
    const result: string[] = [];
    const start = Date.UTC(2024, 0, 1),
        end = Date.UTC(2025, 0, 1);
    let previous = new Date(start).getTimezoneOffset();
    for (let time = start + 3600000; time < end; time += 3600000) {
        const current = new Date(time).getTimezoneOffset();
        if (current !== previous) {
            const local =
                time -
                Math.max(previous, current) * 60000 +
                Math.abs(current - previous) * 30000;
            result.push(new Date(local).toISOString().slice(0, -1));
        }
        previous = current;
    }
    return result;
}

test("Date standardized strings share parsing, clipping and local-time disambiguation", (t) => {
    const inputs = [
        "1970",
        "1970-01",
        "1970-01-01",
        "1970-01-01T00:00",
        "1970-01-01T00:00Z",
        "1970-01-01T24:00:00Z",
        "1970-01-01T01:30:00.125+01:30",
        "1970-01-01T00:00:00.001-00:30",
        "0099-01-01T00:00:00.000Z",
        "+010000-01-01T00:00:00.000Z",
        "-000001-01-01T00:00:00.000Z",
        "+000000-01-01T00:00:00.000Z",
        "-000000-01-01T00:00:00.000Z",
        "2000-02-29T12:34:56.789Z",
        "2000-02-31T00:00:00Z",
        "2000-13-01T00:00:00Z",
        "2000-01-32T00:00:00Z",
        "1970-01-01T24:00:00.001Z",
        "1970-01-01T00:60:00Z",
        "1970-01-01T00:00:60Z",
        "1970-01-01T00:00:00+24:00",
        "+275760-09-13T00:00:00.000Z",
        "+275760-09-13T00:00:00.001Z",
        "-271821-04-20T00:00:00.000Z",
        "-271821-04-19T23:59:59.999Z",
        ...transitionInputs(),
    ];
    const assertions = inputs
        .map((input, index) => {
            const expected = Date.parse(input);
            return `const parsed${index}=read(${JSON.stringify(input)});const made${index}=construct(${JSON.stringify(input)});
            if(${Number.isNaN(expected) ? `!Number.isNaN(parsed${index})||!Number.isNaN(made${index}.getTime())` : `parsed${index}!==${expected}||made${index}.getTime()!==${expected}`})throw new Error('date ${index}');`;
        })
        .join("\n");
    const result = compileSource(`
        function read(value:string):number{return Date.parse(value);}
        function construct(value:string):Date{return new Date(value);}
        ${assertions}
        const original=new Date(951782400123);
        const copied=construct(original.toISOString());
        if(copied===original||copied.getTime()!==original.getTime())throw new Error('date identity');
        let reads=0;function input():string{reads++;return '1970-01-01T00:00:00Z';}
        if(Date.parse(input())!==0||new Date(input()).getTime()!==0||reads!==2)throw new Error('evaluation');
        let refused=false;
        try{read('January 1, 1970');}catch{refused=true;}
        if(!refused)throw new Error('legacy format boundary');
    `);
    assert.ok(result.manifest.features.includes("data:locale"));
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required");
        return;
    }
    const directory = resolve("artifacts/date-string-inputs");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/utf-8",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        source,
        "native/src/pal_locale.cpp",
        "icu.lib",
    ]);
    execFileSync(executable, { stdio: "pipe", windowsHide: true });
});

test("Date parsing refuses unrepresented argument coercion", () => {
    assert.throws(
        () =>
            compileSource(
                `Date.parse({toString(){return '1970-01-01';}} as unknown as string);`,
            ),
        /Date.parse requires/,
    );
});
