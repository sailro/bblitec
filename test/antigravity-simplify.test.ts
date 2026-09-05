import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lowerWgslShaderProgram } from "../src/shader-ir.js";
import {
    composeStandaloneWgsl,
    getShaderMaterialProgram,
    predeclaredShaderProgram,
    shaderSamplerDeclarations,
} from "../src/shader-material-programs.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("storage create and update share typed-array acceptance and refusal", () => {
    const source = (createData: string, updateData: string) => `
        import { createEngine, createStorageBuffer, updateStorageBuffer } from "babylon-lite";
        const engine = await createEngine({});
        const buffer = createStorageBuffer(engine, ${createData});
        updateStorageBuffer(engine, buffer, ${updateData});
    `;
    for (const type of ["Uint8Array", "Float64Array"]) {
        const result = compileSource(source(`new ${type}(4)`, `new ${type}(4)`));
        assert.match(result.cpp, /bbl::create_storage_buffer\(/);
        assert.match(result.cpp, /bbl::update_storage_buffer\(/);
    }
    assert.throws(
        () => compileSource(source("[1, 2]", "new Float32Array(4)")),
        /createStorageBuffer requires a typed-array view/,
    );
    assert.throws(
        () => compileSource(source("new Float32Array(4)", "[1, 2]")),
        /updateStorageBuffer requires a typed-array view/,
    );
});

test("bare shader samplers normalize identically for programs, prelude and IR", () => {
    const bare = { ...getShaderMaterialProgram("alpha-card"), samplers: ["surface"] };
    const explicit = {
        ...bare,
        samplerDeclarations: shaderSamplerDeclarations(bare),
    };
    assert.deepEqual(explicit.samplerDeclarations, [{
        name: "surface", sampleType: "float", viewDimension: "2d", comparison: false,
    }]);
    assert.deepEqual(predeclaredShaderProgram(bare), predeclaredShaderProgram(explicit));
    assert.deepEqual(lowerWgslShaderProgram(bare), lowerWgslShaderProgram(explicit));
    for (const stage of ["vertex", "fragment"] as const) {
        assert.equal(
            composeStandaloneWgsl(bare, "", stage),
            composeStandaloneWgsl(explicit, "", stage),
        );
    }
});

const nativeTools = optionalNativeFixtureTools();
test("CSM disposal releases captures and tolerates dispatch and owner destruction", {
    skip: !nativeTools,
}, () => {
    const output = resolve("artifacts/csm-subscription-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "csm-subscription-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "test/fixtures/js-callback/csm-subscription-check.cpp",
    ]);
    assert.match(execFileSync(executable, [], { encoding: "utf8" }), /csm-subscription-check: ok/);
});
