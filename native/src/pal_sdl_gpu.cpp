#include <bblite/pal.hpp>
#include <bblite/pal_gltf.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <bblite/upstream/camera_math.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF && defined(_WIN32)
#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#endif

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "."
#endif

namespace bbl::pal {

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF && defined(_WIN32)
namespace {

struct GpuVertex {
    float position[3];
    float normal[3];
    float uv[2];
};

struct GpuMesh {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUTexture* base_color = nullptr;
    SDL_GPUTexture* emissive = nullptr;
    std::uint32_t index_count = 0;
    MaterialHandle material{};
};

struct FragmentUniforms {
    float light_direction[4];
    float base_color_factor[4];
    float emissive_factor[4];
};

struct GpuState {
    SDL_Window* window = nullptr;
    SDL_GPUDevice* device = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUTexture* depth = nullptr;
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::vector<GpuMesh> meshes;
};

[[noreturn]] void gpu_error(const char* operation) {
    throw std::runtime_error(std::string(operation) + ": " + SDL_GetError());
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

SDL_GPUTexture* upload_texture(SDL_GPUDevice* device, const TextureData& texture_data) {
    DecodedImage image;
    if (texture_data.bytes.empty()) {
        image.width = image.height = 1;
        image.rgba = {255, 255, 255, 255};
    } else {
        image = decode_image(ts::Blob(ts::ArrayBuffer(texture_data.bytes), texture_data.mime_type));
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB;
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

std::array<float, 16> multiply(const std::array<float, 16>& left, const std::array<float, 16>& right) {
    std::array<float, 16> result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            for (int index = 0; index < 4; ++index) {
                result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
            }
        }
    }
    return result;
}

float dot(Vec3 left, Vec3 right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(dot(value, value));
    return length > 0.000001f ? Vec3{value.x / length, value.y / length, value.z / length} : Vec3{};
}

Vec3 cross(Vec3 left, Vec3 right) {
    return Vec3{
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

std::array<float, 16> view_projection(const CameraRecord& camera, float aspect) {
    const Vec3 eye = upstream::arc_rotate_eye_position(camera);
    const Vec3 forward = normalize(Vec3{
        camera.target.x - eye.x,
        camera.target.y - eye.y,
        camera.target.z - eye.z,
    });
    const Vec3 right = normalize(cross(Vec3{0.0f, 1.0f, 0.0f}, forward));
    const Vec3 up = cross(forward, right);
    std::array<float, 16> view{};
    view[0] = right.x; view[4] = right.y; view[8] = right.z; view[12] = -dot(right, eye);
    view[1] = up.x; view[5] = up.y; view[9] = up.z; view[13] = -dot(up, eye);
    view[2] = forward.x; view[6] = forward.y; view[10] = forward.z; view[14] = -dot(forward, eye);
    view[15] = 1.0f;

    const float focal = 1.0f / std::tan(camera.fov * 0.5f);
    std::array<float, 16> projection{};
    projection[0] = focal / aspect;
    projection[5] = focal;
    projection[10] = camera.far_plane / (camera.far_plane - camera.near_plane);
    projection[11] = 1.0f;
    projection[14] =
        (-camera.near_plane * camera.far_plane) /
        (camera.far_plane - camera.near_plane);
    return multiply(projection, view);
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

void release(GpuState& state) {
    for (GpuMesh& mesh : state.meshes) {
        SDL_ReleaseGPUBuffer(state.device, mesh.vertices);
        SDL_ReleaseGPUBuffer(state.device, mesh.indices);
        SDL_ReleaseGPUTexture(state.device, mesh.base_color);
        SDL_ReleaseGPUTexture(state.device, mesh.emissive);
    }
    if (state.depth) SDL_ReleaseGPUTexture(state.device, state.depth);
    if (state.sampler) SDL_ReleaseGPUSampler(state.device, state.sampler);
    if (state.pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.pipeline);
    if (state.window && state.device) SDL_ReleaseWindowFromGPUDevice(state.device, state.window);
    if (state.device) SDL_DestroyGPUDevice(state.device);
    if (state.window) SDL_DestroyWindow(state.window);
    SDL_Quit();
}

} // namespace
#endif

bool run_gpu_engine(Engine& engine) {
#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF && defined(_WIN32)
    const std::string enabled = environment_variable("BBLITE_GPU");
    if (enabled != "1" && enabled != "true") return false;
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("GPU renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
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
            load_shader(state.device, "boombox.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 2, 1);

        SDL_GPUVertexBufferDescription vertex_buffer{};
        vertex_buffer.slot = 0;
        vertex_buffer.pitch = sizeof(GpuVertex);
        vertex_buffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
        SDL_GPUVertexAttribute attributes[3]{};
        attributes[0] = SDL_GPUVertexAttribute{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
        attributes[1] = SDL_GPUVertexAttribute{1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 12};
        attributes[2] = SDL_GPUVertexAttribute{2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 24};
        SDL_GPUColorTargetDescription color_target{};
        color_target.format = SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex_shader;
        pipeline_info.fragment_shader = fragment_shader;
        pipeline_info.vertex_input_state =
            SDL_GPUVertexInputState{&vertex_buffer, 1, attributes, 3};
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
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
        SDL_ReleaseGPUShader(state.device, vertex_shader);
        SDL_ReleaseGPUShader(state.device, fragment_shader);
        if (!state.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline");

        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mag_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        sampler_info.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        state.sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.sampler) gpu_error("SDL_CreateGPUSampler");

        for (const MeshHandle handle : scene.meshes) {
            if (handle.value >= engine.meshes.size()) continue;
            const MeshRecord& mesh = engine.meshes[handle.value];
            if (mesh.primitive != PrimitiveKind::gltf || mesh.geometry >= engine.geometries.size()) continue;
            const ModelGeometry& geometry = engine.geometries[mesh.geometry];
            std::vector<GpuVertex> vertices;
            vertices.reserve(geometry.vertices.size());
            for (const ModelVertex& vertex : geometry.vertices) {
                vertices.push_back(GpuVertex{
                    {vertex.position.x, vertex.position.y, vertex.position.z},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
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
            gpu_mesh.material = mesh.material;
            const TextureData* texture = nullptr;
            const TextureData* emissive = nullptr;
            if (mesh.material.value < engine.materials.size()) {
                texture = &engine.materials[mesh.material.value].base_color_texture;
                emissive = &engine.materials[mesh.material.value].emissive_texture;
            }
            gpu_mesh.base_color = upload_texture(
                state.device,
                texture ? *texture : TextureData{});
            gpu_mesh.emissive = upload_texture(
                state.device,
                emissive ? *emissive : TextureData{});
            state.meshes.push_back(gpu_mesh);
        }
        if (state.meshes.empty()) throw std::runtime_error("GPU renderer found no glTF meshes.");

        CameraRecord fallback_camera;
        CameraRecord& camera =
            scene.camera.value < engine.cameras.size()
                ? engine.cameras[scene.camera.value]
                : fallback_camera;
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
            }
            upstream::apply_arc_rotate_inertia(camera);
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
            create_depth(state, width, height);
            const std::array<float, 16> matrix =
                view_projection(camera, static_cast<float>(width) / height);
            SDL_PushGPUVertexUniformData(command, 0, matrix.data(), sizeof(matrix));

            SDL_GPUColorTargetInfo color_info{};
            color_info.texture = swapchain;
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
            SDL_BindGPUGraphicsPipeline(pass, state.pipeline);
            for (const GpuMesh& mesh : state.meshes) {
                FragmentUniforms fragment{};
                fragment.light_direction[1] = 1.0f;
                fragment.base_color_factor[0] =
                    fragment.base_color_factor[1] =
                    fragment.base_color_factor[2] =
                    fragment.base_color_factor[3] = 1.0f;
                if (mesh.material.value < engine.materials.size()) {
                    const MaterialRecord& material = engine.materials[mesh.material.value];
                    fragment.base_color_factor[0] = material.base_color_factor.r;
                    fragment.base_color_factor[1] = material.base_color_factor.g;
                    fragment.base_color_factor[2] = material.base_color_factor.b;
                    fragment.base_color_factor[3] = material.base_color_factor.a;
                    fragment.emissive_factor[0] = material.emissive_factor.r;
                    fragment.emissive_factor[1] = material.emissive_factor.g;
                    fragment.emissive_factor[2] = material.emissive_factor.b;
                }
                SDL_PushGPUFragmentUniformData(command, 0, &fragment, sizeof(fragment));
                const SDL_GPUBufferBinding vertex_binding{mesh.vertices, 0};
                const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_bindings[2]{
                    SDL_GPUTextureSamplerBinding{mesh.base_color, state.sampler},
                    SDL_GPUTextureSamplerBinding{mesh.emissive, state.sampler},
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
                SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, texture_bindings, 2);
                SDL_DrawGPUIndexedPrimitives(pass, mesh.index_count, 1, 0, 0, 0);
            }
            SDL_EndGPURenderPass(pass);
            if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
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
