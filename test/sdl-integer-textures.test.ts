import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { remapPinnedVariantRegisters, shaderStageSlots } from "../src/shader-bindings.js";
import { cppFunction, cppRecord, cppSection, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("SDL integer texture allocations, shader counts and draw bindings preserve uint payloads", t => {
    const tools = optionalNativeFixtureTools(false);
    const sdlInclude = resolve("artifacts/tools/sdl-min/include");
    if (!tools || !existsSync(join(sdlInclude, "SDL3/SDL_gpu.h"))) {
        t.skip("A native fixture compiler and pinned SDL headers are required.");
        return;
    }
    const shared = readFileSync("native/src/pal_sdl_gpu_shared.hpp", "utf8");
    const splat = readFileSync("native/src/pal_sdl_gpu_splat.hpp", "utf8");
    const clustered = readFileSync("native/src/pal_sdl_gpu_clustered.hpp", "utf8");
    const hlsl = `ByteAddressBuffer morph : register(t0, space1);
Texture2D<uint4> cells : register(t2, space1);
Texture2D<float4> color : register(t6, space1);
Texture2D<uint> indices : register(t7, space1);`;
    const sidecar = shaderStageSlots(remapPinnedVariantRegisters(hlsl, false))
        .map(slot => `${slot.kind}${slot.index} ${slot.name}`).join("\n") + "\n";
    const output = resolve("artifacts/test-sdl-integer-textures");
    mkdirSync(output, { recursive: true });
    const source = `#include "pal_sdl_gpu_resources.hpp"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#define BBLITE_GPU_SHADER_DIR "shaders"
using namespace bbl::pal;
struct Texture { SDL_GPUTextureCreateInfo info; std::vector<std::uint8_t> bytes; };
static std::map<SDL_GPUTexture*, Texture> allocations;
static std::uintptr_t identity = 1;
static SDL_GPUShaderCreateInfo shader_info{};
static std::vector<SDL_GPUTexture*> sampled, loaded;
static bool last_fragment = false;
template<class T> T next_handle() { return reinterpret_cast<T>(identity++); }
SDL_GPUTexture* SDL_CreateGPUTexture(SDL_GPUDevice*, const SDL_GPUTextureCreateInfo* info) {
    const bool integer = info->format == SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT || info->format == SDL_GPU_TEXTUREFORMAT_R32_UINT;
    if (integer && (info->usage & SDL_GPU_TEXTUREUSAGE_SAMPLER)) return nullptr;
    auto texture = next_handle<SDL_GPUTexture*>(); allocations[texture].info = *info; return texture;
}
void SDL_ReleaseGPUTexture(SDL_GPUDevice*, SDL_GPUTexture* texture) { allocations.erase(texture); }
SDL_GPUSampler* SDL_CreateGPUSampler(SDL_GPUDevice*, const SDL_GPUSamplerCreateInfo*) { return next_handle<SDL_GPUSampler*>(); }
void SDL_ReleaseGPUSampler(SDL_GPUDevice*, SDL_GPUSampler*) {}
SDL_GPUShaderFormat SDL_GetGPUShaderFormats(SDL_GPUDevice*) { return SDL_GPU_SHADERFORMAT_DXIL; }
SDL_GPUShader* SDL_CreateGPUShader(SDL_GPUDevice*, const SDL_GPUShaderCreateInfo* info) { shader_info = *info; return next_handle<SDL_GPUShader*>(); }
void SDL_ReleaseGPUShader(SDL_GPUDevice*, SDL_GPUShader*) {}
void bind_sampled(bool fragment, Uint32 first, const SDL_GPUTextureSamplerBinding* bindings, Uint32 count) {
    assert(first == 0); sampled.clear(); last_fragment = fragment;
    for (Uint32 i = 0; i < count; ++i) { assert(bindings[i].sampler); assert(allocations.at(bindings[i].texture).info.usage & SDL_GPU_TEXTUREUSAGE_SAMPLER); sampled.push_back(bindings[i].texture); }
}
void bind_loaded(bool fragment, Uint32 first, SDL_GPUTexture* const* textures, Uint32 count) {
    assert(first == 0); loaded.clear(); last_fragment = fragment;
    for (Uint32 i = 0; i < count; ++i) { assert(allocations.at(textures[i]).info.usage == SDL_GPU_TEXTUREUSAGE_GRAPHICS_STORAGE_READ); loaded.push_back(textures[i]); }
}
void SDL_BindGPUVertexSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* bindings, Uint32 count) { bind_sampled(false, first, bindings, count); }
void SDL_BindGPUFragmentSamplers(SDL_GPURenderPass*, Uint32 first, const SDL_GPUTextureSamplerBinding* bindings, Uint32 count) { bind_sampled(true, first, bindings, count); }
void SDL_BindGPUVertexStorageTextures(SDL_GPURenderPass*, Uint32 first, SDL_GPUTexture* const* textures, Uint32 count) { bind_loaded(false, first, textures, count); }
void SDL_BindGPUFragmentStorageTextures(SDL_GPURenderPass*, Uint32 first, SDL_GPUTexture* const* textures, Uint32 count) { bind_loaded(true, first, textures, count); }
[[noreturn]] void gpu_error(const char* text) { throw std::runtime_error(text); }
std::string environment_variable(const char*) { return {}; }
std::string executable_directory() { return {}; }
std::string join_path(const std::string&, const std::string& name) { return name; }
std::vector<std::uint8_t> read_binary_file(const std::string&) { const std::string text = ${JSON.stringify(sidecar)}; return {text.begin(), text.end()}; }
void upload_2d_texture_into(SDL_GPUDevice*, SDL_GPUTexture* texture, const void* bytes, std::size_t size, std::uint32_t, std::uint32_t, const char*, bool) {
    auto data = static_cast<const std::uint8_t*>(bytes); allocations.at(texture).bytes.assign(data, data + size);
}
${cppRecord(shared, "struct PinnedStageSlots")}
${cppFunction(shared, "inline PinnedStageSlots read_pinned_stage_slots(")}
template<typename Resolve>
${cppFunction(shared, "inline std::vector<SDL_GPUTextureSamplerBinding> resolve_stage_textures(")}
template<typename Resolve>
${cppFunction(shared, "inline void bind_stage_textures(")}
${cppFunction(shared, "inline OwnedSdlShader load_shader(")}
${cppFunction(shared, "inline SDL_GPUTexture* upload_2d_texture(")}
struct ClusteredLightContainer { std::uint32_t data_texture_width = 8, light_rows = 2, slice_rows = 3, mask_rows = 4; };
${cppRecord(clustered, "struct ClusteredLightGpuResources")}
struct ClusteredLightGpu : ClusteredLightGpuResources { explicit ClusteredLightGpu(SDL_GPUDevice*) {} };
${cppFunction(clustered, "inline void create_clustered_textures(")}
${cppFunction(clustered, "inline void release_clustered_lights_resources([[maybe_unused]]")}
namespace upstream { constexpr std::size_t splat_sh_texture_count = 3; }
struct SplatRecord { std::array<std::vector<std::uint8_t>, 3> sh_textures; std::uint32_t texture_width = 1, texture_height = 1; };
struct SplatPass { std::array<SDL_GPUTextureSamplerBinding, 4> textures{}; std::array<SDL_GPUTexture*, 3> storage_textures{}; };
void upload_sh(SDL_GPUDevice* device, SplatRecord& record, SplatPass& pass) {
${cppSection(splat, "    if (record.sh_textures.size() != upstream::splat_sh_texture_count)", "    // Released once the GPU owns the bytes.")}
}
void bind_splat(SDL_GPURenderPass* render_pass, SplatPass& pass) {
${cppSection(splat, "    SDL_BindGPUVertexSamplers(", "    SDL_DrawGPUIndexedPrimitives(")}
}
int main() {
    auto device = next_handle<SDL_GPUDevice*>(); auto render_pass = next_handle<SDL_GPURenderPass*>();
    ClusteredLightContainer container; ClusteredLightGpu gpu{device}; create_clustered_textures(device, container, gpu);
    assert(allocations.at(gpu.lights).info.format == SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT);
    assert(allocations.at(gpu.cells).info.format == SDL_GPU_TEXTUREFORMAT_R32G32B32A32_UINT);
    assert(allocations.at(gpu.indices).info.format == SDL_GPU_TEXTUREFORMAT_R32_UINT);
    assert(allocations.at(gpu.cells).info.width == 8 && allocations.at(gpu.cells).info.height == 3);
    const auto slots = read_pinned_stage_slots("fixture");
    assert(slots.textures == std::vector<std::string>{"color"});
    assert((slots.storage_textures == std::vector<std::string>{"cells", "indices"}));
    assert(slots.storage == std::vector<std::string>{"morph"});
    auto shader = load_shader(device, "fixture", SDL_GPU_SHADERSTAGE_FRAGMENT, static_cast<Uint32>(slots.textures.size()), 0, "main", static_cast<Uint32>(slots.storage.size()), static_cast<Uint32>(slots.storage_textures.size()));
    assert(shader_info.num_samplers == 1 && shader_info.num_storage_textures == 2 && shader_info.num_storage_buffers == 1);
    for (bool fragment : {false, true}) {
        bind_stage_textures(render_pass, slots, fragment, "fixture", [&](const std::string& name, std::size_t) {
            if (name == "color") return SDL_GPUTextureSamplerBinding{gpu.lights, gpu.sampler};
            return SDL_GPUTextureSamplerBinding{name == "cells" ? gpu.cells : gpu.indices, nullptr};
        });
        assert(last_fragment == fragment && sampled == std::vector<SDL_GPUTexture*>{gpu.lights});
        assert((loaded == std::vector<SDL_GPUTexture*>{gpu.cells, gpu.indices}));
    }
    bool refused = false;
    try { bind_stage_textures(render_pass, slots, true, "fixture", [&](const std::string& name, std::size_t) { return SDL_GPUTextureSamplerBinding{name == "color" ? gpu.lights : nullptr, gpu.sampler}; }); }
    catch (const std::runtime_error& error) { refused = std::string(error.what()).find("storage texture 'cells'") != std::string::npos; }
    assert(refused);
    SplatRecord record; SplatPass pass;
    for (std::size_t i = 0; i < record.sh_textures.size(); ++i) { record.sh_textures[i] = {255, 255, 255, 255, 0, 0, 0, 128, static_cast<std::uint8_t>(i), 0, 0, 1, 127, 0, 0, 0}; }
    upload_sh(device, record, pass);
    for (std::size_t i = 0; i < record.sh_textures.size(); ++i) assert(allocations.at(pass.storage_textures[i]).bytes == record.sh_textures[i]);
    for (auto& binding : pass.textures) binding = {gpu.lights, gpu.sampler};
    bind_splat(render_pass, pass);
    assert(!last_fragment && sampled.size() == 4 && loaded == std::vector<SDL_GPUTexture*>(pass.storage_textures.begin(), pass.storage_textures.end()));
    for (auto texture : pass.storage_textures) SDL_ReleaseGPUTexture(device, texture);
    release_clustered_lights_resources(device, gpu);
    assert(allocations.empty());
}
`;
    const path = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(path, source);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", `/I${resolve("native/src")}`, `/I${sdlInclude}`, path, `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
