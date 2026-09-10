import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("indexed color tables and vector getters evaluate once at native sinks", { skip: !native }, () => {
    const output = resolve("artifacts/vector-tuple-check");
    mkdirSync(output, { recursive: true });
    const result = compileSource(`
        import { createEngine, createStandardMaterial, createHemisphericLight } from "@babylonjs/lite";
        const colors: [number, number, number][] = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
        async function main() {
            const engine = await createEngine({});
            let reads = 0;
            let getters = 0;
            function next(): number { return reads++; }
            function direction(): [number, number, number] { getters++; return [4, 5, 6]; }
            const options = { get direction(): [number, number, number] { return direction(); } };
            for (let index = 0; index < 4; index++) {
                const material = createStandardMaterial();
                material.diffuseColor = colors[next()]!;
                createHemisphericLight(options.direction);
            }
            if (reads !== 4 || getters !== 4) throw new Error("repeated vector evaluation");
        }
    `);
    writeFileSync(join(output, "scene.hpp"), result.cpp);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include",
        "test\\fixtures\\vector-tuple-check.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /vector-tuple-check: ok/);
});
