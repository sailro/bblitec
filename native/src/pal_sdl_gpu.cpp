#include <bblite/pal.hpp>
#include <bblite/pal_gltf.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <bblite/upstream/camera_math.hpp>
#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
#include <bblite/upstream/renderer_plan.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include <SDL3_image/SDL_image.h>
#endif

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "."
#endif

namespace bbl::pal {

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
namespace {

struct GpuVertex {
    float position[3];
    float normal[3];
    float tangent[4];
    float uv[2];
};

struct GpuMesh {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* base_color = nullptr;
    SDL_GPUTexture* metallic_roughness = nullptr;
    SDL_GPUTexture* normal = nullptr;
    SDL_GPUTexture* emissive = nullptr;
    std::uint32_t index_count = 0;
};

struct GpuBackground {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* texture = nullptr;
    bool enabled = false;
};

struct GpuSkybox {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* texture = nullptr;
    bool enabled = false;
};

struct IdUniforms {
    float id_color[4];
    float alpha_options[4];
};

struct GpuState {
    SDL_Window* window = nullptr;
    SDL_GPUDevice* device = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUGraphicsPipeline* double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* background_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* skybox_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_double_sided_pipeline = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* background_sampler = nullptr;
    SDL_GPUTexture* environment = nullptr;
    SDL_GPUTexture* brdf_lut = nullptr;
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::vector<GpuMesh> meshes;
    GpuBackground background;
    GpuSkybox skybox;
};

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

[[noreturn]] void gpu_error(const char* operation) {
    throw std::runtime_error(std::string(operation) + ": " + SDL_GetError());
}

void handle_camera_pointer_event(
    const SDL_Event& event,
    CameraRecord& camera,
    CameraPointerState& state) {
    if (!camera.controls_enabled) return;
    if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        const bool pressed = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
        if (event.button.button == SDL_BUTTON_LEFT) {
            state.orbiting = pressed;
        } else if (event.button.button == SDL_BUTTON_RIGHT || event.button.button == SDL_BUTTON_MIDDLE) {
            state.panning = pressed;
        }
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        if (state.orbiting) {
            camera.inertial_alpha_offset -= event.motion.xrel / camera.angular_sensibility;
            camera.inertial_beta_offset -= event.motion.yrel / camera.angular_sensibility;
        }
        if (state.panning) {
            camera.inertial_panning_x -= event.motion.xrel / camera.panning_sensibility;
            camera.inertial_panning_y += event.motion.yrel / camera.panning_sensibility;
        }
        return;
    }
    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        float delta = event.wheel.y;
        if (event.wheel.direction == SDL_MOUSEWHEEL_FLIPPED) delta = -delta;
        camera.inertial_radius_offset -=
            (delta * camera.radius) / std::max(camera.wheel_precision * 10.0f, 1.0f);
    }
}

void update_camera(CameraRecord& camera) {
    if (!camera.controls_enabled) return;
    upstream::apply_arc_rotate_inertia(camera);
    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    const auto pressed = [keys, key_count](SDL_Scancode scancode) {
        const int index = static_cast<int>(scancode);
        return index >= 0 && index < key_count && keys[index];
    };
    if (pressed(SDL_SCANCODE_LEFT)) camera.alpha -= 0.02f;
    if (pressed(SDL_SCANCODE_RIGHT)) camera.alpha += 0.02f;
    if (pressed(SDL_SCANCODE_UP)) camera.beta = std::max(0.1f, camera.beta - 0.02f);
    if (pressed(SDL_SCANCODE_DOWN)) camera.beta = std::min(pi - 0.1f, camera.beta + 0.02f);
    if (pressed(SDL_SCANCODE_W)) camera.radius = std::max(0.25f, camera.radius - 0.08f);
    if (pressed(SDL_SCANCODE_S)) camera.radius += 0.08f;
}

void save_texture_png(
    SDL_GPUDevice* device,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* swapchain,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height,
    const std::string& path) {
    const std::uint32_t row_bytes = width * 4;
    const std::uint32_t aligned_row_bytes = (row_bytes + 255u) & ~255u;
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer_info.size = aligned_row_bytes * height;
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer screenshot");

    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureRegion source{
        swapchain, 0, 0, 0, 0, 0, width, height, 1};
    const SDL_GPUTextureTransferInfo destination{
        transfer, 0, aligned_row_bytes / 4, height};
    SDL_DownloadFromGPUTexture(copy, &source, &destination);
    SDL_EndGPUCopyPass(copy);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    if (!fence) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_SubmitGPUCommandBufferAndAcquireFence");
    }
    if (!SDL_WaitForGPUFences(device, true, &fence, 1)) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_WaitForGPUFences");
    }

    const auto* mapped = static_cast<const std::uint8_t*>(
        SDL_MapGPUTransferBuffer(device, transfer, false));
    if (!mapped) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_MapGPUTransferBuffer screenshot");
    }
    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(row_bytes) * height);
    const bool bgra =
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB;
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row = mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row = rgba.data() + static_cast<std::size_t>(y) * row_bytes;
        std::memcpy(destination_row, source_row, row_bytes);
        if (bgra) {
            for (std::uint32_t x = 0; x < width; ++x) {
                std::swap(destination_row[x * 4], destination_row[x * 4 + 2]);
            }
        }
    }
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SDL_Surface* surface = SDL_CreateSurfaceFrom(
        static_cast<int>(width),
        static_cast<int>(height),
        SDL_PIXELFORMAT_RGBA32,
        rgba.data(),
        static_cast<int>(row_bytes));
    if (!surface) {
        SDL_ReleaseGPUFence(device, fence);
        SDL_ReleaseGPUTransferBuffer(device, transfer);
        gpu_error("SDL_CreateSurfaceFrom screenshot");
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    SDL_ReleaseGPUFence(device, fence);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    if (!saved) gpu_error("IMG_SavePNG screenshot");
}

