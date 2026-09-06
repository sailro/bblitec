import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { csgGeometryDeclarations } from "../src/pinned-csg.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("CSG table transport preserves float bits, integer lanes and empty streams", () => {
    const tables: Array<{ name: string; type: string; elements: string[] }> = [];
    const geometry = csgGeometryDeclarations("geometry", {
        positions: Float32Array.of(-0, 0, 1 / 3),
        normals: Float32Array.of(0, 1, 0),
        indices: Uint32Array.of(0, 1, 2),
        uvs: new Float32Array(),
    }, (name, type, elements) => {
        tables.push({ name, type, elements });
        return `bblscene::${name}`;
    });
    assert.deepEqual(geometry.lines, []);
    assert.deepEqual(tables[0]?.elements, ["-0.0f", "0.0f", "0.33333334f"]);
    assert.deepEqual(tables[2]?.elements, ["0u", "1u", "2u"]);
    assert.equal(tables[2]?.type, "std::uint32_t");
    assert.equal(geometry.positions,
        "std::vector<float>(bblscene::geometry_positions.begin(), bblscene::geometry_positions.end())");
    assert.equal(geometry.uvs, "std::vector<float>{}");
});

test("repeated CSG geometry shares immutable tables without sharing constructed meshes", () => {
    const result = compileSource(`
        import { createEngine, createBox, createCsgFromMesh, createMeshFromCsg } from "@babylonjs/lite";
        const engine = await createEngine({});
        const box = createBox(engine, 2);
        const solid = createCsgFromMesh(box);
        const first = createMeshFromCsg(engine, solid, "first");
        const second = createMeshFromCsg(engine, solid, "second");
    `);
    assert.equal(result.cpp.match(/inline const std::array</g)?.length, 4);
    assert.equal(result.cpp.match(/bbl::create_mesh_from_data\(/g)?.length, 2);
    assert.ok(result.cpp.indexOf("namespace bblscene") < result.cpp.indexOf("int main()"));
    assert.equal(result.manifest.sceneMeshes.length, 3);
});

test("unchanged Scene 90 keeps baked data outside static loop code expansion", () => {
    const path = "corpus/babylon-lite/lab/lite/src/lite/scene90.ts";
    const result = compileSource(readFileSync(path, "utf8"), { fileName: path });
    const main = result.cpp.slice(result.cpp.indexOf("int main()"));
    assert.ok(result.cpp.length > 1024 * 1024, "the pinned baked geometry must not disappear");
    assert.ok(main.length < 100000, "immutable geometry data must not be expanded inside the loop body");
    assert.doesNotMatch(main, /static const (?:float|std::uint32_t) \w+\[\]/);
    assert.equal(result.manifest.sceneMeshes.length, 15);
});

const nativeTools = optionalNativeFixtureTools();
test("hoisted Scene 90 data compiles warning-clean without per-element initializer sections", { skip: !nativeTools }, () => {
    const path = "corpus/babylon-lite/lab/lite/src/lite/scene90.ts";
    const output = resolve("artifacts/csg-constant-data-check");
    const includes = join(output, "bblite", "upstream");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(includes, "camera_math.hpp"), new CameraLowerer(new LoweringContext()).lowerArcRotateFactory().header);
    const source = join(output, "scene90.cpp");
    writeFileSync(source, compileSource(readFileSync(path, "utf8"), { fileName: path }).cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/c",
        `/Fo:${output}\\`, "/I", output, "/I", "native\\include", source,
    ]);
});

test("shared literal tables preserve distinct typed-array storage on every evaluation", { skip: !nativeTools }, () => {
    const elements = Array.from({ length: 128 }, (_, index) => index).join(", ");
    const result = compileSource(`
        const first = new Float32Array([${elements}]);
        const second = new Float32Array([${elements}]);
        const integers = new Uint32Array([${elements}]);
        first[0] = 99;
        if (second[0] !== 0 || integers[0] !== 0) throw new Error("shared mutable literal storage");
    `);
    assert.equal(result.cpp.match(/inline const std::array<double, 128>/g)?.length, 1);
    assert.equal(result.cpp.match(/f32_array_from\(bblscene::/g)?.length, 2);
    const output = resolve("artifacts/shared-literal-storage-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
