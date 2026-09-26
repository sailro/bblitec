import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    executeComputeUniformLayout,
    computeUniformLayout,
} from "../src/pinned-compute-uniform.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute uniform layouts execute pinned vector and matrix packing", async () => {
    const fields = [
        { name: "scalar", type: "f32" },
        { name: "vector", type: "vec3<f32>" },
        { name: "tail", type: "i32" },
        { name: "matrix", type: "mat3x3<f32>" },
        { name: "half", type: "vec3<f16>" },
    ];
    const expected = await executeComputeUniformLayout(fields);
    assert.deepEqual(computeUniformLayout(fields), expected);
    assert.ok("layout" in expected);
    assert.equal(expected.layout.byteLength, 96);
    assert.deepEqual(
        expected.layout.fields.map(([, field]) => field.offset),
        [0, 16, 28, 32, 80],
    );
    for (const fields of [
        [],
        [{ name: "", type: "f32" }],
        [{ name: "a", type: "bad" }],
        [
            { name: "a", type: "f32" },
            { name: "a", type: "u32" },
        ],
    ])
        assert.deepEqual(
            computeUniformLayout(fields),
            await executeComputeUniformLayout(fields),
        );
});

test("compiled compute layouts retain identity, readonly byte length and runtime validation", (t) => {
    const result = compileSource(`
import {createComputeUniformLayout} from "@babylonjs/lite";
function make(){return createComputeUniformLayout([{name:"direction",type:"vec3<f32>"},{name:"scale",type:"f32"}]);}
const first=make(),second=make(),alias=first;
if(first===second||alias!==first||first.byteLength!==16)throw new Error("uniform layout identity");
let caught=0;
try{createComputeUniformLayout([]);}catch(error){if(error.message==="#878")caught++;}
try{createComputeUniformLayout([{name:"a",type:"f32"},{name:"a",type:"u32"}]);}catch(error){if(error.message==="#880")caught++;}
if(caught!==2)throw new Error("uniform layout validation");
`);
    assert.ok(result.manifest.features.includes("compute:uniform-layout"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-uniform-layout-check");
    mkdirSync(directory, { recursive: true });
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
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
