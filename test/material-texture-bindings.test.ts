import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    cppRecord,
    cppSection,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test(
    "SDL shader texture binding follows active slots and refuses stale or incomplete uploads",
    { skip: !native },
    () => {
        const output = resolve("artifacts/material-texture-bindings");
        mkdirSync(output, { recursive: true });
        const source = sceneBackendSource("sdl");
        const shared = readFileSync(
            "native/src/pal_sdl_gpu_shared.hpp",
            "utf8",
        );
        const materials = readFileSync(
            "native/src/pal_gpu_materials.hpp",
            "utf8",
        );
        const gpuShared = readFileSync("native/src/pal_gpu_shared.cpp", "utf8");
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
using Uint32 = std::uint32_t;
struct SDL_GPURenderPass {};
struct SDL_GPUTexture {};
SDL_GPUTexture* texture(unsigned id) { static std::array<SDL_GPUTexture, 80> values; return &values.at(id); }
struct SDL_GPUTextureSamplerBinding { SDL_GPUTexture* texture = nullptr; unsigned sampler = 0; };
static unsigned bindings = 0, cache_reads = 0;
static std::vector<SDL_GPUTextureSamplerBinding> submitted;
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* values, Uint32 count) {
    assert(first == 0); ++bindings; submitted.assign(values, values + count);
}
void SDL_BindGPUVertexSamplers(SDL_GPURenderPass*, Uint32, const SDL_GPUTextureSamplerBinding*, Uint32) { assert(false); }
void SDL_BindGPUVertexStorageTextures(SDL_GPURenderPass*, Uint32, SDL_GPUTexture* const*, Uint32) { assert(false); }
void SDL_BindGPUFragmentStorageTextures(SDL_GPURenderPass*, Uint32, SDL_GPUTexture* const*, Uint32) { assert(false); }
namespace bbl::upstream {
struct ShaderVariantInfo { const char* name = "fixture"; std::vector<std::string> samplers; };
const ShaderVariantInfo& shader_variant_info(std::uint32_t variant) { static const std::array<ShaderVariantInfo,3> info{{{"fixture",{}},{"fixture",{"albedo"}},{"fixture",{"albedo","normal"}}}}; return info.at(variant); }
}
namespace bbl::pal {
${cppRecord(shared, "struct PinnedStageBinding")}
${cppRecord(shared, "struct PinnedStageSlots")}
[[noreturn]] void gpu_error(const char* message) { throw std::runtime_error(message); }
${cppSection(shared, "template <typename Resolve>\ninline void resolve_stage_textures(", "/**\n * The storage sibling")}
${cppRecord(source, "struct ShaderStageTextureSlots")}
struct GpuMesh { std::vector<SDL_GPUTextureSamplerBinding> textures; };
struct GpuState {
    std::array<PinnedStageSlots, 3> shader_vertex_slots, shader_fragment_slots;
    // Each packed texture's declared slot, per program.
    std::array<ShaderStageTextureSlots, 3> shader_vertex_texture_slots, shader_fragment_texture_slots;
    StageTextureBindingScratch shader_texture_binding_scratch;
    unsigned ground_sampler = 33;
};
// A render target's current colour texture.
SDL_GPUTexture* sdl_shader_render_texture(const GpuState&, const Engine&, const RenderTextureRef&) { return texture(77); }
const auto& mesh_shader_textures(const GpuMesh& mesh) { ++cache_reads; return mesh.textures; }
${cppFunction(materials, "inline const MaterialRecord& shader_resource_material(")}
${cppFunction(materials, "inline std::string shader_sampler_unmapped(")}
${cppFunction(gpuShared, "std::string shader_sampler_shortfall(")}
${cppFunction(source, "void bind_shader_material_textures(")}
}
int main() {
    using namespace bbl;
    pal::GpuState state; pal::GpuMesh mesh;
    state.shader_fragment_slots[1].textures = {"albedo"};
    state.shader_fragment_slots[2].textures = {"albedo", "normal"};
    state.shader_fragment_texture_slots[1].sampled = {0};
    state.shader_fragment_texture_slots[2].sampled = {0, 1};
    mesh.textures = {{texture(11), 21}};
    Scene scene; Engine engine; MaterialRecord material;
    const auto bind = [&](unsigned variant) {
        pal::bind_shader_material_textures(state, nullptr, scene, engine, material, variant, mesh);
    };
    bind(0);
    assert(cache_reads == 1 && bindings == 0 && state.shader_texture_binding_scratch.sampled.empty());
    bind(1);
    assert(cache_reads == 2 && bindings == 1 && submitted.size() == 1);
    assert(submitted[0].texture == texture(11) && submitted[0].sampler == 21);
    bind(0);
    assert(cache_reads == 3 && bindings == 1);
    const auto refuses = [&](unsigned variant, const char* message) {
        bool rejected = false;
        try { bind(variant); } catch (const std::runtime_error& error) {
            rejected = std::string(error.what()).find(message) != std::string::npos;
        }
        assert(rejected && bindings == 1);
    };
    refuses(2, "material carries 1 texture(s)");
    mesh.textures[0].sampler = 0;
    refuses(1, "'albedo' is not ready");
    mesh.textures = {{texture(11), 21}, {texture(12), 22}};
    bind(2);
    assert(bindings == 2 && submitted.size() == 2);
    assert(submitted[1].texture == texture(12) && submitted[1].sampler == 22);
    // A render target's declared slot binds the target's current texture.
    material.shader_render_textures = {std::nullopt, RenderTextureRef{}};
    bind(2);
    assert(bindings == 3 && submitted[0].texture == texture(11) && submitted[0].sampler == 21);
    assert(submitted[1].texture == texture(77) && submitted[1].sampler == 33);
    material.shader_render_textures.clear();
    mesh.textures.clear();
    bool missing = false;
    try { bind(1); } catch (const std::runtime_error&) { missing = true; }
    assert(missing);
    assert(bindings == 3);
}
`,
        );
        runNativeFixtureCompiler(native!, [
            file,
            `/Fe:${executable}`,
            `/Fo:${join(output, "check.obj")}`,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
