import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { doubleLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("mesh data calls share typed-array results and preserve double box options", () => {
    const result = compileSource(`
        import { createBoxData } from "@babylonjs/lite/mesh/create-box";
        const data = createBoxData({ size: 1.0000000000000002, height: 3 });
        const positions = data.positions;
        positions[0] = data.vertexCount;
    `);
    assert.match(result.cpp, /const double .* = 1\.0000000000000002;/);
    assert.match(result.cpp, /const double .* = 3\.0;/);
    assert.match(result.cpp, /js::F32Array .* = std::move\(.*\.positions\)/);
    assert.equal(result.manifest.sceneMeshes.length, 0);
    assert.ok(result.manifest.features.includes("mesh:box"));
    assert.throws(() => compileSource(`
        import { createBoxData } from "@babylonjs/lite/mesh/create-box";
        createBoxData({ width: 2, segments: 8 });
    `), /Box options support/);
    const factory = new FactoryLowerer(new LoweringContext());
    assert.doesNotMatch(factory.lowerMeshFactories([]).source, /MeshData create_box_data/);
    assert.match(factory.lowerMeshFactories(["mesh:box"]).source, /shift_right_unsigned/);
});

interface BoxData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
}

test("native box payload matches every pinned lane and returned arrays retain aliases", { skip: !tools }, async () => {
    const pin = await importPinnedModule<{
        createBoxData(options?: number | { width: number; height: number; depth: number }): BoxData;
    }>("mesh/create-box.js");
    const checks: string[] = [];
    for (const [width, height, depth] of [
        [1, 1, 1], [0, -0, 0], [-3, 0.1, 7.3],
        [1.0000000596046448, 1e-40, 1e40], [2 ** -149, 2 ** -150, -(2 ** -150)],
    ]) {
        const expected = pin.createBoxData({ width: width!, height: height!, depth: depth! });
        checks.push(`{ const auto data = bbl::create_box_data(${[width!, height!, depth!]
            .map((value) => Object.is(value, -0) ? "-0.0" : doubleLiteral(value)).join(", ")});`);
        for (const name of ["positions", "normals", "uvs"] as const) {
            const bits = [...new Uint32Array(expected[name].buffer)];
            checks.push(`same(data.${name}, {${bits.map((value) => `${value}u`).join(", ")}});`);
        }
        checks.push(`assert((data.indices == std::vector<std::uint32_t>{${[...expected.indices].map((value) => `${value}u`).join(", ")}}));`);
        checks.push(`assert(data.vertex_count == ${expected.vertexCount}u && data.index_count == ${expected.indexCount}u); }`);
    }
    const program = compileSource(`
        import { createBoxData } from "@babylonjs/lite/mesh/create-box";
        import { createSphereData } from "@babylonjs/lite";
        const box = createBoxData();
        const other = createBoxData();
        const positions = box.positions;
        const normals = box.normals;
        const uvs = box.uvs;
        const indices = box.indices;
        positions[0] = 17; normals[0] = 18; uvs[0] = 19; indices[0] = 20;
        if (box.positions[0] !== 17 || box.normals[0] !== 18 || box.uvs[0] !== 19 || box.indices[0] !== 20) throw new Error("box aliases");
        if (other.positions[0] !== 0.5 || other.normals[0] !== 0 || other.uvs[0] !== 1 || other.indices[0] !== 0) throw new Error("box independence");
        const sphere = createSphereData({ segments: 3 });
        const spherePositions = sphere.positions;
        spherePositions[0] = 21;
        if (sphere.positions[0] !== 21) throw new Error("sphere alias");
        const randomBox = createBoxData(Math.random());
        if (Math.abs(randomBox.positions[0]) !== Math.abs(randomBox.positions[1]) ||
            Math.abs(randomBox.positions[0]) !== Math.abs(randomBox.positions[2])) throw new Error("size sampled more than once");
        let calls = 0;
        function next(): number { calls++; return calls; }
        const ordered = createBoxData({ depth: next(), size: next(), width: next() });
        if (calls !== 3 || Math.abs(ordered.positions[0]) !== 1.5 ||
            Math.abs(ordered.positions[1]) !== 1 || Math.abs(ordered.positions[2]) !== 0.5) throw new Error("option evaluation order");
    `);
    const output = resolve("artifacts/mesh-data-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    const factories = new FactoryLowerer(new LoweringContext()).lowerMeshFactories(["mesh:box"]).source;
    writeFileSync(source, `#define main generated_scene_main
${program.cpp}
#undef main
${factories}
#include <bit>
#include <cassert>
void same(const std::vector<float>& actual, const std::vector<std::uint32_t>& expected) {
    assert(actual.size() == expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) assert(std::bit_cast<std::uint32_t>(actual[i]) == expected[i]);
}
int main() {
    assert(generated_scene_main() == 0);
${checks.join("\n")}
}
`);
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source,
        "/link", "/OPT:REF",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
