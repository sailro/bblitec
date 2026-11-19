// An effect task's pass on an SDL_GPU Direct3D 12 device, case by case: the
// target is filled stale, then the task's pass clears it and draws the
// fixture's fullscreen triangle through the backend's own
// `record_effect_task_pass` (lifted into `lifted.hpp` with what it calls), and
// the target is read back: `sdl <vertex.dxil> <fragment.dxil>`.

#include "check.hpp"

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include <exception>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <vector>

namespace bbl::pal {
/** The backend's effect pass, as far as its draw reads it. */
struct EffectPass {
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
};
using EffectRenderTextureSource = std::function<SDL_GPUTexture*(const RenderTextureRef&)>;
using EffectCsmTextureSource = std::function<SDL_GPUTextureSamplerBinding(ShadowGeneratorHandle)>;
/** The backend's `_record` half: the fixture's fullscreen triangle. */
inline void record_effect_pass(SDL_GPUCommandBuffer*, SDL_GPURenderPass* render_pass, const Engine&,
                               const EffectPass& pass, EffectWrapperHandle,
                               const EffectRenderTextureSource& = {},
                               const EffectCsmTextureSource& = {}) {
    SDL_BindGPUGraphicsPipeline(render_pass, pass.pipeline);
    SDL_DrawGPUPrimitives(render_pass, 3, 1, 0, 0);
}
} // namespace bbl::pal

#include "lifted.hpp"
#include "cases.hpp"

namespace {
using webgpu_fixture::require;

// A readback row of 64 RGBA8 pixels is the 256 bytes Direct3D 12 aligns rows to.
constexpr Uint32 row_pixels = 64;

SDL_GPUShader* shader(SDL_GPUDevice* device, const std::filesystem::path& path,
                      SDL_GPUShaderStage stage) {
    std::ifstream file(path, std::ios::binary);
    require(static_cast<bool>(file), "shader " + path.string());
    const std::vector<unsigned char> bytes{std::istreambuf_iterator<char>(file),
                                           std::istreambuf_iterator<char>()};
    SDL_GPUShaderCreateInfo info{};
    info.code = bytes.data();
    info.code_size = bytes.size();
    info.entrypoint = "main";
    info.format = SDL_GPU_SHADERFORMAT_DXIL;
    info.stage = stage;
    SDL_GPUShader* result = SDL_CreateGPUShader(device, &info);
    require(result != nullptr, "SDL_CreateGPUShader");
    return result;
}

void clear_pass(SDL_GPUCommandBuffer* command, SDL_GPUTexture* image,
                const std::uint8_t (&colour)[4]) {
    SDL_GPUColorTargetInfo target{};
    target.texture = image;
    target.load_op = SDL_GPU_LOADOP_CLEAR;
    target.store_op = SDL_GPU_STOREOP_STORE;
    target.clear_color =
        SDL_FColor{colour[0] / 255.0f, colour[1] / 255.0f, colour[2] / 255.0f, colour[3] / 255.0f};
    SDL_GPURenderPass* pass = SDL_BeginGPURenderPass(command, &target, 1, nullptr);
    require(pass != nullptr, "SDL_BeginGPURenderPass");
    SDL_EndGPURenderPass(pass);
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 3 && target_width <= row_pixels,
                "usage: sdl <vertex.dxil> <fragment.dxil>");
        require(SDL_Init(SDL_INIT_VIDEO), "SDL_Init");
        SDL_GPUDevice* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, true, "direct3d12");
        require(device != nullptr, "SDL_CreateGPUDevice");
        SDL_GPUShader* vertex = shader(device, argv[1], SDL_GPU_SHADERSTAGE_VERTEX);
        SDL_GPUShader* fragment = shader(device, argv[2], SDL_GPU_SHADERSTAGE_FRAGMENT);
        SDL_GPUColorTargetDescription colour{};
        colour.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex;
        pipeline_info.fragment_shader = fragment;
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.target_info.color_target_descriptions = &colour;
        pipeline_info.target_info.num_color_targets = 1;
        const bbl::pal::EffectPass pass{SDL_CreateGPUGraphicsPipeline(device, &pipeline_info)};
        require(pass.pipeline != nullptr, "SDL_CreateGPUGraphicsPipeline");
        SDL_GPUTextureCreateInfo texture_info{};
        texture_info.type = SDL_GPU_TEXTURETYPE_2D;
        texture_info.format = colour.format;
        texture_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
        texture_info.width = target_width;
        texture_info.height = target_height;
        texture_info.layer_count_or_depth = 1;
        texture_info.num_levels = 1;
        SDL_GPUTexture* image = SDL_CreateGPUTexture(device, &texture_info);
        require(image != nullptr, "SDL_CreateGPUTexture");
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
        transfer_info.size = row_pixels * 4 * target_height;
        SDL_GPUTransferBuffer* readback = SDL_CreateGPUTransferBuffer(device, &transfer_info);
        require(readback != nullptr, "SDL_CreateGPUTransferBuffer");
        bbl::Engine engine;
        for (std::size_t index = 0; index < std::size(cases); ++index) {
            const bbl::FrameTaskRecord task = effect_task_scissor::task_of(cases[index]);
            SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
            require(command != nullptr, "SDL_AcquireGPUCommandBuffer");
            clear_pass(command, image, effect_task_scissor::stale);
            // The task's pass as the frame graph opens it, then its draw.
            SDL_GPUColorTargetInfo target{};
            target.texture = image;
            target.load_op = SDL_GPU_LOADOP_CLEAR;
            target.store_op = SDL_GPU_STOREOP_STORE;
            target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 1.0f};
            SDL_GPURenderPass* render_pass = SDL_BeginGPURenderPass(command, &target, 1, nullptr);
            require(render_pass != nullptr, "SDL_BeginGPURenderPass");
            bbl::pal::record_effect_task_pass(command, render_pass, engine, pass, task,
                                              target_width, target_height, {});
            SDL_EndGPURenderPass(render_pass);
            SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
            SDL_GPUTextureRegion region{};
            region.texture = image;
            region.w = target_width;
            region.h = target_height;
            region.d = 1;
            SDL_GPUTextureTransferInfo destination{};
            destination.transfer_buffer = readback;
            destination.pixels_per_row = row_pixels;
            destination.rows_per_layer = target_height;
            SDL_DownloadFromGPUTexture(copy, &region, &destination);
            SDL_EndGPUCopyPass(copy);
            SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
            require(fence != nullptr && SDL_WaitForGPUFences(device, true, &fence, 1),
                    "SDL_WaitForGPUFences");
            SDL_ReleaseGPUFence(device, fence);
            const auto* rgba =
                static_cast<const std::uint8_t*>(SDL_MapGPUTransferBuffer(device, readback, false));
            require(rgba != nullptr, "SDL_MapGPUTransferBuffer");
            effect_task_scissor::print_case(index, rgba, row_pixels * 4, target_width,
                                            target_height);
            SDL_UnmapGPUTransferBuffer(device, readback);
        }
        SDL_ReleaseGPUTransferBuffer(device, readback);
        SDL_ReleaseGPUTexture(device, image);
        SDL_ReleaseGPUGraphicsPipeline(device, pass.pipeline);
        SDL_ReleaseGPUShader(device, vertex);
        SDL_ReleaseGPUShader(device, fragment);
        SDL_DestroyGPUDevice(device);
        SDL_Quit();
        std::printf("sdl ok\n");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s: %s\n", error.what(), SDL_GetError());
        return 1;
    }
}
