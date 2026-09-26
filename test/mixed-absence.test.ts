import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("mixed primitive absence retains null and undefined through fields, loops and scalar sinks", (t) => {
    const result = compileSource(`
        interface Match {key?: string | null; weight?: number | null; enabled?: boolean | null;}
        const matches: Match[] = [{}, {}];
        if (matches[0]!.key !== undefined || matches[0]!.key === null) throw new Error("missing tag");
        const prepare: (index:number)=>string|null = index => index === 0 ? "ready" : null;
        let index = 0;
        for (const match of matches) {match.key = prepare(index++);}
        function consume(value:string): number {return value.length;}
        let length = 0;
        for (const match of matches) {
            if (match.key !== null) length += consume(match.key!);
        }
        if (length !== 5 || matches[1]!.key !== null || matches[1]!.key === undefined) throw new Error("prepared tag");
        matches[0]!.key = undefined;
        if (matches[0]!.key === null || matches[0]!.key !== undefined) throw new Error("explicit undefined");
        if (String(matches[0]!.key) !== "undefined" || String(matches[1]!.key) !== "null") throw new Error("absence text");
        matches[0]!.weight = 3;
        matches[0]!.enabled = false;
        function numberSink(value:number):number {return value * 2;}
        function booleanSink(value:boolean):boolean {return !value;}
        if (numberSink(matches[0]!.weight!) !== 6 || !booleanSink(matches[0]!.enabled!)) throw new Error("scalar sinks");
        matches[0]!.weight = null;
        matches[0]!.enabled = undefined;
        if (matches[0]!.weight !== null || matches[0]!.enabled !== undefined) throw new Error("primitive tags");
    `);
    assert(result.manifest.features.includes("data:json"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/mixed-absence-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        directory,
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        "test/fixtures/mixed-absence-check.cpp",
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
