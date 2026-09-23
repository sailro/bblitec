import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedQuaternionHeader } from "../src/lowering/pinned-euler-proxy.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("public quaternion tuples preserve argument order, array identity and Euler round trips", (t) => {
    const result =
        compileSource(`import {eulerXYZToQuatTuple,quatToEulerXYZTuple} from "@babylonjs/lite";
    let count=0;
    function next() {count++; return count/10;}
    const q=eulerXYZToQuatTuple(next(),next(),next());
    const e=quatToEulerXYZTuple(q[0],q[1],q[2],q[3]);
    if(count!==3 || Math.abs(e[0]-.1)>1e-12 || Math.abs(e[1]-.2)>1e-12 || Math.abs(e[2]-.3)>1e-12) throw new Error("quaternion arguments");
    const again=eulerXYZToQuatTuple(.1,.2,.3);
    if(q===again) throw new Error("fresh quaternion identity");
    q[0]=123;
    if(again[0]===123) throw new Error("quaternion array aliases");`);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/quaternion-tuples-check"),
        headers = resolve(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    writeFileSync(
        resolve(headers, "pinned_quaternion.hpp"),
        pinnedQuaternionHeader(new LoweringContext()),
    );
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
