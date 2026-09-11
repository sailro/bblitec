import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { MeshBuilderLowerer } from "../src/lowering/factory/mesh-builders.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("thin-instance color writes retain owned buffers and offset views with pinned rounding", { skip: !native }, async () => {
    const pinned = await importPinnedModule<{
        setThinInstanceColors(mesh: unknown, colors: Float32Array): void;
        setThinInstanceColor(mesh: unknown, index: number, r: number, g: number, b: number, a: number): void;
        setThinInstanceCullBoundsPad(mesh: unknown, pad: number): void;
    }>("mesh/thin-instance.js");
    const colors = new Float32Array(new ArrayBuffer(48), 8, 8);
    const mesh = { thinInstances: { count: 2, _version: 0, _colorVersion: 0, _colorDirtyMin: 0, _colorDirtyMax: 0, _cullBoundsPad: 0 } };
    pinned.setThinInstanceColors(mesh, colors);
    pinned.setThinInstanceColor(mesh, 1, .1, .2, .3, .4);
    pinned.setThinInstanceColor(mesh, -.25, 1, 2, 3, 4);
    pinned.setThinInstanceColor(mesh, NaN, 5, 6, 7, 8);
    pinned.setThinInstanceCullBoundsPad(mesh, 2.5);
    const lowered = new MeshBuilderLowerer(new LoweringContext()).lowerMeshFactories([
        "mesh:thin-instances", "mesh:thin-instance-colors",
    ]).source;
    const functions = ["set_thin_instance_colors", "set_thin_instance_color", "set_thin_instance_cull_bounds_pad"]
        .map(name => cppFunction(lowered, `void ${name}(`)).join("\n");
    const output = resolve("artifacts/thin-instance-colors");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, `#include <bblite/js_data.hpp>
#include <cassert>
namespace bbl {
struct MeshHandle { unsigned value; };
struct MeshRecord {
    bool thin_instanced = true;
    unsigned instance_count = 2, instance_version = 0;
    std::vector<float> instance_colors;
    std::shared_ptr<js::F32Array> instance_color_source;
    double thin_instance_cull_bounds_pad = 0;
};
struct Engine { std::array<MeshRecord, 1> meshes; };
${cppFunction(readFileSync("native/src/pal_gpu_shared.hpp", "utf8"), "inline std::vector<float> instance_colors_for_upload(")}
${functions}
}
int main() {
    for (bool view : {false, true}) {
        bbl::Engine engine;
        bbl::js::ArrayBuffer buffer(std::make_shared<std::vector<std::uint8_t>>(48));
        bbl::js::F32Array colors = view ? bbl::js::F32Array(buffer, 8, 8) : bbl::js::F32Array(8);
        bbl::set_thin_instance_colors(engine, {0}, colors);
        bbl::set_thin_instance_color(engine, {0}, 1, .1, .2, .3, .4);
        bbl::set_thin_instance_color(engine, {0}, -.25, 1, 2, 3, 4);
        bbl::set_thin_instance_color(engine, {0}, std::numeric_limits<double>::quiet_NaN(), 5, 6, 7, 8);
        bbl::set_thin_instance_cull_bounds_pad(engine, {0}, 2.5);
        const std::array<double, 8> expected{${Array.from(colors).join(",")}};
        const auto uploaded = bbl::instance_colors_for_upload(engine.meshes[0]);
        for (std::size_t lane = 0; lane < expected.size(); ++lane) {
            assert(colors.load(lane) == expected[lane]);
            assert(uploaded[lane] == expected[lane]);
        }
        assert(engine.meshes[0].instance_colors.empty());
        assert(engine.meshes[0].instance_version == ${mesh.thinInstances._version});
        assert(engine.meshes[0].thin_instance_cull_bounds_pad == ${mesh.thinInstances._cullBoundsPad});
    }
}`);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
    const result = compileSource(`
        import { createEngine, createBox, setThinInstances, setThinInstanceColors, setThinInstanceColor,
            setThinInstanceCullBoundsPad } from "@babylonjs/lite";
        const engine = createEngine(document.createElement("canvas"));
        const mesh = createBox(engine);
        setThinInstances(mesh, new Float32Array(16), 1);
        setThinInstanceColors(mesh, new Float32Array(4));
        setThinInstanceColor(mesh, 0, 1, .5, .25, 1);
        setThinInstanceCullBoundsPad(mesh, 2);
    `);
    assert.match(result.cpp, /bbl::set_thin_instance_color\(/);
    assert.match(result.cpp, /bbl::set_thin_instance_cull_bounds_pad\(/);
});
