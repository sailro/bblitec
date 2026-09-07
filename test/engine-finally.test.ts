import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine, startEngine } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        let cleanups = 0;
        try {
            await startEngine(engine);
            if (cleanups !== 0) throw new Error("finally ran before the continuation");
        } finally {
            cleanups++;
        }
        if (cleanups !== 1) throw new Error("finally did not complete before the following statement");
    }
`;

test("startEngine finally cleanup belongs to the continuation completion", () => {
    const cpp = compileSource(source).cpp;
    assert.match(cpp, /defer_start_continuation/);
    assert.match(cpp, /finally_completion_\d+\.run\(\)/);
});

test("finally blocks explicitly refuse an additional suspended frame boundary", () => {
    assert.throws(() => compileSource(source.replace(
        "if (cleanups !== 0)",
        "await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (cleanups !== 0)",
    )), /finally block spanning startEngine cannot also span a later frame yield/);
});

const nativeTools = optionalNativeFixtureTools(false);
test("native continuation runs finally at completion and scope guards run only once", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/engine-finally-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "finally.hpp"), compileSource(source).cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", "/I", output,
        "test/fixtures/engine-finally-check.cpp"]);
    execFileSync(executable, { encoding: "utf8" });
});
