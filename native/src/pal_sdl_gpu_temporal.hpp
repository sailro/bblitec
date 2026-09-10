#pragma once

#include <bblite/runtime.hpp>
#include <SDL3/SDL_gpu.h>
#include "pal_sdl_gpu_commands.hpp"

#include <array>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

/** Ordinary blocks are snapshots; the source scene block is queue-owned. */
struct PreparedSdlUniform {
    std::vector<std::uint8_t> snapshot{};
    std::shared_ptr<PersistentSceneUniforms> source{};

    [[nodiscard]] const void* data() const noexcept {
        return source ? static_cast<const void*>(source->drawn.data()) : snapshot.data();
    }
    [[nodiscard]] std::size_t size() const noexcept {
        return source ? source->drawn.size() * sizeof(float) : snapshot.size();
    }
};

/** Resolve and validate every block before any later logical hook runs. */
template<class Resolve>
std::vector<PreparedSdlUniform> prepare_sdl_uniforms(
    const std::vector<std::string>& names, Resolve&& resolve,
    const std::shared_ptr<PersistentSceneUniforms>& source) {
    std::vector<PreparedSdlUniform> prepared;
    prepared.reserve(names.size());
    for (std::size_t slot = 0; slot < names.size(); ++slot) {
        const auto block = resolve(names[slot], slot);
        if (!block.data) throw std::runtime_error("Temporal draw declares an unmapped uniform block '" + names[slot] + "'.");
        PreparedSdlUniform uniform;
        if (names[slot] == "scene") {
            if (!source || source->drawn.size() * sizeof(float) != block.bytes) {
                throw std::runtime_error("Temporal draw scene block does not match its retained source UBO.");
            }
            uniform.source = source;
        } else {
            uniform.snapshot.resize(block.bytes);
            std::memcpy(uniform.snapshot.data(), block.data, block.bytes);
        }
        prepared.push_back(std::move(uniform));
    }
    return prepared;
}

/** All resource lookups and numeric writers finished before this packet exists. */
struct PreparedSdlDraw {
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    std::vector<PreparedSdlUniform> vertex_uniforms{}, fragment_uniforms{};
    std::vector<SDL_GPUTextureSamplerBinding> vertex_textures{}, fragment_textures{};
    std::vector<SDL_GPUBuffer*> vertex_storage{}, fragment_storage{};
    std::vector<SDL_GPUBufferBinding> vertex_buffers{};
    SDL_GPUBufferBinding indices{};
    Uint32 index_count = 0;
    Uint32 instance_count = 1;
};

struct PreparedSdlScenePass {
    SDL_GPUColorTargetInfo target{};
    std::optional<SDL_GPUDepthStencilTargetInfo> depth{};
    std::optional<SDL_GPUViewport> viewport{};
    std::optional<SDL_Rect> scissor{};
    std::vector<PreparedSdlDraw> draws{};
};

inline void encode_sdl_prepared_draw(
    SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass, const PreparedSdlDraw& draw) {
    SDL_BindGPUGraphicsPipeline(pass, draw.pipeline);
    for (std::size_t slot = 0; slot < draw.vertex_uniforms.size(); ++slot) {
        const auto& block = draw.vertex_uniforms[slot];
        SDL_PushGPUVertexUniformData(command, static_cast<Uint32>(slot), block.data(), static_cast<Uint32>(block.size()));
    }
    for (std::size_t slot = 0; slot < draw.fragment_uniforms.size(); ++slot) {
        const auto& block = draw.fragment_uniforms[slot];
        SDL_PushGPUFragmentUniformData(command, static_cast<Uint32>(slot), block.data(), static_cast<Uint32>(block.size()));
    }
    if (!draw.vertex_textures.empty()) SDL_BindGPUVertexSamplers(pass, 0, draw.vertex_textures.data(), static_cast<Uint32>(draw.vertex_textures.size()));
    if (!draw.fragment_textures.empty()) SDL_BindGPUFragmentSamplers(pass, 0, draw.fragment_textures.data(), static_cast<Uint32>(draw.fragment_textures.size()));
    if (!draw.vertex_storage.empty()) SDL_BindGPUVertexStorageBuffers(pass, 0, draw.vertex_storage.data(), static_cast<Uint32>(draw.vertex_storage.size()));
    if (!draw.fragment_storage.empty()) SDL_BindGPUFragmentStorageBuffers(pass, 0, draw.fragment_storage.data(), static_cast<Uint32>(draw.fragment_storage.size()));
    SDL_BindGPUVertexBuffers(pass, 0, draw.vertex_buffers.data(), static_cast<Uint32>(draw.vertex_buffers.size()));
    SDL_BindGPUIndexBuffer(pass, &draw.indices, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    SDL_DrawGPUIndexedPrimitives(pass, draw.index_count, draw.instance_count, 0, 0, 0);
}

inline void encode_sdl_prepared_scene(SDL_GPUCommandBuffer* command, const PreparedSdlScenePass& scene) {
    SdlRenderPass pass{SDL_BeginGPURenderPass(command, &scene.target, 1, scene.depth ? &*scene.depth : nullptr)};
    if (scene.viewport) SDL_SetGPUViewport(pass, &*scene.viewport);
    if (scene.scissor) SDL_SetGPUScissor(pass, &*scene.scissor);
    for (const auto& draw : scene.draws) encode_sdl_prepared_draw(command, pass, draw);
    pass.end();
}

} // namespace bbl::pal
