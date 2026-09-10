import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SplatLowerer } from "../src/lowering/splat-lowerer.js";

const nativeTools = optionalNativeFixtureTools(false);

for (const shDegree of [0, 1]) test(`splat draw capture uses live cloud counts and frame uniforms (SH ${shDegree})`, { skip: !nativeTools }, () => {
    const output = resolve(`artifacts/splat-draw-capture-${shDegree}`);
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const lowerer = new SplatLowerer(new LoweringContext(), shDegree);
    const sort = lowerer.lowerSort();
    writeFileSync(join(headers, "splat_geometry.hpp"), lowerer.lowerGeometry().header!);
    writeFileSync(join(headers, "splat_sort.hpp"), sort.header!);
    writeFileSync(join(output, "sort.cpp"), sort.source);
    const capture = readFileSync("native/src/pal_render_capture.hpp", "utf8").replaceAll("\r\n", "\n");
    const writerStart = capture.indexOf("class JsonWriter {");
    const writerEnd = capture.indexOf("\n};", writerStart) + 3;
    assert.ok(writerStart >= 0 && writerEnd > writerStart);
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/upstream/splat_sort.hpp>
#include <cassert>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
namespace bbl::pal {
${capture.slice(writerStart, writerEnd)}
template <typename Uniforms>
${cppFunction(capture, "inline void write_uniform_block(")}
${cppFunction(capture, "inline void write_splat_draw_list(")}
}
int main(int argc, char** argv) {
    assert(argc == 2);
    bbl::Engine engine;
    engine.splat_meshes.resize(3);
    auto& first = engine.splat_meshes[1];
    first.vertex_count = 7; first.texture_width = 8; first.texture_height = 4;
    first.position = {3, 4, 5}; first.scaling = {2, 3, 4};
    auto& second = engine.splat_meshes[2];
    second.vertex_count = 2; second.texture_width = 4; second.texture_height = 2;
    bbl::Scene scene;
    scene.splat_meshes = {{2}, {0}, {99}, {1}};
    std::array<float, 16> view{}, projection{};
    for (std::size_t i = 0; i < 16; ++i) { view[i] = float(i + 1); projection[i] = float(20 + i); }
    const std::array<float, 4> eye{7, 8, 9, 1};
    std::ofstream stream(argv[1]);
    bbl::pal::JsonWriter json(stream);
    json.begin_array();
    bbl::pal::write_splat_draw_list(json, scene, engine, view, projection, eye, 640, 360);
    json.end_array();
}
`);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/DBBLITE_SPLAT_SH=${shDegree}`, "/I", "native/include", "/I", output,
        `/Fo:${output}\\`, `/Fe:${executable}`, source, join(output, "sort.cpp")]);
    const path = join(output, "capture.json");
    execFileSync(executable, [path], { stdio: "pipe" });
    const rows = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(rows.map((row: { splat: number; instanceCount: number }) => [row.splat, row.instanceCount]), [[2, 2], [1, 7]]);
    for (const row of rows) {
        assert.equal(row.stage, "transparent");
        assert.equal(row.pipeline, "splat");
        assert.equal(row.indexCount, 6);
        assert.equal(row.vertexCount, 4);
        assert.equal(row.uniforms.length, 1);
        const uniform = row.uniforms[0];
        assert.equal(uniform.stage, "vertex");
        assert.equal(uniform.slot, 0);
        assert.equal(uniform.type, "SplatUniforms");
        assert.deepEqual(uniform.floats.slice(16, 32), Array.from({ length: 16 }, (_, i) => i + 1));
        assert.deepEqual(uniform.floats.slice(32, 48), Array.from({ length: 16 }, (_, i) => i + 20));
        assert.deepEqual(uniform.floats.slice(48, 50), [640, 360]);
        assert.deepEqual(uniform.floats.slice(52, 54), row.splat === 1 ? [8, 4] : [4, 2]);
        if (shDegree) assert.deepEqual(uniform.floats.slice(56, 59), [7, 8, 9]);
    }
    assert.deepEqual(rows[1].uniforms[0].floats.slice(12, 15), [3, 4, 5]);
});
test("splat capture preserves complete current byte storage and reports write failures", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/splat-capture-check");
    mkdirSync(output, { recursive: true });
    const capture = readFileSync("native/src/pal_render_capture.hpp", "utf8").replaceAll("\r\n", "\n");
    const writerStart = capture.indexOf("class JsonWriter {");
    const writerEnd = capture.indexOf("\n};", writerStart) + 3;
    const splatStart = capture.indexOf("inline void write_splat_list(");
    const splatEnd = capture.indexOf("\n}\n", splatStart) + 3;
    assert(writerStart >= 0 && writerEnd > writerStart && splatStart >= 0 && splatEnd > splatStart);
    const source = join(output, "check.cpp");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
namespace bbl::pal {
${capture.slice(writerStart, writerEnd)}
${capture.slice(splatStart, splatEnd)}
}
int main(int argc, char** argv) {
    assert(argc == 2);
    const std::filesystem::path directory(argv[1]);
    bbl::Engine engine;
    engine.splat_meshes.resize(3);
    auto& retained = engine.splat_meshes[1];
    retained.vertex_count = 2;
    retained.data_version = 7;
    retained.bound_min = {-1, -2, -3};
    retained.bound_max = {1, 2, 3};
    bbl::js::F32Array owner{1.0f, 2.0f, 3.0f, 4.0f};
    retained.splats_data = std::make_shared<bbl::js::ArrayBuffer>(owner);
    owner[1] = -2.0f;
    engine.splat_meshes[2].splats_data = std::make_shared<bbl::js::ArrayBuffer>();
    bbl::Scene scene;
    scene.splat_meshes = {bbl::SplatMeshHandle{0}, bbl::SplatMeshHandle{1}, bbl::SplatMeshHandle{2}};
    const std::string path = (directory / "capture.json").string();
    std::ofstream stream(path);
    bbl::pal::JsonWriter json(stream);
    json.begin_array();
    bbl::pal::write_splat_list(json, scene, engine, path);
    json.end_array();
    stream.close();
    bool failed = false;
    try {
        std::ostringstream ignored;
        bbl::pal::JsonWriter invalid(ignored);
        bbl::pal::write_splat_list(invalid, scene, engine, (directory / "capture.json" / "invalid.json").string());
    } catch (const std::runtime_error&) { failed = true; }
    assert(failed);
    assert(retained.data_version == 7 && owner[1] == -2.0f);
    std::cout << "splat-capture: ok";
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, source]);
    assert.match(execFileSync(executable, [output], { encoding: "utf8" }), /splat-capture: ok/);
    const records = JSON.parse(readFileSync(join(output, "capture.json"), "utf8"));
    assert.equal(records.length, 3);
    assert.equal(records[0].retainedDataFile, undefined);
    assert.equal(existsSync(join(output, "capture.json.splat-0.bin")), false);
    assert.deepEqual(records[1], { index: 1, name: "", vertexCount: 2, dataVersion: 7,
        boundMin: [-1, -2, -3], boundMax: [1, 2, 3], byteLength: 16, retainedDataFile: "capture.json.splat-1.bin" });
    const bytes = readFileSync(join(output, records[1].retainedDataFile));
    assert.deepEqual([...new Float32Array(bytes.buffer, bytes.byteOffset, 4)], [1, -2, 3, 4]);
    assert.equal(readFileSync(join(output, records[2].retainedDataFile)).length, 0);
});
