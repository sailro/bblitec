import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("depth and diagnostic draws publish each mesh's current world and deformation", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/depth-deformation-transport");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    const helper = cppFunction(
        readFileSync("native/src/pal_sdl_gpu_scene_meshes.cpp", "utf8"),
        "void push_mesh_stage_blocks(",
    );
    writeFileSync(
        source,
        `#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
struct SDL_GPUCommandBuffer {};
struct Scene {};
struct Engine {};
struct MeshRecord { float world; float pose; };
struct DeformationUniforms { float pose; };
constexpr std::uint32_t mesh_world_uniform_slot = BBLITE_GPU_DEFORMATION ? 2 : 1;
std::array<float, 16> mesh_block_world(const Scene&, const Engine&, const MeshRecord& mesh) { return {mesh.world}; }
DeformationUniforms build_deformation_uniforms(const MeshRecord& mesh) { return {mesh.pose}; }
std::array<float, 3> slots{};
unsigned writes = 0;
void SDL_PushGPUVertexUniformData(SDL_GPUCommandBuffer*, std::uint32_t slot, const void* value, std::size_t bytes) {
    assert(bytes == (slot == mesh_world_uniform_slot ? 64 : sizeof(DeformationUniforms)));
    std::memcpy(&slots.at(slot), value, sizeof(float)); ++writes;
}
${readFileSync("test/fixtures/gpu-writer-recorder.hpp", "utf8")}
${helper}
int main() {
    for (const MeshRecord mesh : {MeshRecord{2, 3}, MeshRecord{7, 11}}) {
        writes = 0; push_mesh_stage_blocks(nullptr, Scene{}, Engine{}, mesh);
        assert(slots[mesh_world_uniform_slot] == mesh.world);
        assert(writes == (BBLITE_GPU_DEFORMATION ? 2u : 1u));
#if BBLITE_GPU_DEFORMATION
        assert(slots[1] == mesh.pose);
#endif
    }
}
`,
    );
    for (const deformation of [0, 1]) {
        runNativeFixtureCompiler(native, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            `/DBBLITE_GPU_DEFORMATION=${deformation}`,
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            source,
        ]);
        execFileSync(executable);
    }
    for (const file of ["pal_sdl_gpu.cpp", "pal_sdl_gpu_scene_targets.cpp"]) {
        assert.match(
            readFileSync(`native/src/${file}`, "utf8"),
            /push_mesh_stage_blocks\(/,
        );
    }
    const dawn = readFileSync("native/src/pal_dawn.cpp", "utf8");
    assert.match(dawn, /task_pass, 0, bindings\.morph/);
    assert.match(
        cppFunction(dawn, "WGPURenderPipeline depth_only_pipeline_for("),
        /create_dawn_reflected_layout\(state\.device, stages, 0\)/,
    );
});