SDL_GPUShader* load_shader(
    SDL_GPUDevice* device,
    const char* base_name,
    SDL_GPUShaderStage stage,
    std::uint32_t samplers,
    std::uint32_t uniform_buffers) {
    const SDL_GPUShaderFormat supported = SDL_GetGPUShaderFormats(device);
    SDL_GPUShaderFormat format = SDL_GPU_SHADERFORMAT_INVALID;
    const char* extension = nullptr;
    const char* entrypoint = nullptr;
    if (supported & SDL_GPU_SHADERFORMAT_DXIL) {
        format = SDL_GPU_SHADERFORMAT_DXIL;
        extension = ".dxil";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_SPIRV) {
        format = SDL_GPU_SHADERFORMAT_SPIRV;
        extension = ".spv";
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        format = SDL_GPU_SHADERFORMAT_MSL;
        extension = ".msl";
        entrypoint = "main0";
    } else {
        throw std::runtime_error("SDL_GPU backend has no supported bblitec shader format.");
    }
    const std::vector<std::uint8_t> code =
        read_binary_file(join_path(BBLITE_GPU_SHADER_DIR, std::string(base_name) + extension));
    SDL_GPUShaderCreateInfo info{};
    info.code_size = code.size();
    info.code = code.data();
    info.entrypoint = entrypoint;
    info.format = format;
    info.stage = stage;
    info.num_samplers = samplers;
    info.num_uniform_buffers = uniform_buffers;
    SDL_GPUShader* shader = SDL_CreateGPUShader(device, &info);
    if (!shader) gpu_error("SDL_CreateGPUShader");
    return shader;
}

