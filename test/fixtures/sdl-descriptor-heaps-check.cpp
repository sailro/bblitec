#include <SDL3/SDL.h>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <vector>

constexpr Uint32 operations = 1100;
static std::vector<unsigned char> shader_bytes(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    assert(file);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
static SDL_GPUTexture* texture(SDL_GPUDevice* device, SDL_GPUTextureFormat format, SDL_GPUTextureUsageFlags usage, Uint32 width) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D; info.format = format; info.usage = usage;
    info.width = width; info.height = 1; info.layer_count_or_depth = 1; info.num_levels = 1;
    auto* result = SDL_CreateGPUTexture(device, &info);
    assert(result); return result;
}
static SDL_GPUShader* shader(SDL_GPUDevice* device, const std::filesystem::path& path, SDL_GPUShaderStage stage, Uint32 samplers) {
    const auto bytes = shader_bytes(path);
    SDL_GPUShaderCreateInfo info{};
    info.code = bytes.data(); info.code_size = bytes.size(); info.entrypoint = "main";
    info.format = SDL_GPU_SHADERFORMAT_DXIL; info.stage = stage; info.num_samplers = samplers;
    auto* result = SDL_CreateGPUShader(device, &info);
    assert(result); return result;
}
static SDL_GPUTransferBuffer* readback(SDL_GPUDevice* device, Uint32 bytes) {
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD; info.size = bytes;
    auto* result = SDL_CreateGPUTransferBuffer(device, &info);
    assert(result); return result;
}
static void wait(SDL_GPUDevice* device, SDL_GPUCommandBuffer* command) {
    auto* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    assert(fence && SDL_WaitForGPUFences(device, true, &fence, 1));
    SDL_ReleaseGPUFence(device, fence);
}
static void download_texture(SDL_GPUCopyPass* copy, SDL_GPUTexture* image, SDL_GPUTransferBuffer* target, Uint32 width, Uint32 stride) {
    SDL_GPUTextureRegion region{};
    region.texture = image; region.w = width; region.h = 1; region.d = 1;
    SDL_GPUTextureTransferInfo destination{};
    destination.transfer_buffer = target; destination.pixels_per_row = stride; destination.rows_per_layer = 1;
    SDL_DownloadFromGPUTexture(copy, &region, &destination);
}
int main(int argc, char** argv) {
    assert(argc == 3 && SDL_Init(SDL_INIT_VIDEO));
    const std::filesystem::path directory = argv[1];
    auto* device = SDL_CreateGPUDevice(SDL_GPU_SHADERFORMAT_DXIL, true, "direct3d12");
    assert(device);
    std::array<SDL_GPUTexture*, 3> inputs{};
    auto* command = SDL_AcquireGPUCommandBuffer(device);
    assert(command);
    for (Uint32 i = 0; i < inputs.size(); ++i) {
        inputs[i] = texture(device, SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
            SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_READ, 1);
        SDL_GPUColorTargetInfo target{};
        target.texture = inputs[i]; target.load_op = SDL_GPU_LOADOP_CLEAR; target.store_op = SDL_GPU_STOREOP_STORE;
        target.clear_color = {i == 0 ? 1.0f : 0.0f, i == 1 ? 1.0f : 0.0f, i == 2 ? 1.0f : 0.0f, 1};
        auto* pass = SDL_BeginGPURenderPass(command, &target, 1, nullptr);
        assert(pass); SDL_EndGPURenderPass(pass);
    }
    wait(device, command);
    SDL_GPUSamplerCreateInfo sampler_info{};
    auto* sampler = SDL_CreateGPUSampler(device, &sampler_info);
    assert(sampler);
    command = SDL_AcquireGPUCommandBuffer(device);
    assert(command);
    const std::string_view phase = argv[2];
    std::vector<std::function<void()>> checks;
    for (int stage = 0; stage < (phase == "mixed" ? 3 : 1); ++stage) {
    if (phase != "compute" && (phase != "mixed" || stage != 1)) {
        auto* vertex = shader(device, directory / "vertex.dxil", SDL_GPU_SHADERSTAGE_VERTEX, 1);
        auto* fragment = shader(device, directory / "fragment.dxil", SDL_GPU_SHADERSTAGE_FRAGMENT, 2);
        SDL_GPUColorTargetDescription color{};
        color.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        SDL_GPUGraphicsPipelineCreateInfo info{};
        info.vertex_shader = vertex; info.fragment_shader = fragment;
        info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        info.target_info.color_target_descriptions = &color; info.target_info.num_color_targets = 1;
        auto* pipeline = SDL_CreateGPUGraphicsPipeline(device, &info);
        assert(pipeline);
        auto* image = texture(device, color.format, SDL_GPU_TEXTUREUSAGE_COLOR_TARGET, 1);
        SDL_GPUColorTargetInfo target{};
        target.texture = image; target.load_op = SDL_GPU_LOADOP_CLEAR; target.store_op = SDL_GPU_STOREOP_STORE;
        auto* pass = SDL_BeginGPURenderPass(command, &target, 1, nullptr);
        assert(pass);
        SDL_BindGPUGraphicsPipeline(pass, pipeline);
        // This vertex table is unchanged while the fragment table exhausts the heap.
        const SDL_GPUTextureSamplerBinding vertex_binding{inputs[0], sampler};
        SDL_BindGPUVertexSamplers(pass, 0, &vertex_binding, 1);
        for (Uint32 i = 0; i < operations; ++i) {
            // One extra vertex-table write reaches the exact heap boundary;
            // the ordinary arm instead leaves one slot before a two-slot table.
            const bool exact = phase == "graphics-exact" && i >= 1000;
            if (exact && i == 1000) {
                const SDL_GPUTextureSamplerBinding binding{inputs[1], sampler};
                SDL_BindGPUVertexSamplers(pass, 0, &binding, 1);
            }
            const std::array<SDL_GPUTexture*, 2> colors{inputs[exact ? 0 : 1], inputs[2]};
            const std::array<SDL_GPUTextureSamplerBinding, 2> fragment_bindings{{
                {colors[i % 2], sampler}, {colors[1 - i % 2], sampler}}};
            SDL_BindGPUFragmentSamplers(pass, 0, fragment_bindings.data(), 2);
            SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        }
        SDL_EndGPURenderPass(pass);
        auto* result = readback(device, 256);
        auto* copy = SDL_BeginGPUCopyPass(command);
        assert(copy); download_texture(copy, image, result, 1, 64); SDL_EndGPUCopyPass(copy);
        checks.push_back([=] {
        const auto* rgba = static_cast<const unsigned char*>(SDL_MapGPUTransferBuffer(device, result, false));
        assert(rgba && rgba[0] == 85 && rgba[1] == 85 && rgba[2] == 85 && rgba[3] == 255);
        SDL_UnmapGPUTransferBuffer(device, result);
        SDL_ReleaseGPUTransferBuffer(device, result); SDL_ReleaseGPUTexture(device, image);
        SDL_ReleaseGPUGraphicsPipeline(device, pipeline); SDL_ReleaseGPUShader(device, vertex); SDL_ReleaseGPUShader(device, fragment);
        });
    } else {
        const auto bytes = shader_bytes(directory / "compute.dxil");
        SDL_GPUComputePipelineCreateInfo info{};
        info.code = bytes.data(); info.code_size = bytes.size(); info.entrypoint = "main";
        info.format = SDL_GPU_SHADERFORMAT_DXIL; info.num_samplers = 3;
        info.num_readonly_storage_textures = 1;
        info.num_readwrite_storage_textures = 1; info.num_readwrite_storage_buffers = 1; info.num_uniform_buffers = 1;
        info.threadcount_x = 1; info.threadcount_y = 1; info.threadcount_z = 1;
        auto* pipeline = SDL_CreateGPUComputePipeline(device, &info);
        assert(pipeline);
        auto* image = texture(device, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT, SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_WRITE, operations);
        auto* unused_image = texture(device, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT, SDL_GPU_TEXTUREUSAGE_COMPUTE_STORAGE_WRITE, 1);
        SDL_GPUBufferCreateInfo buffer_info{};
        buffer_info.usage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE; buffer_info.size = operations * 16;
        auto* buffer = SDL_CreateGPUBuffer(device, &buffer_info);
        buffer_info.size = 16;
        auto* unused_buffer = SDL_CreateGPUBuffer(device, &buffer_info);
        assert(buffer && unused_buffer);
        // The pass exposes more UAVs than this pipeline declares.
        std::array<SDL_GPUStorageTextureReadWriteBinding, 2> image_bindings{};
        image_bindings[0].texture = image; image_bindings[1].texture = unused_image;
        std::array<SDL_GPUStorageBufferReadWriteBinding, 2> buffer_bindings{};
        buffer_bindings[0].buffer = buffer; buffer_bindings[1].buffer = unused_buffer;
        auto* pass = SDL_BeginGPUComputePass(command, image_bindings.data(), 2, buffer_bindings.data(), 2);
        assert(pass);
        SDL_BindGPUComputePipeline(pass, pipeline);
        SDL_BindGPUComputeStorageTextures(pass, 0, inputs.data(), 1);
        // UAV tables remain unchanged across all sampler heap rollovers.
        for (Uint32 i = 0; i < operations; ++i) {
            const std::array<SDL_GPUTextureSamplerBinding, 3> bindings{{
                {inputs[i % 3], sampler}, {inputs[(i + 1) % 3], sampler}, {inputs[(i + 2) % 3], sampler}}};
            SDL_BindGPUComputeSamplers(pass, 0, bindings.data(), 3);
            const std::array<Uint32, 4> uniform{i, 0, 0, 0};
            SDL_PushGPUComputeUniformData(command, 0, uniform.data(), sizeof(uniform));
            SDL_DispatchGPUCompute(pass, 1, 1, 1);
        }
        SDL_EndGPUComputePass(pass);
        auto* image_result = readback(device, 1104 * 16);
        auto* buffer_result = readback(device, operations * 16);
        auto* copy = SDL_BeginGPUCopyPass(command);
        assert(copy); download_texture(copy, image, image_result, operations, 1104);
        const SDL_GPUBufferRegion region{buffer, 0, operations * 16};
        const SDL_GPUTransferBufferLocation destination{buffer_result, 0};
        SDL_DownloadFromGPUBuffer(copy, &region, &destination); SDL_EndGPUCopyPass(copy);
        checks.push_back([=] {
        for (auto* result : {image_result, buffer_result}) {
            const auto* values = static_cast<const float*>(SDL_MapGPUTransferBuffer(device, result, false));
            assert(values);
            for (Uint32 i = 0; i < operations * 4; ++i) {
                const float expected = i % 4 == 3 ? 1.0f : i % 4 == 0 ? 2.0f / 3.0f : 1.0f / 6.0f;
                assert(std::abs(values[i] - expected) < 1e-6f);
            }
            SDL_UnmapGPUTransferBuffer(device, result); SDL_ReleaseGPUTransferBuffer(device, result);
        }
        SDL_ReleaseGPUTexture(device, image); SDL_ReleaseGPUBuffer(device, buffer); SDL_ReleaseGPUComputePipeline(device, pipeline);
        SDL_ReleaseGPUTexture(device, unused_image); SDL_ReleaseGPUBuffer(device, unused_buffer);
        });
    }
    }
    wait(device, command);
    for (const auto& check : checks) check();
    SDL_ReleaseGPUSampler(device, sampler);
    for (auto* input : inputs) SDL_ReleaseGPUTexture(device, input);
    SDL_DestroyGPUDevice(device); SDL_Quit();
    std::printf("%s: 1100 operations preserved descriptor bindings\n", argv[2]);
}
