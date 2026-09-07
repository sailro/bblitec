import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneUboLowerer } from "../src/lowering/scene-ubo-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("pinned task storage owns zeroed clean scratch and independent retained jitter sequences", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const { createRenderTask } = await importPinnedModule<{
        createRenderTask(config: object, engine: object, scene: object): {
            scene: object; _suData: Float32Array; _sceneUBO: { size: number }; _sceneUboCacheKey: unknown[];
        };
    }>("frame-graph/render-task.js");
    const { createTaaPostProcessTask } = await importPinnedModule<{
        createTaaPostProcessTask(config: object, engine: object, scene: object): {
            samples: number; _halton: Float32Array; _jitterScratch: Float32Array;
        };
    }>("post-process/taa.js");
    const scene = { lights: [], _disposables: [] };
    const target = { _width: 64, _height: 32, _descriptor: { format: "rgba8unorm", size: { width: 64, height: 32 } } };
    const engine = { scRT: target, _device: {
        createBindGroupLayout: (descriptor: object) => descriptor,
        createBindGroup: (descriptor: object) => descriptor,
        createBuffer: (descriptor: object) => descriptor,
        queue: { writeBuffer() { /* Initial lights upload is outside the source UBO. */ } },
    } };
    const source = createRenderTask({ rt: target, name: "source" }, engine, scene);
    assert.equal(source.scene, scene);
    assert.equal(source._sceneUBO.size, source._suData.byteLength);
    assert.deepEqual(source._sceneUboCacheKey, []);
    assert.ok(source._suData.every((value) => value === 0));
    const configs = [{}, { samples: 1 }, { samples: 3.9 }, { samples: -2 }];
    const states = configs.map((config) => createTaaPostProcessTask({ ...config, sourceTexture: target, sourceRenderTask: source }, engine, scene));
    assert.deepEqual(states.map((state) => state.samples), [8, 1, 3, 1]);
    for (const state of states) assert.deepEqual([...state._jitterScratch], Array(16).fill(0));
    assert.notEqual(states[1]!._halton, states[3]!._halton);
    const directory = resolve("artifacts/scene-ubo-storage-check");
    mkdirSync(directory, { recursive: true });
    const lowerer = new SceneUboLowerer(new LoweringContext());
    const sourcePath = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(join(directory, "storage.hpp"), `#include <bblite/runtime.hpp>\n${lowerer.jitterHeader()}\n${lowerer.storageHeader()}`);
    writeFileSync(sourcePath, `#include "storage.hpp"
#include <cassert>
#include <fstream>
int main(int argc, char** argv) {
    assert(argc == 2);
    auto source = bbl::upstream::create_persistent_scene_uniforms();
    assert(source->clean.size() == ${source._suData.length}u && source->drawn == source->clean);
    for (const float value : source->clean) assert(value == 0.0f);
    assert(source->cache.camera == nullptr);
    bbl::Engine engine;
    bbl::Scene scene;
    scene.camera = bbl::CameraHandle{7};
    engine.frame_tasks.resize(1);
    engine.frame_tasks[0].source_scene = scene.state;
    engine.frame_tasks[0].scene_uniforms = source;
    engine.frame_tasks.resize(128);
    auto retained_scene = bbl::Scene::from_state(engine.frame_tasks[0].source_scene);
    scene.camera = bbl::CameraHandle{9};
    assert(retained_scene.camera.value == 9 && engine.frame_tasks[0].scene_uniforms == source);
    source->clean[0] = 42; source->drawn[0] = 17;
    bbl::FrameTaskRecord copied = engine.frame_tasks[0];
    assert(copied.scene_uniforms->clean[0] == 42 && copied.scene_uniforms->drawn[0] == 17);
    auto separate = bbl::upstream::create_persistent_scene_uniforms();
    assert(separate != source && separate->clean[0] == 0);
    std::ofstream bytes(argv[1], std::ios::binary);
    for (const double samples : {${states.map((state) => `${state.samples}.0`).join(", ")}}) {
        bbl::TaaPostProcessState state{};
        bbl::upstream::initialize_taa_jitter(state, samples);
        bytes.write(reinterpret_cast<const char*>(state.halton.data()), static_cast<std::streamsize>(state.halton.size() * sizeof(float)));
        for (const float value : state.jitter_scratch) assert(value == 0.0f);
    }
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/I${resolve("native/include")}`, `/Fo:${directory}\\`, `/Fe:${executable}`, sourcePath]);
    const output = join(directory, "native.bin");
    execFileSync(executable, [output]);
    const expected = Buffer.concat(states.map((state) => Buffer.from(new Uint8Array(state._halton.buffer))));
    assert.ok(readFileSync(output).equals(expected), "Native Halton sequence bytes differ from the pin.");
});
