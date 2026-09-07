import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);
test("temporal capture observes distinct clean/drawn storage and private state without executing writers", { skip: !nativeTools }, () => {
    const directory = resolve("artifacts/temporal-capture-check");
    mkdirSync(directory, { recursive: true });
    const capture = readFileSync("native/src/pal_render_capture.hpp", "utf8").replaceAll("\r\n", "\n");
    const writerStart = capture.indexOf("class JsonWriter {");
    const writerEnd = capture.indexOf("\n};", writerStart) + 3;
    const taskStart = capture.indexOf("inline void write_temporal_tasks(");
    const taskEnd = capture.indexOf("\n}\n", taskStart) + 3;
    assert(writerStart >= 0 && writerEnd > writerStart && taskStart >= 0 && taskEnd > taskStart);
    const source = join(directory, "check.cpp");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <cassert>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <sstream>
namespace bbl::pal {
${capture.slice(writerStart, writerEnd)}
${capture.slice(taskStart, taskEnd)}
}
int main() {
    bbl::Engine engine;
    engine.frame_tasks.resize(3);
    auto& source = engine.frame_tasks[1];
    source.render.name = "source";
    source.scene_uniforms = std::make_shared<bbl::PersistentSceneUniforms>();
    source.scene_uniforms->clean = {1.0f, 0.1f, -0.0f};
    source.scene_uniforms->drawn = {2.0f, 0.2f, -0.0f};
    source.scene_uniforms->cache.camera_key = 17;
    auto& composite = engine.frame_tasks[2].post_process;
    composite.name = "taa";
    composite.source_tasks = {bbl::TaskHandle{1}};
    composite.taa = std::make_shared<bbl::TaaPostProcessState>();
    composite.taa->factor = .05;
    composite.taa->execution_count = 161;
    composite.taa->halton_index = 2;
    composite.taa->last_camera_version = 17;
    composite.taa->halton = {.5f, .25f};
    composite.passes.resize(1);
    composite.passes[0].params = {1};
    bbl::Scene scene;
    scene.tasks = {bbl::TaskHandle{0}, bbl::TaskHandle{1}, bbl::TaskHandle{2}};
    bbl::pal::JsonWriter json(std::cout);
    bbl::pal::write_temporal_tasks(json, scene, engine);
    assert(source.scene_uniforms->clean[0] == 1 && source.scene_uniforms->drawn[0] == 2);
    assert(source.scene_uniforms->cache.camera_key == 17 && composite.taa->execution_count == 161);
    assert(composite.taa->factor == .05 && composite.passes[0].params[0] == 1);
}
`);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    const records = JSON.parse(execFileSync(executable, { encoding: "utf8" }));
    assert.equal(records.length, 2);
    assert.equal(records[0].taskIndex, 1);
    assert.deepEqual(records[0].clean.map(Math.fround), [1, Math.fround(.1), -0]);
    assert.deepEqual(records[0].drawn.map(Math.fround), [2, Math.fround(.2), -0]);
    assert.equal(records[0].cache.cameraKey, 17);
    assert.equal(records[1].taskIndex, 2);
    assert.equal(records[1].executions, 161);
    assert.equal(records[1].factor, .05);
    assert.equal(records[1].blendFactor, 1);
    assert.equal(records[1].haltonIndex, 2);
    assert.deepEqual(records[1].sourceTasks, [1]);
});
