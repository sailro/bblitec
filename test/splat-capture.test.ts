import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);
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
