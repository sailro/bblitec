import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("SDL shader texture binding follows active slots and refuses stale or incomplete uploads", { skip: !native }, () => {
    const output = resolve("artifacts/material-texture-bindings");
    mkdirSync(output, { recursive: true });
    const source = readFileSync("native/src/pal_sdl_gpu.cpp", "utf8");
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
using Uint32 = std::uint32_t;
struct SDL_GPURenderPass {};
struct SDL_GPUTextureSamplerBinding { unsigned texture = 0, sampler = 0; };
static unsigned bindings = 0, cache_reads = 0;
static std::vector<SDL_GPUTextureSamplerBinding> submitted;
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* values, Uint32 count) {
    assert(first == 0); ++bindings; submitted.assign(values, values + count);
}
namespace bbl::upstream {
struct ShaderVariantInfo { const char* name = "fixture"; };
const ShaderVariantInfo& shader_variant_info(std::uint32_t) { static ShaderVariantInfo info; return info; }
}
namespace bbl::pal {
struct GpuMesh { std::vector<SDL_GPUTextureSamplerBinding> textures; };
struct GpuState {
    struct Slots { std::vector<std::string> textures; };
    std::array<Slots, 3> shader_fragment_slots;
    std::vector<SDL_GPUTextureSamplerBinding> shader_texture_binding_scratch;
};
const auto& mesh_shader_textures(const GpuMesh& mesh) { ++cache_reads; return mesh.textures; }
[[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(message); }
${cppFunction(source, "void bind_shader_material_textures(")}
}
int main() {
    using namespace bbl;
    pal::GpuState state; pal::GpuMesh mesh;
    state.shader_fragment_slots[1].textures = {"albedo"};
    state.shader_fragment_slots[2].textures = {"albedo", "normal"};
    mesh.textures = {{11, 21}};
    Scene scene; Engine engine; MaterialRecord material;
    const auto bind = [&](unsigned variant) {
        pal::bind_shader_material_textures(state, nullptr, scene, engine, material, variant, mesh);
    };
    bind(0);
    assert(cache_reads == 0 && bindings == 0 && state.shader_texture_binding_scratch.empty());
    bind(1);
    assert(cache_reads == 1 && bindings == 1 && submitted.size() == 1);
    assert(submitted[0].texture == 11 && submitted[0].sampler == 21);
    bind(0);
    assert(cache_reads == 1 && bindings == 1);
    const auto refuses = [&](unsigned variant, const char* message) {
        bool rejected = false;
        try { bind(variant); } catch (const std::runtime_error& error) {
            rejected = std::string(error.what()).find(message) != std::string::npos;
        }
        assert(rejected && bindings == 1);
    };
    refuses(2, "binding count is stale");
    mesh.textures[0].sampler = 0;
    refuses(1, "'albedo' is not ready");
    mesh.textures = {{11, 21}, {12, 22}};
    bind(2);
    assert(bindings == 2 && submitted.size() == 2);
    assert(submitted[1].texture == 12 && submitted[1].sampler == 22);
    mesh.textures.clear(); bind(1);
    assert(bindings == 2);
}
`);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`, file, `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    execFileSync(executable, { stdio: "pipe" });
});
