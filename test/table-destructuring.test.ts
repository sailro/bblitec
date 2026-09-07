import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const positions = [[-3.6, 1.5, 0], [0, 1.5, 0], [3.6, 1.5, 0], [-1.8, -1.7, 0], [1.8, -1.7, 0]];
const expected = positions.flatMap(([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x!, y!, z!, 1]);
const matrixSource = `
    import { createEngine } from "@babylonjs/lite";
    const positions = ${JSON.stringify(positions)} as const;
    function createMatrices(): Float32Array {
        const matrices = new Float32Array(positions.length * 16);
        for (let i = 0; i < positions.length; i++) {
            const [x, y, z] = positions[i]!;
            const offset = i * 16;
            matrices[offset] = 1;
            matrices[offset + 5] = 1;
            matrices[offset + 10] = 1;
            matrices[offset + 12] = x;
            matrices[offset + 13] = y;
            matrices[offset + 14] = z;
            matrices[offset + 15] = 1;
        }
        return matrices;
    }
    async function main() {
        const engine = await createEngine({});
        const matrices = createMatrices();
        const expected = new Float32Array(${JSON.stringify(expected)});
        if (matrices.length !== expected.length) throw new Error("Matrix count changed");
        for (let i = 0; i < expected.length; i++) {
            if (matrices[i] !== expected[i]) throw new Error("An ordered matrix lane changed");
        }
        const rows = [[[10, 11, 12], [20, 21, 22]], [[30, 31, 32], [40, 41, 42]]] as const;
        let plane = 1;
        let row = 0;
        const [first, , third] = rows[plane++ % 2]![row++]!;
        if (plane !== 2 || row !== 1 || first !== 30 || third !== 32) {
            throw new Error("Destructuring changed row selection, evaluation count or omitted lanes");
        }
    }
`;

test("native numeric loops destructure table rows without static expansion", () => {
    const result = compileSource(matrixSource);
    assert.match(result.cpp, /for \(; .* < 5\.0;/);
    assert.equal(result.cpp.match(/const bbl::js::Tuple<3> .* = /g)?.length, 2);
    assert.doesNotMatch(result.cpp, /v_bblite_repeat_index_/);
});

test("table row destructuring rejects bindings beyond its fixed width", () => {
    assert.throws(() => compileSource(matrixSource.replace("const [x, y, z]", "const [x, y, z, extra]")),
        /Tuple has 3 elements, destructuring expects 4/);
});

test("unchanged scene279 compiles indexed constant tuple destructuring", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene279.ts";
    const result = compileSource(readFileSync(fileName, "utf8"), { fileName });
    assert.match(result.cpp, /for \(; .* < 5\.0;/);
    assert.match(result.cpp, /const bbl::js::Tuple<3> .* = .*INSTANCE_POSITIONS/);
});

const nativeTools = optionalNativeFixtureTools(false);
test("native table destructuring preserves every matrix lane and evaluates indices once", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/table-destructuring-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, `${compileSource(matrixSource).cpp}
        namespace bbl { Engine create_engine(EngineOptions options) { Engine engine; engine.options = options; return engine; } }
    `);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, source, "/link", "/OPT:REF"]);
    execFileSync(executable, { stdio: "pipe" });
});
