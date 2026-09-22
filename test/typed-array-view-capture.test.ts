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

test("escaped tuple views retain their constructed typed array and shared backing buffer", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const result = compileSource(`
        function createReader(): () => number {
            const points = new Float32Array(12);
            const views = [
                new Float32Array(points.buffer, 0, 4),
                new Float32Array(points.buffer, 16, 4),
                new Float32Array(points.buffer, 32, 4),
            ] as const;
            const callback = () => views[0][0]! + views[1][0]! + views[2][0]!;
            points.set([1,2,3,4,5,6,7,8,17,10,11,12]);
            return callback;
        }
        const callbacks: (() => number)[] = [];
        callbacks.push(createReader());
        if (callbacks[0]!() !== 23) throw new Error("escaped tuple view lost state");
    `);
    const directory = resolve("artifacts/typed-array-view-capture-check");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(
        execFileSync(exe, {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
        }),
        "",
    );
});
