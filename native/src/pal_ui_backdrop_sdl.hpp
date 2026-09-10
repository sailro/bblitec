#pragma once
#include "pal_ui_backdrop.hpp"

#include <bblite/pal_ui.hpp>
#include <SDL3/SDL_gpu.h>
#include <array>
#include <stdexcept>
#include <vector>

namespace bbl::pal {

struct UiBackdropSdlResources {
    struct Pair {
        SDL_GPUTexture* snapshot = nullptr;
        SDL_GPUTexture* first = nullptr;
        SDL_GPUTexture* second = nullptr;
        std::uint32_t source_width = 0, source_height = 0;
        std::uint32_t blur_width = 0, blur_height = 0;
    };
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    std::vector<Pair> pairs;

    void release(SDL_GPUDevice* device) {
        for (auto& pair : pairs) {
            if (pair.snapshot) SDL_ReleaseGPUTexture(device, pair.snapshot);
            if (pair.first) SDL_ReleaseGPUTexture(device, pair.first);
            if (pair.second) SDL_ReleaseGPUTexture(device, pair.second);
        }
        if (pipeline) SDL_ReleaseGPUGraphicsPipeline(device, pipeline);
        *this = {};
    }
};

inline void render_ui_backdrop_sdl(
    SDL_GPUDevice* device, SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* target, SDL_GPUTextureFormat target_format,
    SDL_GPUBuffer* vertices, SDL_GPUBuffer* indices, SDL_GPUSampler* sampler,
    SDL_GPUGraphicsPipeline* composite_pipeline, UiBackdropSdlResources& resources,
    const UiRenderFrame& frame, std::size_t backdrop_index) {
    const auto& backdrop = frame.backdrops[backdrop_index];
    if (resources.pairs.size() <= backdrop_index) resources.pairs.resize(backdrop_index + 1);
    auto& pair = resources.pairs[backdrop_index];
    sync_ui_backdrop_targets(pair, backdrop, pair.snapshot != nullptr, pair.first != nullptr,
        [&](std::uint32_t width, std::uint32_t height) {
            if (pair.snapshot) SDL_ReleaseGPUTexture(device, pair.snapshot);
            pair.snapshot = create_frame_texture(device, target_format, SDL_GPU_SAMPLECOUNT_1, width, height,
                SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
        },
        [&](std::uint32_t width, std::uint32_t height) {
            if (pair.first) SDL_ReleaseGPUTexture(device, pair.first);
            if (pair.second) SDL_ReleaseGPUTexture(device, pair.second);
            pair.first = create_frame_texture(device, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, SDL_GPU_SAMPLECOUNT_1,
                width, height, SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
            pair.second = create_frame_texture(device, SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT, SDL_GPU_SAMPLECOUNT_1,
                width, height, SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
        });
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    const SDL_GPUTextureLocation source{
        target, 0, 0,
        static_cast<Uint32>(backdrop.left),
        static_cast<Uint32>(backdrop.top),
        0};
    const SDL_GPUTextureLocation destination{pair.snapshot, 0, 0, 0, 0, 0};
    SDL_CopyGPUTextureToTexture(
        copy, &source, &destination,
        backdrop.width, backdrop.height, 1, false);
    copy.end();

    const std::array<float, 16> projection{
        2.0f / frame.width, 0, 0, 0, 0, -2.0f / frame.height, 0, 0,
        0, 0, 0.0001f, 0, -1, 1, 0, 1};
    const std::array<float, 2> translation{0, 0};
    SDL_PushGPUVertexUniformData(command, 0, projection.data(), sizeof(projection));
    SDL_PushGPUVertexUniformData(command, 1, translation.data(), sizeof(translation));
    const SDL_GPUBufferBinding vertex_binding{vertices, 0}, index_binding{indices, 0};
    const auto draw = [&](SDL_GPUTexture* output, SDL_GPUTexture* input,
                          std::uint32_t first, std::uint32_t count, bool composite) {
        SDL_GPUColorTargetInfo attachment{};
        attachment.texture = output;
        attachment.load_op = composite ? SDL_GPU_LOADOP_LOAD : SDL_GPU_LOADOP_CLEAR;
        attachment.store_op = SDL_GPU_STOREOP_STORE;
        attachment.clear_color = {0, 0, 0, 0};
        SdlRenderPass pass{SDL_BeginGPURenderPass(command, &attachment, 1, nullptr)};
        if (!pass) throw std::runtime_error(SDL_GetError());
        SDL_BindGPUGraphicsPipeline(pass, composite ? composite_pipeline : resources.pipeline);
        SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
        SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
        const SDL_GPUTextureSamplerBinding texture_binding{input, sampler};
        SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
        SDL_DrawGPUIndexedPrimitives(pass, count, 1, first, 0, 0);
        pass.end();
    };
    const std::array<SDL_GPUTexture*, 4> textures{target, pair.snapshot, pair.first, pair.second};
    for (const auto& pass : ui_backdrop_draw_plan(backdrop)) {
        draw(textures[static_cast<std::size_t>(pass.output)], textures[static_cast<std::size_t>(pass.input)],
            pass.first, pass.count, pass.output == UiBackdropSurface::target);
    }
}

} // namespace bbl::pal
