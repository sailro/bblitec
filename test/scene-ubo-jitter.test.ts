import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneUboLowerer } from "../src/lowering/scene-ubo-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface PinTaa {
    execute(): number;
    _halton: Float32Array;
    _haltonIndex: number;
    _jitterScratch: Float32Array;
    _blend: { updateUniforms(): void; execute(): number };
    _present: { execute(): number };
    _historyUpdate: { execute(): number };
}

test("pinned jitter preserves clean data, writes one matrix after history, and wraps its sequence", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const pin = await importPinnedModule<{
        createTaaPostProcessTask(config: object, engine: object, scene: object): PinTaa;
    }>("post-process/taa.js");
    const directory = resolve("artifacts/scene-ubo-jitter-check");
    mkdirSync(directory, { recursive: true });
    const header = new SceneUboLowerer(new LoweringContext()).jitterHeader();
    writeFileSync(join(directory, "jitter.hpp"), header);
    const clean = Float32Array.from({ length: 92 }, (_, i) => (i % 7 - 3) * .125 + i * .01);
    const drawn = clean.slice();
    const target = { _width: 129, _height: 65,
        _descriptor: { size: { width: 129, height: 65 }, format: "rgba8unorm" } };
    const expected: Buffer[] = [];
    const events: string[] = [];
    let reject = false;
    const engine = { scRT: target, _device: { queue: {
        writeBuffer(buffer: Float32Array, offset: number, data: Float32Array) {
            assert.equal(buffer, drawn);
            assert.equal(offset, 0);
            assert.equal(data.length, 16);
            assert.deepEqual(events.splice(0), ["uniform", "blend", "present", "history"]);
            if (reject) throw new Error("upload failed");
            buffer.set(data, offset / 4);
            expected.push(Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
        },
    } } };
    const task = pin.createTaaPostProcessTask({ sourceTexture: target, samples: 8,
        sourceRenderTask: { scene: { camera: null }, _suData: clean, _sceneUBO: drawn } }, engine, {});
    task._blend.updateUniforms = () => { events.push("uniform"); };
    for (const [name, child] of [["blend", task._blend], ["present", task._present], ["history", task._historyUpdate]] as const)
        child.execute = () => { events.push(name); return 1; };
    for (let frame = 0; frame < 19; frame++) task.execute();
    assert.equal(task._haltonIndex, 6);
    assert.deepEqual(drawn.slice(16), clean.slice(16));
    assert.notDeepEqual(drawn.slice(0, 16), clean.slice(0, 16));
    const index = task._haltonIndex;
    target._width = 0;
    task.execute();
    assert.equal(task._haltonIndex, index);
    events.length = 0;
    target._width = 129;
    reject = true;
    assert.throws(() => task.execute(), /upload failed/);
    assert.equal(task._haltonIndex, index + 2);
    assert.deepEqual(clean, Float32Array.from({ length: 92 }, (_, i) => (i % 7 - 3) * .125 + i * .01));

    writeFileSync(join(directory, "clean.bin"), Buffer.from(clean.buffer));
    const source = join(directory, "check.cpp");
    const executable = join(directory, "check.exe");
    writeFileSync(source, `#include "jitter.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <stdexcept>
struct State { std::vector<float> halton; double halton_index = 0; std::array<float,16> jitter_scratch{}; };
struct Source { std::array<float,92> clean{}, drawn{}; };
int main(int argc, char** argv) {
    assert(argc == 3);
    Source source;
    std::ifstream input(argv[1], std::ios::binary);
    input.read(reinterpret_cast<char*>(source.clean.data()), sizeof(source.clean));
    assert(input.good());
    source.drawn = source.clean;
    State state{bbl::upstream::generate_taa_halton(8.0)};
    std::ofstream output(argv[2], std::ios::binary);
    int writes = 0;
    bool reject = false;
    auto write = [&](Source& target, double offset, const std::array<float,16>& values) {
        assert(&target == &source && offset == 0.0);
        if (reject) throw std::runtime_error("upload failed");
        std::copy(values.begin(), values.end(), target.drawn.begin());
        output.write(reinterpret_cast<const char*>(values.data()), sizeof(values));
        ++writes;
    };
    for (int frame = 0; frame < 19; ++frame)
        bbl::upstream::advance_taa_jitter(state, source, 129.0, 65.0, write);
    assert(state.halton_index == 6.0 && writes == 19);
    assert(std::equal(source.clean.begin()+16, source.clean.end(), source.drawn.begin()+16));
    const auto original = source.clean;
    bbl::upstream::advance_taa_jitter(state, source, 0.0, 65.0, write);
    assert(state.halton_index == 6.0 && writes == 19);
    reject = true;
    bool failed = false;
    try { bbl::upstream::advance_taa_jitter(state, source, 129.0, 65.0, write); }
    catch (const std::runtime_error&) { failed = true; }
    assert(failed && state.halton_index == 8.0 && writes == 19);
    assert(source.clean == original);
    output.close();
    std::cout << "scene-ubo-jitter: ok";
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    const actual = join(directory, "native.bin");
    assert.match(execFileSync(executable, [join(directory, "clean.bin"), actual], { encoding: "utf8" }), /scene-ubo-jitter: ok/);
    assert.deepEqual(readFileSync(actual), Buffer.concat(expected));
});