SDL_GPUBuffer* upload_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBufferUsageFlags usage,
    const void* data,
    std::size_t size) {
    SDL_GPUBufferCreateInfo buffer_info{};
    buffer_info.usage = usage;
    buffer_info.size = static_cast<Uint32>(size);
    SDL_GPUBuffer* buffer = SDL_CreateGPUBuffer(device, &buffer_info);
    if (!buffer) gpu_error("SDL_CreateGPUBuffer");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTransferBufferLocation source{transfer, 0};
    SDL_GPUBufferRegion destination{buffer, 0, static_cast<Uint32>(size)};
    SDL_UploadToGPUBuffer(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return buffer;
}

SDL_GPUTexture* upload_texture(
    SDL_GPUDevice* device,
    const TextureData& texture_data,
    bool srgb,
    std::array<std::uint8_t, 4> fallback) {
    DecodedImage image;
    if (texture_data.bytes.empty()) {
        image.width = image.height = 1;
        image.rgba.assign(fallback.begin(), fallback.end());
    } else {
        image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = srgb
        ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB
        : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = image.width;
    texture_info.height = image.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture");

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(image.rgba.size());
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, image.rgba.data(), image.rgba.size());
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    SDL_GPUTextureTransferInfo source{transfer, 0, static_cast<Uint32>(image.width), static_cast<Uint32>(image.height)};
    SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        static_cast<Uint32>(image.width), static_cast<Uint32>(image.height), 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

std::vector<float> decode_rgbd(const TextureData& texture_data, int& width, int& height) {
    if (texture_data.bytes.empty()) {
        width = height = 1;
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    const DecodedImage image = decode_image(ts::ArrayBuffer(texture_data.bytes));
    width = image.width;
    height = image.height;
    std::vector<float> result(static_cast<std::size_t>(width) * height * 4);
    for (std::size_t index = 0; index < image.rgba.size(); index += 4) {
        const float alpha = std::max(static_cast<float>(image.rgba[index + 3]) / 255.0f, 1.0f / 255.0f);
        result[index] = std::pow(static_cast<float>(image.rgba[index]) / 255.0f, 2.2f) / alpha;
        result[index + 1] = std::pow(static_cast<float>(image.rgba[index + 1]) / 255.0f, 2.2f) / alpha;
        result[index + 2] = std::pow(static_cast<float>(image.rgba[index + 2]) / 255.0f, 2.2f) / alpha;
        result[index + 3] = 1.0f;
    }
    return result;
}

SDL_GPUTexture* upload_rgbd_texture(SDL_GPUDevice* device, const TextureData& texture_data) {
    int width = 0;
    int height = 0;
    const std::vector<float> pixels = decode_rgbd(texture_data, width, height);
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture RGBD");

    const std::size_t byte_size = pixels.size() * sizeof(float);
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(byte_size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer RGBD");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer RGBD");
    std::memcpy(mapped, pixels.data(), byte_size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer RGBD");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureTransferInfo source{
        transfer, 0, static_cast<Uint32>(width), static_cast<Uint32>(height)};
    const SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        static_cast<Uint32>(width), static_cast<Uint32>(height), 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer RGBD");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

SDL_GPUTexture* upload_environment(SDL_GPUDevice* device, const EnvironmentState& environment) {
    const bool has_environment =
        environment.specular_width != 0 &&
        environment.specular_mip_count != 0 &&
        environment.specular_faces.size() >=
            static_cast<std::size_t>(environment.specular_mip_count) * 6;
    const std::uint32_t width = has_environment ? environment.specular_width : 1;
    const std::uint32_t mip_count = has_environment ? environment.specular_mip_count : 1;
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = width;
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture environment");

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer environment");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.reserve(static_cast<std::size_t>(mip_count) * 6);
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        for (std::uint32_t face = 0; face < 6; ++face) {
            int image_width = 1;
            int image_height = 1;
            const std::vector<float> pixels = has_environment
                ? decode_rgbd(
                      environment.specular_faces[static_cast<std::size_t>(mip) * 6 + face],
                      image_width,
                      image_height)
                : std::vector<float>{0.15f, 0.16f, 0.2f, 1.0f};
            const std::size_t byte_size = pixels.size() * sizeof(float);
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer environment");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped) gpu_error("SDL_MapGPUTransferBuffer environment");
            const std::size_t row_size =
                static_cast<std::size_t>(image_width) * 4 * sizeof(float);
            for (int row = 0; row < image_height; ++row) {
                std::memcpy(
                    static_cast<std::uint8_t*>(mapped) +
                        static_cast<std::size_t>(row) * row_size,
                    reinterpret_cast<const std::uint8_t*>(pixels.data()) +
                        static_cast<std::size_t>(image_height - row - 1) * row_size,
                    row_size);
            }
            SDL_UnmapGPUTransferBuffer(device, transfer);
            transfers.push_back(transfer);
            const SDL_GPUTextureTransferInfo source{
                transfer, 0, static_cast<Uint32>(image_width), static_cast<Uint32>(image_height)};
            const SDL_GPUTextureRegion destination{
                texture, mip, face, 0, 0, 0,
                static_cast<Uint32>(image_width), static_cast<Uint32>(image_height), 1};
            SDL_UploadToGPUTexture(copy, &source, &destination, false);
        }
    }
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer environment");
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

SDL_GPUTexture* upload_dds_skybox(SDL_GPUDevice* device, const EnvironmentState& environment) {
    const TextureData& data = environment.skybox_texture;
    if (
        !environment.has_skybox ||
        environment.skybox_width == 0 ||
        environment.skybox_mip_count == 0 ||
        environment.skybox_data_offset >= data.bytes.size()) {
        throw std::runtime_error("DDS skybox metadata is incomplete.");
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = environment.skybox_width;
    texture_info.height = environment.skybox_width;
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels = environment.skybox_mip_count;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture DDS skybox");

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer DDS skybox");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.reserve(static_cast<std::size_t>(environment.skybox_mip_count) * 6);
    std::size_t offset = environment.skybox_data_offset;
    for (std::uint32_t face = 0; face < 6; ++face) {
        for (std::uint32_t mip = 0; mip < environment.skybox_mip_count; ++mip) {
            const std::uint32_t size = std::max(environment.skybox_width >> mip, 1u);
            const std::size_t byte_size = static_cast<std::size_t>(size) * size * 8;
            if (offset + byte_size > data.bytes.size()) {
                throw std::runtime_error("DDS skybox pixel data is truncated.");
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer DDS skybox");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped) gpu_error("SDL_MapGPUTransferBuffer DDS skybox");
            std::memcpy(mapped, data.bytes.data() + offset, byte_size);
            SDL_UnmapGPUTransferBuffer(device, transfer);
            transfers.push_back(transfer);
            const SDL_GPUTextureTransferInfo source{transfer, 0, size, size};
            const SDL_GPUTextureRegion destination{
                texture, mip, face, 0, 0, 0, size, size, 1};
            SDL_UploadToGPUTexture(copy, &source, &destination, false);
            offset += byte_size;
        }
    }
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer DDS skybox");
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

void create_depth(GpuState& state, std::uint32_t width, std::uint32_t height) {
    if (state.depth && state.depth_width == width && state.depth_height == height) return;
    if (state.depth) SDL_ReleaseGPUTexture(state.device, state.depth);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.depth = SDL_CreateGPUTexture(state.device, &info);
    if (!state.depth) gpu_error("SDL_CreateGPUTexture depth");
    state.depth_width = width;
    state.depth_height = height;
}

void create_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (state.color && state.color_width == width && state.color_height == height) return;
    if (state.color) SDL_ReleaseGPUTexture(state.device, state.color);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET | SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.color) gpu_error("SDL_CreateGPUTexture color");
    state.color_width = width;
    state.color_height = height;
}

void save_id_buffer_png(
    GpuState& state,
    std::uint32_t width,
    std::uint32_t height,
    const std::array<float, 16>& view_projection,
    const std::vector<upstream::RenderItem>& render_plan,
    const Engine& engine,
    const std::string& path) {
    SDL_GPUTextureCreateInfo color_info{};
    color_info.type = SDL_GPU_TEXTURETYPE_2D;
    color_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    color_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    color_info.width = width;
    color_info.height = height;
    color_info.layer_count_or_depth = 1;
    color_info.num_levels = 1;
    color_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* color = SDL_CreateGPUTexture(state.device, &color_info);
    if (!color) gpu_error("SDL_CreateGPUTexture ID buffer");

    SDL_GPUTextureCreateInfo depth_info{};
    depth_info.type = SDL_GPU_TEXTURETYPE_2D;
    depth_info.format = SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    depth_info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    depth_info.width = width;
    depth_info.height = height;
    depth_info.layer_count_or_depth = 1;
    depth_info.num_levels = 1;
    depth_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* depth = SDL_CreateGPUTexture(state.device, &depth_info);
    if (!depth) {
        SDL_ReleaseGPUTexture(state.device, color);
        gpu_error("SDL_CreateGPUTexture ID depth");
    }

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(state.device);
    if (!command) {
        SDL_ReleaseGPUTexture(state.device, depth);
        SDL_ReleaseGPUTexture(state.device, color);
        gpu_error("SDL_AcquireGPUCommandBuffer ID buffer");
    }
    SDL_PushGPUVertexUniformData(
        command,
        0,
        view_projection.data(),
        sizeof(view_projection));

    SDL_GPUColorTargetInfo target{};
    target.texture = color;
    target.clear_color = SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
    target.load_op = SDL_GPU_LOADOP_CLEAR;
    target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPUDepthStencilTargetInfo depth_target{};
    depth_target.texture = depth;
    depth_target.clear_depth = 1.0f;
    depth_target.load_op = SDL_GPU_LOADOP_CLEAR;
    depth_target.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depth_target.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    SDL_GPURenderPass* pass =
        SDL_BeginGPURenderPass(command, &target, 1, &depth_target);
    for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
        SDL_BindGPUGraphicsPipeline(
            pass,
            sided_mode == 0 ? state.id_pipeline : state.id_double_sided_pipeline);
        for (std::size_t mesh_index = 0; mesh_index < state.meshes.size(); ++mesh_index) {
            const upstream::RenderItem& item = render_plan[mesh_index];
            const MaterialRecord* material =
                item.material.value < engine.materials.size()
                    ? &engine.materials[item.material.value]
                    : nullptr;
            const bool double_sided = material && material->double_sided;
            if (double_sided != (sided_mode == 1)) continue;

            const std::uint32_t draw_id = static_cast<std::uint32_t>(mesh_index + 1);
            IdUniforms uniforms{};
            uniforms.id_color[0] = static_cast<float>(draw_id & 0xffu) / 255.0f;
            uniforms.id_color[1] = static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
            uniforms.id_color[2] = static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
            uniforms.id_color[3] = 1.0f;
            if (material) {
                uniforms.alpha_options[0] =
                    material->alpha_mode == MaterialAlphaMode::blend
                        ? 2.0f
                        : material->alpha_mode == MaterialAlphaMode::mask
                            ? 1.0f
                            : 0.0f;
                uniforms.alpha_options[1] = material->alpha_cutoff;
                uniforms.alpha_options[2] = material->base_color_factor.a;
            } else {
                uniforms.alpha_options[2] = 1.0f;
            }
            SDL_PushGPUFragmentUniformData(command, 0, &uniforms, sizeof(uniforms));

            const GpuMesh& mesh = state.meshes[mesh_index];
            const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
            const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
            const SDL_GPUTextureSamplerBinding texture_binding{
                mesh.base_color,
                state.sampler,
            };
            SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
            SDL_BindGPUIndexBuffer(
                pass,
                &index_binding,
                SDL_GPU_INDEXELEMENTSIZE_32BIT);
            SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
            SDL_DrawGPUIndexedPrimitives(pass, mesh.index_count, 1, 0, 0, 0);
        }
    }
    SDL_EndGPURenderPass(pass);
    save_texture_png(
        state.device,
        command,
        color,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        width,
        height,
        path);
    SDL_ReleaseGPUTexture(state.device, depth);
    SDL_ReleaseGPUTexture(state.device, color);
}

void release(GpuState& state) {
    for (GpuMesh& mesh : state.meshes) {
        SDL_ReleaseGPUBuffer(state.device, mesh.vertices);
        SDL_ReleaseGPUBuffer(state.device, mesh.indices);
        SDL_ReleaseGPUTexture(state.device, mesh.base_color);
        SDL_ReleaseGPUTexture(state.device, mesh.metallic_roughness);
        SDL_ReleaseGPUTexture(state.device, mesh.normal);
        SDL_ReleaseGPUTexture(state.device, mesh.emissive);
    }
    if (state.background.vertices) SDL_ReleaseGPUBuffer(state.device, state.background.vertices);
    if (state.background.indices) SDL_ReleaseGPUBuffer(state.device, state.background.indices);
    if (state.background.texture) SDL_ReleaseGPUTexture(state.device, state.background.texture);
    if (state.skybox.vertices) SDL_ReleaseGPUBuffer(state.device, state.skybox.vertices);
    if (state.skybox.indices) SDL_ReleaseGPUBuffer(state.device, state.skybox.indices);
    if (state.skybox.texture) SDL_ReleaseGPUTexture(state.device, state.skybox.texture);
    if (state.environment) SDL_ReleaseGPUTexture(state.device, state.environment);
    if (state.brdf_lut) SDL_ReleaseGPUTexture(state.device, state.brdf_lut);
    if (state.color) SDL_ReleaseGPUTexture(state.device, state.color);
    if (state.depth) SDL_ReleaseGPUTexture(state.device, state.depth);
    if (state.background_sampler) SDL_ReleaseGPUSampler(state.device, state.background_sampler);
    if (state.sampler) SDL_ReleaseGPUSampler(state.device, state.sampler);
    if (state.background_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.background_pipeline);
    if (state.skybox_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.skybox_pipeline);
    if (state.id_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_pipeline);
    if (state.id_double_sided_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_double_sided_pipeline);
    if (state.double_sided_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.double_sided_pipeline);
    if (state.transparent_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.transparent_pipeline);
    if (state.pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.pipeline);
    if (state.window && state.device) SDL_ReleaseWindowFromGPUDevice(state.device, state.window);
    if (state.device) SDL_DestroyGPUDevice(state.device);
    if (state.window) SDL_DestroyWindow(state.window);
    SDL_Quit();
}

} // namespace
#endif

bool run_gpu_engine(Engine& engine) {
#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
    const std::string enabled = environment_variable("BBLITE_GPU");
    if (enabled == "0" || enabled == "false" || enabled == "off") return false;
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("GPU renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
    const std::string background_flag = environment_variable("BBLITE_BACKGROUND");
    const bool use_background =
        background_flag != "0" &&
        background_flag != "false" &&
        scene.environment.has_skybox;
    const std::string ground_flag = environment_variable("BBLITE_GROUND");
    const bool use_ground =
        use_background &&
        (ground_flag == "1" || ground_flag == "true");
    const std::string id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) gpu_error("SDL_Init");

    GpuState state;
    try {
        state.window = SDL_CreateWindow(
            engine.options.title.c_str(),
            engine.options.width,
            engine.options.height,
            SDL_WINDOW_RESIZABLE);
        if (!state.window) gpu_error("SDL_CreateWindow");
        state.device = SDL_CreateGPUDevice(
            SDL_GPU_SHADERFORMAT_DXIL |
                SDL_GPU_SHADERFORMAT_SPIRV |
                SDL_GPU_SHADERFORMAT_MSL,
            false,
            nullptr);
        if (!state.device) gpu_error("SDL_CreateGPUDevice");
        if (!SDL_ClaimWindowForGPUDevice(state.device, state.window)) gpu_error("SDL_ClaimWindowForGPUDevice");
        const bool benchmark_mode = !environment_variable("BBLITE_BENCHMARK_FRAMES").empty();
        if (benchmark_mode && SDL_WindowSupportsGPUPresentMode(
                state.device,
                state.window,
                SDL_GPU_PRESENTMODE_IMMEDIATE)) {
            if (!SDL_SetGPUSwapchainParameters(
                    state.device,
                    state.window,
                    SDL_GPU_SWAPCHAINCOMPOSITION_SDR,
                    SDL_GPU_PRESENTMODE_IMMEDIATE)) {
                gpu_error("SDL_SetGPUSwapchainParameters");
            }
        }
        if (!SDL_SetGPUAllowedFramesInFlight(state.device, 3)) {
            gpu_error("SDL_SetGPUAllowedFramesInFlight");
        }

        SDL_GPUShader* vertex_shader =
            load_shader(state.device, "boombox.vert", SDL_GPU_SHADERSTAGE_VERTEX, 0, 1);
        SDL_GPUShader* fragment_shader =
            load_shader(state.device, "boombox.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 6, 1);
        SDL_GPUShader* background_fragment_shader = use_background
            ? load_shader(
                  state.device,
                  "background-ground.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1)
            : nullptr;
        SDL_GPUShader* skybox_fragment_shader = use_background
            ? load_shader(
                  state.device,
                  "background-skybox.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1)
            : nullptr;
        SDL_GPUShader* id_fragment_shader = !id_buffer_path.empty()
            ? load_shader(
                  state.device,
                  "diagnostic-id.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1)
            : nullptr;

        SDL_GPUVertexBufferDescription vertex_buffer{};
        vertex_buffer.slot = 0;
        vertex_buffer.pitch = sizeof(GpuVertex);
        vertex_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
        SDL_GPUVertexAttribute attributes[4]{};
        attributes[0] = SDL_GPUVertexAttribute{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
        attributes[1] = SDL_GPUVertexAttribute{1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 12};
        attributes[2] = SDL_GPUVertexAttribute{2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 24};
        attributes[3] = SDL_GPUVertexAttribute{3, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 40};
        SDL_GPUColorTargetDescription color_target{};
        color_target.format = SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex_shader;
        pipeline_info.fragment_shader = fragment_shader;
        pipeline_info.vertex_input_state =
            SDL_GPUVertexInputState{&vertex_buffer, 1, attributes, 4};
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        pipeline_info.rasterizer_state.enable_depth_clip = true;
        pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
        pipeline_info.depth_stencil_state.enable_depth_test = true;
        pipeline_info.depth_stencil_state.enable_depth_write = true;
        pipeline_info.target_info.color_target_descriptions = &color_target;
        pipeline_info.target_info.num_color_targets = 1;
        pipeline_info.target_info.depth_stencil_format = SDL_GPU_TEXTUREFORMAT_D16_UNORM;
        pipeline_info.target_info.has_depth_stencil_target = true;
        state.pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        if (!state.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline");
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        state.double_sided_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        if (!state.double_sided_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline double-sided");
        }
        if (id_fragment_shader) {
            SDL_GPUColorTargetDescription id_target{};
            id_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo id_pipeline_info = pipeline_info;
            id_pipeline_info.fragment_shader = id_fragment_shader;
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            id_pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
            id_pipeline_info.depth_stencil_state.enable_depth_write = true;
            id_pipeline_info.target_info.color_target_descriptions = &id_target;
            state.id_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.id_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
        }
        color_target.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_SRC_ALPHA;
        color_target.blend_state.dst_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
        color_target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
        color_target.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
        color_target.blend_state.dst_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
        color_target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
        color_target.blend_state.enable_blend = true;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
        pipeline_info.depth_stencil_state.enable_depth_write = false;
        state.transparent_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        if (skybox_fragment_shader) {
            pipeline_info.fragment_shader = skybox_fragment_shader;
            color_target.blend_state.enable_blend = false;
            pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.skybox_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
        if (background_fragment_shader) {
            pipeline_info.fragment_shader = background_fragment_shader;
            color_target.blend_state.enable_blend = true;
            color_target.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
            pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.background_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
        SDL_ReleaseGPUShader(state.device, vertex_shader);
        SDL_ReleaseGPUShader(state.device, fragment_shader);
        if (background_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, background_fragment_shader);
        }
        if (skybox_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, skybox_fragment_shader);
        }
        if (id_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, id_fragment_shader);
        }
        if (!state.transparent_pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline transparent");
        if (background_fragment_shader && !state.background_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline background");
        }
        if (skybox_fragment_shader && !state.skybox_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline skybox");
        }
        if (id_fragment_shader && (!state.id_pipeline || !state.id_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline ID buffer");
        }

        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mag_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        state.sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.sampler) gpu_error("SDL_CreateGPUSampler");
        sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.background_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.background_sampler) gpu_error("SDL_CreateGPUSampler background");
        state.environment = upload_environment(state.device, scene.environment);
        state.brdf_lut = upload_rgbd_texture(state.device, scene.environment.brdf_lut);
        if (use_background) {
            const upstream::SkyboxPlan skybox =
                upstream::build_skybox_plan(scene.environment);
            std::array<GpuVertex, 8> vertices{};
            for (std::size_t index = 0; index < vertices.size(); ++index) {
                const ModelVertex& vertex = skybox.vertices[index];
                vertices[index] = GpuVertex{
                    {vertex.position.x, vertex.position.y, vertex.position.z},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
                    {vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w},
                    {vertex.uv.x, vertex.uv.y},
                };
            }
            state.skybox.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                sizeof(vertices));
            state.skybox.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                skybox.indices.data(),
                sizeof(skybox.indices));
            state.skybox.texture = upload_dds_skybox(state.device, scene.environment);
            state.skybox.enabled = true;
        }
        if (scene.environment.has_ground && use_ground) {
            const upstream::BackgroundPlan background =
                upstream::build_background_plan(scene.environment);
            std::array<GpuVertex, 4> vertices{};
            for (std::size_t index = 0; index < vertices.size(); ++index) {
                const ModelVertex& vertex = background.vertices[index];
                vertices[index] = GpuVertex{
                    {vertex.position.x, vertex.position.y, vertex.position.z},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
                    {vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w},
                    {vertex.uv.x, vertex.uv.y},
                };
            }
            state.background.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                sizeof(vertices));
            state.background.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                background.indices.data(),
                sizeof(background.indices));
            state.background.texture = upload_texture(
                state.device,
                scene.environment.ground_texture,
                false,
                {255, 255, 255, 255});
            state.background.enabled = true;
        }

        const std::vector<upstream::RenderItem> render_plan =
            upstream::build_render_plan(scene, engine);
        for (const upstream::RenderItem& item : render_plan) {
            const ModelGeometry& geometry = engine.geometries[item.geometry];
            std::vector<GpuVertex> vertices;
            vertices.reserve(geometry.vertices.size());
            for (const ModelVertex& vertex : geometry.vertices) {
                vertices.push_back(GpuVertex{
                    {vertex.position.x, vertex.position.y, vertex.position.z},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
                    {vertex.tangent.x, vertex.tangent.y, vertex.tangent.z, vertex.tangent.w},
                    {vertex.uv.x, vertex.uv.y},
                });
            }
            GpuMesh gpu_mesh;
            gpu_mesh.vertices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                vertices.data(),
                vertices.size() * sizeof(GpuVertex));
            gpu_mesh.indices = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_INDEX,
                geometry.indices.data(),
                geometry.indices.size() * sizeof(std::uint32_t));
            gpu_mesh.index_count = static_cast<std::uint32_t>(geometry.indices.size());
            const TextureData* texture = nullptr;
            const TextureData* metallic_roughness = nullptr;
            const TextureData* normal = nullptr;
            const TextureData* emissive = nullptr;
            if (item.material.value < engine.materials.size()) {
                texture = &engine.materials[item.material.value].base_color_texture;
                metallic_roughness = &engine.materials[item.material.value].metallic_roughness_texture;
                normal = &engine.materials[item.material.value].normal_texture;
                emissive = &engine.materials[item.material.value].emissive_texture;
            }
            gpu_mesh.base_color = upload_texture(
                state.device,
                texture ? *texture : TextureData{},
                true,
                {255, 255, 255, 255});
            gpu_mesh.metallic_roughness = upload_texture(
                state.device,
                metallic_roughness ? *metallic_roughness : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.normal = upload_texture(
                state.device,
                normal ? *normal : TextureData{},
                false,
                {128, 128, 255, 255});
            gpu_mesh.emissive = upload_texture(
                state.device,
                emissive ? *emissive : TextureData{},
                true,
                {0, 0, 0, 255});
            state.meshes.push_back(gpu_mesh);
        }
        if (state.meshes.empty()) throw std::runtime_error("GPU renderer found no glTF meshes.");

        CameraRecord fallback_camera;
        CameraRecord& camera =
            scene.camera.value < engine.cameras.size()
                ? engine.cameras[scene.camera.value]
                : fallback_camera;
        CameraPointerState pointer_state;
        const std::string screenshot_path = environment_variable("BBLITE_SCREENSHOT");
        bool screenshot_saved = false;
        bool id_buffer_saved = false;
        const SDL_GPUTextureFormat swapchain_format =
            SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
        const long configured = [&] {
            const std::string value = environment_variable("BBLITE_BENCHMARK_FRAMES");
            return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
        }();
        const bool benchmark = configured > 0;
        const long warmup = benchmark ? 30 : 0;
        const long limit = benchmark
            ? configured + warmup
            : [&] {
                  const std::string value = environment_variable("BBLITE_MAX_FRAMES");
                  return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
              }();
        std::vector<double> samples;
        bool running = true;
        long frame = 0;
        while (running && (limit <= 0 || frame < limit)) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
                handle_camera_pointer_event(event, camera, pointer_state);
            }
            update_camera(camera);
            const double start = monotonic_milliseconds();
            SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(state.device);
            if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
            SDL_GPUTexture* swapchain = nullptr;
            Uint32 width = 0;
            Uint32 height = 0;
            if (!SDL_WaitAndAcquireGPUSwapchainTexture(
                    command,
                    state.window,
                    &swapchain,
                    &width,
                    &height)) {
                gpu_error("SDL_WaitAndAcquireGPUSwapchainTexture");
            }
            if (!swapchain) {
                SDL_CancelGPUCommandBuffer(command);
                continue;
            }
            const bool capture_frame = !screenshot_saved && !screenshot_path.empty();
            const bool capture_ids = !id_buffer_saved && !id_buffer_path.empty();
            if (capture_frame) create_color(state, swapchain_format, width, height);
            create_depth(state, width, height);
            const std::array<float, 16> matrix =
                upstream::build_view_projection(camera, static_cast<float>(width) / height);
            SDL_PushGPUVertexUniformData(command, 0, matrix.data(), sizeof(matrix));

            SDL_GPUColorTargetInfo color_info{};
            color_info.texture = capture_frame ? state.color : swapchain;
            color_info.clear_color = SDL_FColor{
                scene.clear_color.r,
                scene.clear_color.g,
                scene.clear_color.b,
                scene.clear_color.a};
            color_info.load_op = SDL_GPU_LOADOP_CLEAR;
            color_info.store_op = SDL_GPU_STOREOP_STORE;
            SDL_GPUDepthStencilTargetInfo depth_info{};
            depth_info.texture = state.depth;
            depth_info.clear_depth = 1.0f;
            depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
            depth_info.store_op = SDL_GPU_STOREOP_DONT_CARE;
            depth_info.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
            depth_info.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
            SDL_GPURenderPass* pass =
                SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info);
            if (state.skybox.enabled) {
                const upstream::SkyboxUniforms skybox =
                    upstream::build_skybox_uniforms(scene.environment);
                SDL_BindGPUGraphicsPipeline(pass, state.skybox_pipeline);
                SDL_PushGPUFragmentUniformData(command, 0, &skybox, sizeof(skybox));
                const SDL_GPUBufferBinding vertex_binding{state.skybox.vertices, 0};
                const SDL_GPUBufferBinding index_binding{state.skybox.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_binding{
                    state.skybox.texture,
                    state.background_sampler,
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 36, 1, 0, 0, 0);
            }
            const auto draw_meshes = [&](
                                         SDL_GPUGraphicsPipeline* pipeline,
                                         float render_mode,
                                         int sided_mode) {
                SDL_BindGPUGraphicsPipeline(pass, pipeline);
                for (std::size_t mesh_index = 0; mesh_index < state.meshes.size(); ++mesh_index) {
                const GpuMesh& mesh = state.meshes[mesh_index];
                const upstream::RenderItem& item = render_plan[mesh_index];
                const bool blend =
                    item.material.value < engine.materials.size() &&
                    engine.materials[item.material.value].alpha_mode ==
                        MaterialAlphaMode::blend;
                if ((render_mode > 0.5f) != blend) {
                    continue;
                }
                const bool double_sided =
                    item.material.value < engine.materials.size() &&
                    engine.materials[item.material.value].double_sided;
                if (
                    sided_mode != 2 &&
                    double_sided != (sided_mode == 1)) {
                    continue;
                }
                const upstream::PbrUniforms fragment = upstream::build_pbr_uniforms(
                    scene,
                    engine,
                    camera,
                    item);
                SDL_PushGPUFragmentUniformData(command, 0, &fragment, sizeof(fragment));
                const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
                const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_bindings[6]{
                    SDL_GPUTextureSamplerBinding{mesh.base_color, state.sampler},
                    SDL_GPUTextureSamplerBinding{mesh.metallic_roughness, state.sampler},
                    SDL_GPUTextureSamplerBinding{mesh.normal, state.sampler},
                    SDL_GPUTextureSamplerBinding{mesh.emissive, state.sampler},
                    SDL_GPUTextureSamplerBinding{state.environment, state.sampler},
                    SDL_GPUTextureSamplerBinding{state.brdf_lut, state.sampler},
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
                SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, texture_bindings, 6);
                SDL_DrawGPUIndexedPrimitives(pass, mesh.index_count, 1, 0, 0, 0);
                }
            };
            draw_meshes(state.pipeline, 0.0f, 0);
            draw_meshes(state.double_sided_pipeline, 0.0f, 1);
            draw_meshes(state.transparent_pipeline, 1.0f, 2);
            if (state.background.enabled) {
                const upstream::BackgroundUniforms background =
                    upstream::build_background_uniforms(scene.environment, camera);
                SDL_BindGPUGraphicsPipeline(pass, state.background_pipeline);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &background,
                    sizeof(background));
                const SDL_GPUBufferBinding vertex_binding{state.background.vertices, 0};
                const SDL_GPUBufferBinding index_binding{state.background.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_binding{
                    state.background.texture,
                    state.background_sampler,
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 6, 1, 0, 0, 0);
            }
            SDL_EndGPURenderPass(pass);
            if (capture_frame) {
                SDL_GPUBlitInfo blit{};
                blit.source = SDL_GPUBlitRegion{state.color, 0, 0, 0, 0, width, height};
                blit.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.flip_mode = SDL_FLIP_NONE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &blit);
                save_texture_png(
                    state.device,
                    command,
                    state.color,
                    swapchain_format,
                    width,
                    height,
                    screenshot_path);
                screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer");
            }
            if (capture_ids) {
                save_id_buffer_png(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan,
                    engine,
                    id_buffer_path);
                id_buffer_saved = true;
            }
            if (benchmark && frame >= warmup) {
                samples.push_back(monotonic_milliseconds() - start);
            }
            ++frame;
        }
        if (!samples.empty()) {
            std::sort(samples.begin(), samples.end());
            double sum = 0.0;
            for (double sample : samples) sum += sample;
            std::cout
                << "Babylon Lite SDL_GPU benchmark | driver="
                << SDL_GetGPUDeviceDriver(state.device)
                << " | frames=" << samples.size()
                << " | average=" << (sum / samples.size())
                << " ms | median=" << samples[samples.size() / 2]
                << " ms\n";
        }
        release(state);
        return true;
    } catch (...) {
        release(state);
        throw;
    }
#else
    (void)engine;
    return false;
#endif
}

} // namespace bbl::pal
