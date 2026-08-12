#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#if defined(BBLITE_HAS_GLTF) && BBLITE_HAS_GLTF
#include <bblite/pal_gltf.hpp>
#endif
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <bblite/upstream/camera_math.hpp>
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
#include <bblite/upstream/frame_graph_geometry.hpp>
#endif
#if defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include "pal_gpu_shared.hpp"

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>
#include <SDL3_image/SDL_image.h>
#endif

#ifndef BBLITE_GPU_SHADER_DIR
#define BBLITE_GPU_SHADER_DIR "shaders"
#endif

namespace bbl::pal {

#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
namespace {

#if defined(BBLITE_RENDERER_TRANSMISSION)
constexpr std::uint32_t pbr_base_texture_binding_count = 9;
#else
constexpr std::uint32_t pbr_base_texture_binding_count = 6;
#endif

constexpr std::uint32_t pbr_material_extension_binding_count =
#if BBLITE_MATERIAL_CLEARCOAT
    3u +
#endif
#if BBLITE_MATERIAL_SHEEN
    2u +
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    2u +
#endif
    0u;

constexpr std::uint32_t pbr_texture_binding_count =
    pbr_base_texture_binding_count +
    pbr_material_extension_binding_count;

constexpr std::size_t pbr_texture_binding_capacity =
    pbr_texture_binding_count > 9u
        ? static_cast<std::size_t>(pbr_texture_binding_count)
        : 9u;


struct GpuMesh {
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SDL_GPUBuffer* instances = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    SDL_GPUBuffer* morph_deltas = nullptr;
    SDL_GPUBuffer* morph_weights = nullptr;
    std::uint64_t morph_weights_version = 0;
    bool owns_morph_buffers = false;
#endif
    SDL_GPUTexture* base_color = nullptr;
    SDL_GPUTexture* metallic_roughness = nullptr;
    SDL_GPUTexture* normal = nullptr;
    SDL_GPUTexture* emissive = nullptr;
    SDL_GPUTexture* transmission = nullptr;
    SDL_GPUTexture* thickness = nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
    SDL_GPUTexture* clearcoat = nullptr;
    SDL_GPUTexture* clearcoat_roughness = nullptr;
    SDL_GPUTexture* clearcoat_normal = nullptr;
#endif
#if BBLITE_MATERIAL_SHEEN
    SDL_GPUTexture* sheen_color = nullptr;
    SDL_GPUTexture* sheen_roughness = nullptr;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    SDL_GPUTexture* iridescence = nullptr;
    SDL_GPUTexture* iridescence_thickness = nullptr;
#endif
    SDL_GPUTexture* standard_emissive = nullptr;
    SDL_GPUTexture* reflection = nullptr;
    SDL_GPUSampler* base_color_sampler = nullptr;
    SDL_GPUSampler* metallic_roughness_sampler = nullptr;
    SDL_GPUSampler* normal_sampler = nullptr;
    SDL_GPUSampler* emissive_sampler = nullptr;
    SDL_GPUSampler* transmission_sampler = nullptr;
    SDL_GPUSampler* thickness_sampler = nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
    SDL_GPUSampler* clearcoat_sampler = nullptr;
    SDL_GPUSampler* clearcoat_roughness_sampler = nullptr;
    SDL_GPUSampler* clearcoat_normal_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_SHEEN
    SDL_GPUSampler* sheen_color_sampler = nullptr;
    SDL_GPUSampler* sheen_roughness_sampler = nullptr;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    SDL_GPUSampler* iridescence_sampler = nullptr;
    SDL_GPUSampler* iridescence_thickness_sampler = nullptr;
#endif
    SDL_GPUSampler* standard_emissive_sampler = nullptr;
    std::uint32_t index_count = 0;
    std::uint32_t instance_count = 1;
    std::uint64_t transform_version = 0;
};

void append_material_extension_bindings(
    SDL_GPUTextureSamplerBinding* bindings,
    const GpuMesh& mesh) {
    std::size_t index = 0;
#if BBLITE_MATERIAL_CLEARCOAT
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.clearcoat,
        mesh.clearcoat_sampler,
    };
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.clearcoat_roughness,
        mesh.clearcoat_roughness_sampler,
    };
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.clearcoat_normal,
        mesh.clearcoat_normal_sampler,
    };
#endif
#if BBLITE_MATERIAL_SHEEN
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.sheen_color,
        mesh.sheen_color_sampler,
    };
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.sheen_roughness,
        mesh.sheen_roughness_sampler,
    };
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.iridescence,
        mesh.iridescence_sampler,
    };
    bindings[index++] = SDL_GPUTextureSamplerBinding{
        mesh.iridescence_thickness,
        mesh.iridescence_thickness_sampler,
    };
#endif
    (void)bindings;
    (void)mesh;
    (void)index;
}

void bind_mesh_vertex_buffers(
    SDL_GPURenderPass* pass,
    const GpuMesh& mesh) {
#if BBLITE_GPU_INSTANCING
    const std::array<SDL_GPUBufferBinding, 2> bindings{
        SDL_GPUBufferBinding{mesh.vertices, 0},
        SDL_GPUBufferBinding{mesh.instances, 0},
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        bindings.data(),
        static_cast<Uint32>(bindings.size()));
#else
    const SDL_GPUBufferBinding binding{
        mesh.vertices,
        0,
    };
    SDL_BindGPUVertexBuffers(
        pass,
        0,
        &binding,
        1);
#endif
#if BBLITE_GPU_MORPH_STORAGE
    const std::array<SDL_GPUBuffer*, 2> storage{
        mesh.morph_deltas,
        mesh.morph_weights,
    };
    SDL_BindGPUVertexStorageBuffers(
        pass,
        0,
        storage.data(),
        static_cast<Uint32>(storage.size()));
#endif
}

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
    bool owns_texture = false;
    bool enabled = false;
};

struct IdUniforms {
    float id_color[4];
    float alpha_options[4];
};

struct ClusterUniforms {
    std::uint32_t cluster_options[4];
    float alpha_options[4];
};

struct CardVertexUniforms {
    float center_angle_depth[4];
};

struct CardFragmentUniforms {
    float color_opacity[4];
};

struct GpuRenderTarget {
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* sampled_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

struct GpuGeometryTask {
    std::vector<SDL_GPUTexture*> colors;
    std::vector<SDL_GPUTexture*> sampled_colors;
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUGraphicsPipeline* double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        clockwise_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* transparent_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        transparent_clockwise_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        standard_transparent_double_sided_pipeline = nullptr;
};

struct GpuState {
    SDL_Window* window = nullptr;
    SDL_GPUDevice* device = nullptr;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    SDL_GPUGraphicsPipeline* double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        clockwise_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* transparent_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        transparent_clockwise_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* standard_transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        standard_transparent_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* grid_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* grid_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* grid_transparent_pipeline = nullptr;
    SDL_GPUGraphicsPipeline*
        grid_transparent_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* shader_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* shader_alpha_to_coverage_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* shader_circular_cutout_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* background_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* skybox_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* id_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* cluster_double_sided_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* blit_msaa_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* image_processing_pipeline = nullptr;
    std::array<SDL_GPUGraphicsPipeline*, 2> depth_only_pipelines{};
    std::array<SDL_GPUGraphicsPipeline*, 2>
        depth_only_double_sided_pipelines{};
    std::array<SDL_GPUGraphicsPipeline*, 3> diagnostics_pipelines{};
    std::array<SDL_GPUGraphicsPipeline*, 3> diagnostics_double_sided_pipelines{};
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* background_sampler = nullptr;
    SDL_GPUSampler* transmission_sampler = nullptr;
    SDL_GPUSampler* ground_sampler = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    // Shared zero-count pair bound for draws whose mesh has no morph
    // targets; the shader's storage loop then runs zero iterations.
    SDL_GPUBuffer* empty_morph_deltas = nullptr;
    SDL_GPUBuffer* empty_morph_weights = nullptr;
#endif
    SDL_GPUSampler* depth_sampler = nullptr;
    SDL_GPUTexture* environment = nullptr;
    SDL_GPUTexture* brdf_lut = nullptr;
    SDL_GPUTexture* reflection_fallback = nullptr;
    std::vector<SDL_GPUTexture*> reflection_cubes;
    SDL_GPUTexture* color = nullptr;
    SDL_GPUTexture* processed_color = nullptr;
    SDL_GPUTexture* transmission_color = nullptr;
    SDL_GPUTexture* msaa_color = nullptr;
    SDL_GPUTexture* depth = nullptr;
    SDL_GPUTextureFormat depth_format =
        SDL_GPU_TEXTUREFORMAT_D16_UNORM;
    SDL_GPUSampleCount sample_count = SDL_GPU_SAMPLECOUNT_1;
    std::uint32_t color_width = 0;
    std::uint32_t color_height = 0;
    std::uint32_t processed_color_width = 0;
    std::uint32_t processed_color_height = 0;
    std::uint32_t transmission_width = 0;
    std::uint32_t transmission_height = 0;
    std::uint32_t msaa_color_width = 0;
    std::uint32_t msaa_color_height = 0;
    std::uint32_t depth_width = 0;
    std::uint32_t depth_height = 0;
    std::uint32_t frame_graph_width = 0;
    std::uint32_t frame_graph_height = 0;
    std::vector<GpuMesh> meshes;
    std::vector<GpuRenderTarget> render_targets;
    std::vector<GpuGeometryTask> geometry_tasks;
    GpuBackground background;
    GpuSkybox skybox;
};

struct CameraPointerState {
    bool orbiting = false;
    bool panning = false;
};

struct ImageProcessingUniforms {
    float parameters[4];
};

#if BBLITE_GPU_INSTANCING
#if BBLITE_GPU_DEFORMATION
constexpr Uint32 instance_uniform_slot = 2;
#else
constexpr Uint32 instance_uniform_slot = 1;
#endif
#endif

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
        if (camera.kind == CameraKind::free) {
            if (state.orbiting) {
                camera.inertial_yaw_offset +=
                    event.motion.xrel / camera.angular_sensibility;
                camera.inertial_pitch_offset -=
                    event.motion.yrel / camera.angular_sensibility;
            }
            return;
        }
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
    int key_count = 0;
    const bool* keys = SDL_GetKeyboardState(&key_count);
    const auto pressed = [keys, key_count](SDL_Scancode scancode) {
        const int index = static_cast<int>(scancode);
        return index >= 0 && index < key_count && keys[index];
    };
    if (camera.kind == CameraKind::free) {
        constexpr float nominal_frame_scale = 0.05270463f;
        const float movement = camera.speed * nominal_frame_scale;
        if (pressed(SDL_SCANCODE_W) || pressed(SDL_SCANCODE_UP)) {
            camera.inertial_direction.z += movement;
        }
        if (pressed(SDL_SCANCODE_S) || pressed(SDL_SCANCODE_DOWN)) {
            camera.inertial_direction.z -= movement;
        }
        if (pressed(SDL_SCANCODE_A) || pressed(SDL_SCANCODE_LEFT)) {
            camera.inertial_direction.x -= movement;
        }
        if (pressed(SDL_SCANCODE_D) || pressed(SDL_SCANCODE_RIGHT)) {
            camera.inertial_direction.x += movement;
        }
        if (pressed(SDL_SCANCODE_SPACE) || pressed(SDL_SCANCODE_PAGEUP)) {
            camera.inertial_direction.y += movement;
        }
        if (
            pressed(SDL_SCANCODE_LSHIFT) ||
            pressed(SDL_SCANCODE_RSHIFT) ||
            pressed(SDL_SCANCODE_PAGEDOWN)) {
            camera.inertial_direction.y -= movement;
        }
        upstream::apply_free_camera_inertia(camera);
        return;
    }
    upstream::apply_arc_rotate_inertia(camera);
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
    const std::string& path,
    const std::string& raw_path = {}) {
    const std::uint32_t bytes_per_pixel =
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            ? 8u
            : format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT
                ? 2u
                : 4u;
    const std::uint32_t source_row_bytes = width * bytes_per_pixel;
    const std::uint32_t aligned_row_bytes =
        (source_row_bytes + 255u) & ~255u;
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
    transfer_info.size = aligned_row_bytes * height;
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer screenshot");

    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureRegion source{
        swapchain, 0, 0, 0, 0, 0, width, height, 1};
    const SDL_GPUTextureTransferInfo destination{
        transfer, 0, aligned_row_bytes / bytes_per_pixel, height};
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
    if (
        !raw_path.empty() &&
        format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
        std::ofstream raw(raw_path, std::ios::binary);
        if (!raw) {
            SDL_UnmapGPUTransferBuffer(device, transfer);
            SDL_ReleaseGPUFence(device, fence);
            SDL_ReleaseGPUTransferBuffer(device, transfer);
            throw std::runtime_error(
                "Unable to open HDR diagnostic output '" + raw_path + "'.");
        }
        for (std::uint32_t y = 0; y < height; ++y) {
            raw.write(
                reinterpret_cast<const char*>(
                    mapped + static_cast<std::size_t>(y) * aligned_row_bytes),
                source_row_bytes);
        }
    }
    const std::uint32_t output_row_bytes = width * 4;
    std::vector<std::uint8_t> rgba(
        static_cast<std::size_t>(output_row_bytes) * height);
    const bool bgra =
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM ||
        format == SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB;
    const auto half_to_byte = [](std::uint16_t value) {
        const bool negative = (value & 0x8000u) != 0;
        const std::uint16_t exponent = (value >> 10) & 0x1fu;
        const std::uint16_t mantissa = value & 0x03ffu;
        float decoded = 0.0f;
        if (exponent == 0) {
            decoded = std::ldexp(static_cast<float>(mantissa), -24);
        } else if (exponent == 31) {
            decoded = mantissa == 0
                ? std::numeric_limits<float>::infinity()
                : std::numeric_limits<float>::quiet_NaN();
        } else {
            decoded = std::ldexp(
                1.0f + static_cast<float>(mantissa) / 1024.0f,
                static_cast<int>(exponent) - 15);
        }
        if (negative) decoded = -decoded;
        return static_cast<std::uint8_t>(
            std::lround(std::clamp(decoded, 0.0f, 1.0f) * 255.0f));
    };
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t* source_row = mapped + static_cast<std::size_t>(y) * aligned_row_bytes;
        std::uint8_t* destination_row =
            rgba.data() + static_cast<std::size_t>(y) * output_row_bytes;
        if (format == SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                for (std::uint32_t channel = 0; channel < 4; ++channel) {
                    destination_row[x * 4 + channel] =
                        half_to_byte(source_pixels[x * 4 + channel]);
                }
            }
        } else if (format == SDL_GPU_TEXTUREFORMAT_R16_FLOAT) {
            const auto* source_pixels =
                reinterpret_cast<const std::uint16_t*>(source_row);
            for (std::uint32_t x = 0; x < width; ++x) {
                destination_row[x * 4] = half_to_byte(source_pixels[x]);
                destination_row[x * 4 + 1] = 0;
                destination_row[x * 4 + 2] = 0;
                destination_row[x * 4 + 3] = 255;
            }
        } else {
            std::memcpy(destination_row, source_row, output_row_bytes);
            if (bgra) {
                for (std::uint32_t x = 0; x < width; ++x) {
                    std::swap(
                        destination_row[x * 4],
                        destination_row[x * 4 + 2]);
                }
            }
        }
    }
    SDL_UnmapGPUTransferBuffer(device, transfer);
    SDL_Surface* surface = SDL_CreateSurfaceFrom(
        static_cast<int>(width),
        static_cast<int>(height),
        SDL_PIXELFORMAT_RGBA32,
        rgba.data(),
        static_cast<int>(output_row_bytes));
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
    std::uint32_t uniform_buffers,
    const char* entrypoint_override = nullptr,
    std::uint32_t storage_buffers = 0) {
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
    if (entrypoint_override) {
        entrypoint = entrypoint_override;
    }
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> code = read_binary_file(
        join_path(
            shader_root,
            std::string(base_name) + extension));
    SDL_GPUShaderCreateInfo info{};
    info.code_size = code.size();
    info.code = code.data();
    info.entrypoint = entrypoint;
    info.format = format;
    info.stage = stage;
    info.num_samplers = samplers;
    info.num_uniform_buffers = uniform_buffers;
    info.num_storage_buffers = storage_buffers;
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

void update_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBuffer* buffer,
    const void* data,
    std::size_t size) {
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer =
        SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer");
    void* mapped =
        SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error("SDL_AcquireGPUCommandBuffer");
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTransferBufferLocation source{transfer, 0};
    const SDL_GPUBufferRegion destination{
        buffer,
        0,
        static_cast<Uint32>(size),
    };
    SDL_UploadToGPUBuffer(
        copy,
        &source,
        &destination,
        true);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer");
    }
    SDL_ReleaseGPUTransferBuffer(device, transfer);
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
    if (texture_data.invert_y && image.height > 1) {
        const std::size_t row_bytes =
            static_cast<std::size_t>(image.width) * 4;
        std::vector<std::uint8_t> row(row_bytes);
        for (int y = 0; y < image.height / 2; ++y) {
            std::uint8_t* top =
                image.rgba.data() + static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() +
                static_cast<std::size_t>(image.height - 1 - y) * row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = srgb
        ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB
        : SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage =
        SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = image.width;
    texture_info.height = image.height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels =
        1u + static_cast<Uint32>(
                 std::floor(
                     std::log2(
                         static_cast<double>(
                             std::max(image.width, image.height)))));
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
    if (texture_info.num_levels > 1) {
        SDL_GenerateMipmapsForGPUTexture(command, texture);
    }
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error("SDL_SubmitGPUCommandBuffer");
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

SDL_GPUTexture* upload_cube_texture(
    SDL_GPUDevice* device,
    const std::array<TextureData, 6>* texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (texture_data && !(*texture_data)[index].bytes.empty()) {
            images[index] = decode_image(
                ts::ArrayBuffer((*texture_data)[index].bytes));
        } else {
            images[index].width = 1;
            images[index].height = 1;
            images[index].rgba = {0, 0, 0, 255};
        }
        if (index == 0) {
            width = images[index].width;
            height = images[index].height;
        } else if (
            images[index].width != width ||
            images[index].height != height) {
            throw std::runtime_error(
                "Cube texture faces must have matching dimensions.");
        }
    }
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_CUBE;
    texture_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
    texture_info.usage =
        SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = static_cast<Uint32>(width);
    texture_info.height = static_cast<Uint32>(height);
    texture_info.layer_count_or_depth = 6;
    texture_info.num_levels =
        1u + static_cast<Uint32>(
                 std::floor(
                     std::log2(
                         static_cast<double>(
                             std::max(width, height)))));
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture =
        SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error("SDL_CreateGPUTexture reflection cube");

    SDL_GPUCommandBuffer* command =
        SDL_AcquireGPUCommandBuffer(device);
    if (!command) {
        gpu_error("SDL_AcquireGPUCommandBuffer reflection cube");
    }
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    std::array<SDL_GPUTransferBuffer*, 6> transfers{};
    for (std::size_t index = 0; index < images.size(); ++index) {
        const DecodedImage& image = images[index];
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size =
            static_cast<Uint32>(image.rgba.size());
        transfers[index] =
            SDL_CreateGPUTransferBuffer(device, &transfer_info);
        if (!transfers[index]) {
            gpu_error(
                "SDL_CreateGPUTransferBuffer reflection cube");
        }
        void* mapped = SDL_MapGPUTransferBuffer(
            device,
            transfers[index],
            false);
        if (!mapped) {
            gpu_error("SDL_MapGPUTransferBuffer reflection cube");
        }
        std::memcpy(
            mapped,
            image.rgba.data(),
            image.rgba.size());
        SDL_UnmapGPUTransferBuffer(device, transfers[index]);
        const SDL_GPUTextureTransferInfo source{
            transfers[index],
            0,
            static_cast<Uint32>(width),
            static_cast<Uint32>(height),
        };
        const SDL_GPUTextureRegion destination{
            texture,
            0,
            static_cast<Uint32>(index),
            0,
            0,
            0,
            static_cast<Uint32>(width),
            static_cast<Uint32>(height),
            1,
        };
        SDL_UploadToGPUTexture(
            copy,
            &source,
            &destination,
            false);
    }
    SDL_EndGPUCopyPass(copy);
    if (texture_info.num_levels > 1) {
        SDL_GenerateMipmapsForGPUTexture(command, texture);
    }
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        gpu_error("SDL_SubmitGPUCommandBuffer reflection cube");
    }
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }
    return texture;
}

SDL_GPUSampler* create_texture_sampler(
    SDL_GPUDevice* device,
    const TextureSamplerState& sampler) {
    const auto filter = [](TextureFilter value) {
        return value == TextureFilter::nearest
            ? SDL_GPU_FILTER_NEAREST
            : SDL_GPU_FILTER_LINEAR;
    };
    const auto address = [](TextureAddressMode value) {
        return value == TextureAddressMode::clamp
            ? SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE
            : value == TextureAddressMode::mirror
                ? SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT
                : SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    };
    SDL_GPUSamplerCreateInfo info{};
    info.min_filter = filter(sampler.min_filter);
    info.mag_filter = filter(sampler.mag_filter);
    info.mipmap_mode =
        sampler.mipmap_mode == TextureMipmapMode::nearest
            ? SDL_GPU_SAMPLERMIPMAPMODE_NEAREST
            : SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
    info.address_mode_u = address(sampler.address_u);
    info.address_mode_v = address(sampler.address_v);
    info.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
    info.max_anisotropy = sampler.max_anisotropy;
    info.max_lod = sampler.max_lod;
    info.enable_anisotropy = sampler.max_anisotropy > 1.0f;
    SDL_GPUSampler* result = SDL_CreateGPUSampler(device, &info);
    if (!result) gpu_error("SDL_CreateGPUSampler material texture");
    return result;
}


SDL_GPUTexture* upload_2d_texture(
    SDL_GPUDevice* device,
    const void* bytes,
    std::size_t byte_size,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureFormat format,
    const char* label) {
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.format = format;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
    if (!texture) gpu_error(label);

    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = static_cast<Uint32>(byte_size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error(label);
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error(label);
    std::memcpy(mapped, bytes, byte_size);
    SDL_UnmapGPUTransferBuffer(device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(device);
    if (!command) gpu_error(label);
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    const SDL_GPUTextureTransferInfo source{
        transfer, 0, width, height};
    const SDL_GPUTextureRegion destination{
        texture, 0, 0, 0, 0, 0,
        width, height, 1};
    SDL_UploadToGPUTexture(copy, &source, &destination, false);
    SDL_EndGPUCopyPass(copy);
    if (!SDL_SubmitGPUCommandBuffer(command)) gpu_error(label);
    SDL_ReleaseGPUTransferBuffer(device, transfer);
    return texture;
}

SDL_GPUTexture* upload_rgbd_texture(SDL_GPUDevice* device, const TextureData& texture_data) {
    int width = 0;
    int height = 0;
    const std::vector<float> pixels = decode_rgbd(texture_data, width, height);
    return upload_2d_texture(
        device,
        pixels.data(),
        pixels.size() * sizeof(float),
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT,
        "upload RGBD texture");
}

SDL_GPUTexture* upload_brdf_lut(
    SDL_GPUDevice* device,
    const EnvironmentState& environment) {
    if (!environment.brdf_lut_rgba16f) {
        return upload_rgbd_texture(device, environment.brdf_lut);
    }
    const std::size_t expected_size =
        static_cast<std::size_t>(environment.brdf_lut_width) *
        environment.brdf_lut_width *
        8;
    if (
        environment.brdf_lut_width == 0 ||
        environment.brdf_lut.bytes.size() != expected_size) {
        throw std::runtime_error(
            "Compiled BRDF LUT has invalid RGBA16F dimensions.");
    }
    return upload_2d_texture(
        device,
        environment.brdf_lut.bytes.data(),
        environment.brdf_lut.bytes.size(),
        environment.brdf_lut_width,
        environment.brdf_lut_width,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        "upload BRDF LUT");
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
    texture_info.format =
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
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
            int image_width =
                static_cast<int>(std::max(width >> mip, 1u));
            int image_height = image_width;
            const TextureData* face_data =
                has_environment
                    ? &environment.specular_faces[
                          static_cast<std::size_t>(mip) * 6 + face]
                    : nullptr;
            std::vector<float> decoded_pixels;
            std::vector<std::uint16_t> decoded_half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            std::size_t row_size = 0;
            if (environment.specular_rgba16f && face_data) {
                byte_size =
                    static_cast<std::size_t>(image_width) *
                    image_height *
                    8;
                if (face_data->bytes.size() != byte_size) {
                    throw std::runtime_error(
                        "Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data->bytes.data();
                row_size =
                    static_cast<std::size_t>(image_width) * 8;
            } else {
                decoded_pixels = face_data
                    ? decode_rgbd(
                          *face_data,
                          image_width,
                          image_height)
                    : std::vector<float>{
                          0.15f,
                          0.16f,
                          0.2f,
                          1.0f};
                decoded_half_pixels.reserve(
                    decoded_pixels.size());
                for (const float value : decoded_pixels) {
                    decoded_half_pixels.push_back(
                        float_to_half(value));
                }
                source_bytes =
                    reinterpret_cast<const std::uint8_t*>(
                        decoded_half_pixels.data());
                byte_size =
                    decoded_half_pixels.size() *
                    sizeof(std::uint16_t);
                row_size =
                    static_cast<std::size_t>(image_width) *
                    4 *
                    sizeof(std::uint16_t);
            }
            SDL_GPUTransferBufferCreateInfo transfer_info{};
            transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
            transfer_info.size = static_cast<Uint32>(byte_size);
            SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(device, &transfer_info);
            if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer environment");
            void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
            if (!mapped) gpu_error("SDL_MapGPUTransferBuffer environment");
            for (int row = 0; row < image_height; ++row) {
                const int source_row =
                    environment.specular_rgba16f
                        ? row
                        : image_height - row - 1;
                std::memcpy(
                    static_cast<std::uint8_t*>(mapped) +
                        static_cast<std::size_t>(row) * row_size,
                    source_bytes +
                        static_cast<std::size_t>(source_row) * row_size,
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

void release_sized_texture(
    GpuState& state,
    SDL_GPUTexture*& texture,
    std::uint32_t& width,
    std::uint32_t& height) {
    if (texture) {
        SDL_ReleaseGPUTexture(state.device, texture);
        texture = nullptr;
    }
    width = 0;
    height = 0;
}

void create_depth(GpuState& state, std::uint32_t width, std::uint32_t height) {
    if (state.depth && state.depth_width == width && state.depth_height == height) return;
    release_sized_texture(
        state,
        state.depth,
        state.depth_width,
        state.depth_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = state.depth_format;
    info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.depth = SDL_CreateGPUTexture(state.device, &info);
    if (!state.depth) gpu_error("SDL_CreateGPUTexture depth");
    state.depth_width = width;
    state.depth_height = height;
}

void create_msaa_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (state.sample_count == SDL_GPU_SAMPLECOUNT_1) return;
    if (
        state.msaa_color &&
        state.msaa_color_width == width &&
        state.msaa_color_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.msaa_color,
        state.msaa_color_width,
        state.msaa_color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = state.sample_count;
    state.msaa_color = SDL_CreateGPUTexture(state.device, &info);
    if (!state.msaa_color) gpu_error("SDL_CreateGPUTexture MSAA color");
    state.msaa_color_width = width;
    state.msaa_color_height = height;
}

void create_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (state.color && state.color_width == width && state.color_height == height) return;
    release_sized_texture(
        state,
        state.color,
        state.color_width,
        state.color_height);
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

void create_processed_color(
    GpuState& state,
    SDL_GPUTextureFormat format,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.processed_color &&
        state.processed_color_width == width &&
        state.processed_color_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.processed_color,
        state.processed_color_width,
        state.processed_color_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage =
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
        SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.processed_color =
        SDL_CreateGPUTexture(state.device, &info);
    if (!state.processed_color) {
        gpu_error("SDL_CreateGPUTexture processed color");
    }
    state.processed_color_width = width;
    state.processed_color_height = height;
}

// inverse_image_processed_channel moved verbatim to
// pal_gpu_shared.hpp so both backends share the linear clear color.

void create_transmission_color(
    GpuState& state,
    std::uint32_t width,
    std::uint32_t height) {
    constexpr std::uint32_t transmission_size = 1024;
    width = transmission_size;
    height = transmission_size;
    if (
        state.transmission_color &&
        state.transmission_width == width &&
        state.transmission_height == height) {
        return;
    }
    release_sized_texture(
        state,
        state.transmission_color,
        state.transmission_width,
        state.transmission_height);
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    info.usage =
        SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
        SDL_GPU_TEXTUREUSAGE_SAMPLER;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    const std::uint32_t full_mip_count =
        static_cast<std::uint32_t>(
            std::floor(std::log2(
                static_cast<float>(std::max(width, height))))) +
        1u;
    info.num_levels =
        std::max(
            1u,
            full_mip_count > 4u
                ? full_mip_count - 4u
                : 1u);
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    state.transmission_color =
        SDL_CreateGPUTexture(state.device, &info);
    if (!state.transmission_color) {
        gpu_error("SDL_CreateGPUTexture transmission color");
    }
    state.transmission_width = width;
    state.transmission_height = height;
}

SDL_GPUSampleCount task_sample_count(
    const GpuState& state,
    std::uint32_t requested) {
    return requested == 4 ? state.sample_count : SDL_GPU_SAMPLECOUNT_1;
}

SDL_GPUTextureFormat geometry_texture_format(
    const GeometryTextureDescription& description) {
    if (description.format == GeometryTextureFormat::r16_float) {
        return SDL_GPU_TEXTUREFORMAT_R16_FLOAT;
    }
    switch (description.type) {
        case GeometryTextureType::reflectivity:
        case GeometryTextureType::albedo:
            return SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        case GeometryTextureType::view_depth:
            return SDL_GPU_TEXTUREFORMAT_R32_FLOAT;
        case GeometryTextureType::normalized_view_depth:
        case GeometryTextureType::screenspace_depth:
            return SDL_GPU_TEXTUREFORMAT_R16_FLOAT;
        case GeometryTextureType::irradiance:
        case GeometryTextureType::world_position:
        case GeometryTextureType::local_position:
        case GeometryTextureType::view_normal:
        case GeometryTextureType::world_normal:
        case GeometryTextureType::linear_velocity:
            return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
    }
    return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
}

SDL_FColor geometry_clear_color(GeometryTextureType type) {
    const float value =
        type == GeometryTextureType::normalized_view_depth ? 1.0f : 0.0f;
    return SDL_FColor{value, value, value, value};
}

SDL_GPUTexture* create_frame_texture(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SDL_GPUSampleCount samples,
    std::uint32_t width,
    std::uint32_t height,
    SDL_GPUTextureUsageFlags usage) {
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = format;
    info.usage = usage;
    info.width = width;
    info.height = height;
    info.layer_count_or_depth = 1;
    info.num_levels = 1;
    info.sample_count = samples;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &info);
    if (!texture) gpu_error("SDL_CreateGPUTexture frame graph");
    return texture;
}

void release_frame_graph_textures(GpuState& state) {
    for (GpuRenderTarget& target : state.render_targets) {
        if (target.sampled_color && target.sampled_color != target.color) {
            SDL_ReleaseGPUTexture(state.device, target.sampled_color);
        }
        if (target.color) SDL_ReleaseGPUTexture(state.device, target.color);
        if (target.depth) SDL_ReleaseGPUTexture(state.device, target.depth);
        target = {};
    }
    for (GpuGeometryTask& task : state.geometry_tasks) {
        for (std::size_t index = 0; index < task.colors.size(); ++index) {
            if (
                index < task.sampled_colors.size() &&
                task.sampled_colors[index] &&
                task.sampled_colors[index] != task.colors[index]) {
                SDL_ReleaseGPUTexture(
                    state.device,
                    task.sampled_colors[index]);
            }
            if (task.colors[index]) {
                SDL_ReleaseGPUTexture(state.device, task.colors[index]);
            }
        }
        if (task.depth) SDL_ReleaseGPUTexture(state.device, task.depth);
        task.colors.clear();
        task.sampled_colors.clear();
        task.depth = nullptr;
    }
    state.frame_graph_width = 0;
    state.frame_graph_height = 0;
}

void create_frame_graph_textures(
    GpuState& state,
    const Engine& engine,
    SDL_GPUTextureFormat surface_format,
    std::uint32_t width,
    std::uint32_t height) {
    if (
        state.render_targets.size() == engine.render_targets.size() &&
        state.frame_graph_width == width &&
        state.frame_graph_height == height) {
        return;
    }
    release_frame_graph_textures(state);
    state.frame_graph_width = width;
    state.frame_graph_height = height;
    state.render_targets.resize(engine.render_targets.size());
    for (std::size_t index = 0; index < engine.render_targets.size(); ++index) {
        const RenderTargetRecord& record = engine.render_targets[index];
        GpuRenderTarget& target = state.render_targets[index];
        target.width = record.width > 0 ? record.width : width;
        target.height = record.height > 0 ? record.height : height;
        if (record.swapchain) continue;
        const SDL_GPUSampleCount samples =
            task_sample_count(state, record.samples);
        if (record.has_color) {
            target.color = create_frame_texture(
                state.device,
                surface_format,
                samples,
                target.width,
                target.height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    (samples == SDL_GPU_SAMPLECOUNT_1
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
            target.sampled_color =
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? target.color
                    : create_frame_texture(
                          state.device,
                          surface_format,
                          SDL_GPU_SAMPLECOUNT_1,
                          target.width,
                          target.height,
                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                              SDL_GPU_TEXTUREUSAGE_SAMPLER);
        }
        if (record.has_depth) {
            target.depth = create_frame_texture(
                state.device,
                state.depth_format,
                samples,
                target.width,
                target.height,
                SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                    (record.sampled_depth
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
        }
    }

    if (state.geometry_tasks.size() < engine.frame_tasks.size()) {
        state.geometry_tasks.resize(engine.frame_tasks.size());
    }
    for (std::size_t index = 0; index < engine.frame_tasks.size(); ++index) {
        const FrameTaskRecord& record = engine.frame_tasks[index];
        if (record.kind != FrameTaskKind::geometry) continue;
        GpuGeometryTask& task = state.geometry_tasks[index];
        const SDL_GPUSampleCount samples =
            task_sample_count(state, record.geometry.samples);
        task.colors.reserve(record.geometry.attachments.size());
        task.sampled_colors.reserve(record.geometry.attachments.size());
        for (const GeometryTextureDescription& description :
             record.geometry.attachments) {
            const SDL_GPUTextureFormat format =
                geometry_texture_format(description);
            SDL_GPUTexture* color = create_frame_texture(
                state.device,
                format,
                samples,
                width,
                height,
                SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                    (samples == SDL_GPU_SAMPLECOUNT_1
                         ? SDL_GPU_TEXTUREUSAGE_SAMPLER
                         : 0));
            task.colors.push_back(color);
            task.sampled_colors.push_back(
                samples == SDL_GPU_SAMPLECOUNT_1
                    ? color
                    : create_frame_texture(
                          state.device,
                          format,
                          SDL_GPU_SAMPLECOUNT_1,
                          width,
                          height,
                          SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                              SDL_GPU_TEXTUREUSAGE_SAMPLER));
        }
        task.depth = create_frame_texture(
            state.device,
            state.depth_format,
            samples,
            width,
            height,
            SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET);
    }
}

void save_geometry_id_buffer_png(
    GpuState& state,
    std::uint32_t width,
    std::uint32_t height,
    const std::array<float, 16>& view_projection,
    const std::vector<upstream::RenderItem>& render_plan,
    const Engine& engine,
    const std::string& path,
    bool cluster_ids) {
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
    depth_info.format = state.depth_format;
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
            cluster_ids
                ? (sided_mode == 0
                      ? state.cluster_pipeline
                      : state.cluster_double_sided_pipeline)
                : (sided_mode == 0
                      ? state.id_pipeline
                      : state.id_double_sided_pipeline));
        std::uint32_t cluster_id_base = 1;
        for (std::size_t mesh_index = 0; mesh_index < state.meshes.size(); ++mesh_index) {
            const GpuMesh& mesh = state.meshes[mesh_index];
            const std::uint32_t triangle_count = mesh.index_count / 3;
            const std::uint32_t current_cluster_base = cluster_id_base;
            cluster_id_base += (triangle_count + 127u) / 128u;
            const upstream::RenderItem& item = render_plan[mesh_index];
            const MaterialRecord* material =
                item.material.value < engine.materials.size()
                    ? &engine.materials[item.material.value]
                    : nullptr;
            const bool double_sided =
                item.cull_mode == upstream::RenderCullMode::none;
            if (double_sided != (sided_mode == 1)) continue;

            float alpha_options[4]{};
            if (material) {
                alpha_options[0] =
                    item.bucket == upstream::RenderBucket::alpha_blend
                        ? 2.0f
                        : item.bucket == upstream::RenderBucket::alpha_mask
                            ? 1.0f
                            : 0.0f;
                alpha_options[1] = material->alpha_cutoff;
                alpha_options[2] = material->base_color_factor.a;
            } else {
                alpha_options[2] = 1.0f;
            }
            if (cluster_ids) {
                ClusterUniforms uniforms{};
                uniforms.cluster_options[0] = current_cluster_base;
                uniforms.cluster_options[1] = 128;
                std::copy_n(alpha_options, 4, uniforms.alpha_options);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            } else {
                const std::uint32_t draw_id =
                    static_cast<std::uint32_t>(mesh_index + 1);
                IdUniforms uniforms{};
                uniforms.id_color[0] =
                    static_cast<float>(draw_id & 0xffu) / 255.0f;
                uniforms.id_color[1] =
                    static_cast<float>((draw_id >> 8) & 0xffu) / 255.0f;
                uniforms.id_color[2] =
                    static_cast<float>((draw_id >> 16) & 0xffu) / 255.0f;
                uniforms.id_color[3] = 1.0f;
                std::copy_n(alpha_options, 4, uniforms.alpha_options);
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &uniforms,
                    sizeof(uniforms));
            }

            const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
            const SDL_GPUTextureSamplerBinding texture_binding{
                mesh.base_color,
                state.sampler,
            };
            bind_mesh_vertex_buffers(pass, mesh);
            SDL_BindGPUIndexBuffer(
                pass,
                &index_binding,
                SDL_GPU_INDEXELEMENTSIZE_32BIT);
            SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
            SDL_DrawGPUIndexedPrimitives(
                pass,
                mesh.index_count,
                mesh.instance_count,
                0,
                0,
                0);
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

void save_pbr_diagnostic_buffers(
    GpuState& state,
    std::uint32_t width,
    std::uint32_t height,
    const std::array<float, 16>& view_projection,
    const std::vector<upstream::RenderItem>& render_plan,
    const Scene& scene,
    const Engine& engine,
    const CameraRecord& camera,
    const std::string& output_directory) {
    constexpr std::array<SDL_GPUTextureFormat, 9> formats{
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        SDL_GPU_TEXTUREFORMAT_R16_FLOAT,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
        SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
    };
    std::array<SDL_GPUTexture*, 9> textures{};
    std::array<SDL_GPUTexture*, 9> multisample_textures{};
    const bool multisampled = state.sample_count != SDL_GPU_SAMPLECOUNT_1;
    const auto release_textures = [&] {
        for (SDL_GPUTexture* texture : multisample_textures) {
            if (texture) SDL_ReleaseGPUTexture(state.device, texture);
        }
        for (SDL_GPUTexture* texture : textures) {
            if (texture) SDL_ReleaseGPUTexture(state.device, texture);
        }
    };
    SDL_GPUTextureCreateInfo texture_info{};
    texture_info.type = SDL_GPU_TEXTURETYPE_2D;
    texture_info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    texture_info.width = width;
    texture_info.height = height;
    texture_info.layer_count_or_depth = 1;
    texture_info.num_levels = 1;
    texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    for (std::size_t index = 0; index < textures.size(); ++index) {
        texture_info.format = formats[index];
        textures[index] = SDL_CreateGPUTexture(state.device, &texture_info);
        if (!textures[index]) {
            release_textures();
            gpu_error("SDL_CreateGPUTexture PBR diagnostic");
        }
        if (multisampled) {
            texture_info.sample_count = state.sample_count;
            multisample_textures[index] =
                SDL_CreateGPUTexture(state.device, &texture_info);
            texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
            if (!multisample_textures[index]) {
                release_textures();
                gpu_error("SDL_CreateGPUTexture PBR diagnostic MSAA");
            }
        }
    }
    SDL_GPUTextureCreateInfo depth_info{};
    depth_info.type = SDL_GPU_TEXTURETYPE_2D;
    depth_info.format = state.depth_format;
    depth_info.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    depth_info.width = width;
    depth_info.height = height;
    depth_info.layer_count_or_depth = 1;
    depth_info.num_levels = 1;
    depth_info.sample_count = state.sample_count;
    SDL_GPUTexture* depth = SDL_CreateGPUTexture(state.device, &depth_info);
    if (!depth) {
        release_textures();
        gpu_error("SDL_CreateGPUTexture PBR diagnostic depth");
    }

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(state.device);
    if (!command) {
        SDL_ReleaseGPUTexture(state.device, depth);
        release_textures();
        gpu_error("SDL_AcquireGPUCommandBuffer PBR diagnostic");
    }
    SDL_PushGPUVertexUniformData(
        command,
        0,
        view_projection.data(),
        sizeof(view_projection));
    SDL_GPUDepthStencilTargetInfo depth_target{};
    depth_target.texture = depth;
    depth_target.clear_depth = 1.0f;
    depth_target.load_op = SDL_GPU_LOADOP_CLEAR;
    depth_target.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depth_target.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depth_target.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
    const auto draw_pass = [&](
                               std::size_t output_offset,
                               std::size_t output_count,
                               std::size_t pipeline_index) {
        std::array<SDL_GPUColorTargetInfo, 4> targets{};
        for (std::size_t index = 0; index < output_count; ++index) {
            targets[index].texture = multisampled
                ? multisample_textures[output_offset + index]
                : textures[output_offset + index];
            targets[index].clear_color =
                output_offset + index == 4
                    ? SDL_FColor{1.0f, 0.0f, 0.0f, 1.0f}
                    : SDL_FColor{0.0f, 0.0f, 0.0f, 0.0f};
            targets[index].load_op = SDL_GPU_LOADOP_CLEAR;
            targets[index].store_op =
                multisampled ? SDL_GPU_STOREOP_RESOLVE : SDL_GPU_STOREOP_STORE;
            targets[index].resolve_texture =
                multisampled ? textures[output_offset + index] : nullptr;
        }
        SDL_GPURenderPass* pass =
            SDL_BeginGPURenderPass(
                command,
                targets.data(),
                static_cast<Uint32>(output_count),
                &depth_target);
        for (int sided_mode = 0; sided_mode < 2; ++sided_mode) {
            SDL_BindGPUGraphicsPipeline(
                pass,
                sided_mode == 0
                    ? state.diagnostics_pipelines[pipeline_index]
                    : state.diagnostics_double_sided_pipelines[pipeline_index]);
            for (std::size_t mesh_index = 0; mesh_index < state.meshes.size(); ++mesh_index) {
                const upstream::RenderItem& item = render_plan[mesh_index];
                const bool double_sided =
                    item.material.value < engine.materials.size() &&
                    engine.materials[item.material.value].double_sided;
                if (double_sided != (sided_mode == 1)) continue;

                const upstream::PbrUniforms fragment =
                    upstream::build_pbr_uniforms(scene, engine, camera, item);
                SDL_PushGPUFragmentUniformData(command, 0, &fragment, sizeof(fragment));
                const GpuMesh& mesh = state.meshes[mesh_index];
                const SDL_GPUBufferBinding index_binding{mesh.indices, 0};
                SDL_GPUTextureSamplerBinding
                    texture_bindings[pbr_texture_binding_capacity]{
                    SDL_GPUTextureSamplerBinding{mesh.base_color, mesh.base_color_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.metallic_roughness, mesh.metallic_roughness_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.normal, mesh.normal_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.emissive, mesh.emissive_sampler},
                    SDL_GPUTextureSamplerBinding{state.environment, state.sampler},
                    SDL_GPUTextureSamplerBinding{state.brdf_lut, state.background_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.base_color, mesh.base_color_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.transmission, mesh.transmission_sampler},
                    SDL_GPUTextureSamplerBinding{mesh.thickness, mesh.thickness_sampler},
                };
                append_material_extension_bindings(
                    &texture_bindings[pbr_base_texture_binding_count],
                    mesh);
                bind_mesh_vertex_buffers(pass, mesh);
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(
                    pass,
                    0,
                    texture_bindings,
                    pbr_texture_binding_count);
                SDL_DrawGPUIndexedPrimitives(
                    pass,
                    mesh.index_count,
                    mesh.instance_count,
                    0,
                    0,
                    0);
            }
        }
        SDL_EndGPURenderPass(pass);
    };
    draw_pass(0, 4, 0);
    draw_pass(4, 3, 1);
    draw_pass(7, 2, 2);
    if (!SDL_SubmitGPUCommandBuffer(command)) {
        SDL_ReleaseGPUTexture(state.device, depth);
        release_textures();
        gpu_error("SDL_SubmitGPUCommandBuffer PBR diagnostic");
    }

    constexpr std::array<const char*, 9> names{
        "normal-gpu.png",
        "reflectivity-gpu.png",
        "irradiance-gpu.png",
        "ibl-gpu.png",
        "normalized-depth-gpu.png",
        "albedo-gpu.png",
        "direct-light-gpu.png",
        "base-color-gpu.png",
        "pre-tone-hdr-gpu.png",
    };
    for (std::size_t index = 0; index < names.size(); ++index) {
        SDL_GPUCommandBuffer* download = SDL_AcquireGPUCommandBuffer(state.device);
        if (!download) gpu_error("SDL_AcquireGPUCommandBuffer PBR diagnostic download");
        save_texture_png(
            state.device,
            download,
            textures[index],
            formats[index],
            width,
            height,
            join_path(output_directory, names[index]),
            index == 8
                ? join_path(output_directory, "pre-tone-hdr-gpu.rgba16f")
                : std::string{});
    }
    SDL_ReleaseGPUTexture(state.device, depth);
    release_textures();
}

void release(GpuState& state) {
    release_frame_graph_textures(state);
    for (GpuGeometryTask& task : state.geometry_tasks) {
        if (task.pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, task.pipeline);
        }
        if (task.double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.double_sided_pipeline);
        }
        if (task.clockwise_double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.clockwise_double_sided_pipeline);
        }
        if (task.transparent_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.transparent_pipeline);
        }
        if (task.transparent_double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.transparent_double_sided_pipeline);
        }
        if (task.transparent_clockwise_double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.transparent_clockwise_double_sided_pipeline);
        }
        if (task.standard_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.standard_pipeline);
        }
        if (task.standard_double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.standard_double_sided_pipeline);
        }
        if (task.standard_transparent_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.standard_transparent_pipeline);
        }
        if (task.standard_transparent_double_sided_pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(
                state.device,
                task.standard_transparent_double_sided_pipeline);
        }
    }
    for (GpuMesh& mesh : state.meshes) {
        SDL_ReleaseGPUBuffer(state.device, mesh.vertices);
        SDL_ReleaseGPUBuffer(state.device, mesh.indices);
        SDL_ReleaseGPUBuffer(state.device, mesh.instances);
#if BBLITE_GPU_MORPH_STORAGE
        if (mesh.owns_morph_buffers) {
            SDL_ReleaseGPUBuffer(state.device, mesh.morph_deltas);
            SDL_ReleaseGPUBuffer(state.device, mesh.morph_weights);
        }
#endif
        SDL_ReleaseGPUTexture(state.device, mesh.base_color);
        SDL_ReleaseGPUTexture(state.device, mesh.metallic_roughness);
        SDL_ReleaseGPUTexture(state.device, mesh.normal);
        SDL_ReleaseGPUTexture(state.device, mesh.emissive);
        SDL_ReleaseGPUTexture(state.device, mesh.transmission);
        SDL_ReleaseGPUTexture(state.device, mesh.thickness);
#if BBLITE_MATERIAL_CLEARCOAT
        SDL_ReleaseGPUTexture(state.device, mesh.clearcoat);
        SDL_ReleaseGPUTexture(state.device, mesh.clearcoat_roughness);
        SDL_ReleaseGPUTexture(state.device, mesh.clearcoat_normal);
#endif
#if BBLITE_MATERIAL_SHEEN
        SDL_ReleaseGPUTexture(state.device, mesh.sheen_color);
        SDL_ReleaseGPUTexture(state.device, mesh.sheen_roughness);
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
        SDL_ReleaseGPUTexture(state.device, mesh.iridescence);
        SDL_ReleaseGPUTexture(state.device, mesh.iridescence_thickness);
#endif
        SDL_ReleaseGPUTexture(state.device, mesh.standard_emissive);
        SDL_ReleaseGPUSampler(state.device, mesh.base_color_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.metallic_roughness_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.normal_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.emissive_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.transmission_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.thickness_sampler);
#if BBLITE_MATERIAL_CLEARCOAT
        SDL_ReleaseGPUSampler(state.device, mesh.clearcoat_sampler);
        SDL_ReleaseGPUSampler(
            state.device,
            mesh.clearcoat_roughness_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.clearcoat_normal_sampler);
#endif
#if BBLITE_MATERIAL_SHEEN
        SDL_ReleaseGPUSampler(state.device, mesh.sheen_color_sampler);
        SDL_ReleaseGPUSampler(state.device, mesh.sheen_roughness_sampler);
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
        SDL_ReleaseGPUSampler(state.device, mesh.iridescence_sampler);
        SDL_ReleaseGPUSampler(
            state.device,
            mesh.iridescence_thickness_sampler);
#endif
        SDL_ReleaseGPUSampler(
            state.device,
            mesh.standard_emissive_sampler);
    }
#if BBLITE_GPU_MORPH_STORAGE
    if (state.empty_morph_deltas) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_deltas);
    }
    if (state.empty_morph_weights) {
        SDL_ReleaseGPUBuffer(state.device, state.empty_morph_weights);
    }
#endif
    if (state.background.vertices) SDL_ReleaseGPUBuffer(state.device, state.background.vertices);
    if (state.background.indices) SDL_ReleaseGPUBuffer(state.device, state.background.indices);
    if (state.background.texture) SDL_ReleaseGPUTexture(state.device, state.background.texture);
    if (state.skybox.vertices) SDL_ReleaseGPUBuffer(state.device, state.skybox.vertices);
    if (state.skybox.indices) SDL_ReleaseGPUBuffer(state.device, state.skybox.indices);
    if (state.skybox.texture && state.skybox.owns_texture) {
        SDL_ReleaseGPUTexture(state.device, state.skybox.texture);
    }
    if (state.environment) SDL_ReleaseGPUTexture(state.device, state.environment);
    if (state.brdf_lut) SDL_ReleaseGPUTexture(state.device, state.brdf_lut);
    if (state.reflection_fallback) {
        SDL_ReleaseGPUTexture(
            state.device,
            state.reflection_fallback);
    }
    for (SDL_GPUTexture* texture : state.reflection_cubes) {
        SDL_ReleaseGPUTexture(state.device, texture);
    }
    release_sized_texture(
        state,
        state.color,
        state.color_width,
        state.color_height);
    release_sized_texture(
        state,
        state.processed_color,
        state.processed_color_width,
        state.processed_color_height);
    release_sized_texture(
        state,
        state.transmission_color,
        state.transmission_width,
        state.transmission_height);
    release_sized_texture(
        state,
        state.msaa_color,
        state.msaa_color_width,
        state.msaa_color_height);
    release_sized_texture(
        state,
        state.depth,
        state.depth_width,
        state.depth_height);
    if (state.background_sampler) SDL_ReleaseGPUSampler(state.device, state.background_sampler);
    if (state.transmission_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.transmission_sampler);
    }
    if (state.ground_sampler) {
        SDL_ReleaseGPUSampler(
            state.device,
            state.ground_sampler);
    }
    if (state.depth_sampler) {
        SDL_ReleaseGPUSampler(state.device, state.depth_sampler);
    }
    if (state.sampler) SDL_ReleaseGPUSampler(state.device, state.sampler);
    if (state.background_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.background_pipeline);
    if (state.skybox_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.skybox_pipeline);
    if (state.id_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_pipeline);
    if (state.id_double_sided_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.id_double_sided_pipeline);
    if (state.cluster_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_pipeline);
    if (state.cluster_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.cluster_double_sided_pipeline);
    }
    if (state.blit_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_pipeline);
    }
    if (state.blit_msaa_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.blit_msaa_pipeline);
    }
    if (state.image_processing_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.image_processing_pipeline);
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.depth_only_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (
        SDL_GPUGraphicsPipeline* pipeline :
        state.depth_only_double_sided_pipelines) {
        if (pipeline) {
            SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
        }
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.diagnostics_pipelines) {
        if (pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
    }
    for (SDL_GPUGraphicsPipeline* pipeline : state.diagnostics_double_sided_pipelines) {
        if (pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, pipeline);
    }
    if (state.double_sided_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.double_sided_pipeline);
    if (state.clockwise_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.clockwise_double_sided_pipeline);
    }
    if (state.transparent_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.transparent_pipeline);
    if (state.transparent_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.transparent_double_sided_pipeline);
    }
    if (state.transparent_clockwise_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.transparent_clockwise_double_sided_pipeline);
    }
    if (state.standard_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.standard_pipeline);
    }
    if (state.standard_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.standard_double_sided_pipeline);
    }
    if (state.standard_transparent_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.standard_transparent_pipeline);
    }
    if (state.standard_transparent_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.standard_transparent_double_sided_pipeline);
    }
    if (state.grid_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_pipeline);
    }
    if (state.grid_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_double_sided_pipeline);
    }
    if (state.grid_transparent_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_transparent_pipeline);
    }
    if (state.grid_transparent_double_sided_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.grid_transparent_double_sided_pipeline);
    }
    if (state.shader_pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.shader_pipeline);
    if (state.shader_alpha_to_coverage_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(state.device, state.shader_alpha_to_coverage_pipeline);
    }
    if (state.shader_circular_cutout_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(
            state.device,
            state.shader_circular_cutout_pipeline);
    }
    if (state.pipeline) SDL_ReleaseGPUGraphicsPipeline(state.device, state.pipeline);
    if (state.window && state.device) SDL_ReleaseWindowFromGPUDevice(state.device, state.window);
    if (state.device) SDL_DestroyGPUDevice(state.device);
    if (state.window) SDL_DestroyWindow(state.window);
    SDL_Quit();
}

} // namespace
#endif

bool run_gpu_engine(Engine& engine) {
#if defined(BBLITE_HAS_SDL) && BBLITE_HAS_SDL && defined(BBLITE_HAS_PBR_RENDERER) && BBLITE_HAS_PBR_RENDERER
    const std::string enabled = environment_variable("BBLITE_GPU");
    if (enabled == "0" || enabled == "false" || enabled == "off") return false;
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("GPU renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
    const std::string animation_seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    if (!animation_seek.empty()) {
        const float time =
            std::strtof(animation_seek.c_str(), nullptr);
        for (const auto& seek : scene.animation_seekers) {
            seek(time);
        }
    }
    const std::string background_flag = environment_variable("BBLITE_BACKGROUND");
    const bool background_enabled =
        background_flag == "1" ||
        background_flag == "true" ||
        (background_flag.empty() &&
         scene.environment.background_enabled_by_default);
    const bool use_skybox =
        background_enabled &&
        scene.environment.has_skybox;
    const std::string ground_flag = environment_variable("BBLITE_GROUND");
    const bool use_ground =
        scene.environment.has_ground &&
        ground_flag != "0" &&
        ground_flag != "false";
    const std::string id_buffer_path = environment_variable("BBLITE_ID_BUFFER");
    const std::string cluster_buffer_path =
        environment_variable("BBLITE_CLUSTER_BUFFER");
    const std::string diagnostic_directory =
        environment_variable("BBLITE_DIAGNOSTIC_DIR");
    const std::string copy_task_filter =
        environment_variable("BBLITE_COPY_TASK");
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) gpu_error("SDL_Init");

    GpuState state;
    try {
        const bool hidden_test_pass =
            environment_variable("BBLITE_TEST_PASS") == "1";
        state.window = SDL_CreateWindow(
            engine.options.title.c_str(),
            engine.options.width,
            engine.options.height,
            hidden_test_pass
                ? SDL_WINDOW_RESIZABLE |
                    SDL_WINDOW_NOT_FOCUSABLE
                : SDL_WINDOW_RESIZABLE);
        if (!state.window) gpu_error("SDL_CreateWindow");
        const bool gpu_debug =
            environment_variable("BBLITE_GPU_DEBUG") == "1";
        state.device = SDL_CreateGPUDevice(
            SDL_GPU_SHADERFORMAT_DXIL |
                SDL_GPU_SHADERFORMAT_SPIRV |
                SDL_GPU_SHADERFORMAT_MSL,
            gpu_debug,
            nullptr);
        if (!state.device) gpu_error("SDL_CreateGPUDevice");
        if (!SDL_ClaimWindowForGPUDevice(state.device, state.window)) gpu_error("SDL_ClaimWindowForGPUDevice");
        for (const SDL_GPUTextureFormat candidate : {
                 SDL_GPU_TEXTUREFORMAT_D32_FLOAT,
                 SDL_GPU_TEXTUREFORMAT_D24_UNORM,
             }) {
            if (SDL_GPUTextureSupportsFormat(
                    state.device,
                    candidate,
                    SDL_GPU_TEXTURETYPE_2D,
                    SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET |
                        SDL_GPU_TEXTUREUSAGE_SAMPLER)) {
                state.depth_format = candidate;
                break;
            }
        }
        const SDL_GPUTextureFormat swapchain_format =
            SDL_GetGPUSwapchainTextureFormat(state.device, state.window);
        const bool transmission_enabled = scene.transmission_enabled;
        const bool use_clockwise_front_face =
            std::any_of(
                engine.meshes.begin(),
                engine.meshes.end(),
                [](const MeshRecord& mesh) {
                    return mesh.clockwise_front_face;
                });
        if (
            environment_variable("BBLITE_MSAA") != "1" &&
            upstream::preferred_sample_count() >= 4 &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                swapchain_format,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                SDL_GPU_TEXTUREFORMAT_R16_FLOAT,
                SDL_GPU_SAMPLECOUNT_4) &&
            SDL_GPUTextureSupportsSampleCount(
                state.device,
                state.depth_format,
                SDL_GPU_SAMPLECOUNT_4)) {
            state.sample_count = SDL_GPU_SAMPLECOUNT_4;
        }
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
            load_shader(
                state.device,
                "pbr.vert",
                SDL_GPU_SHADERSTAGE_VERTEX,
                0,
#if BBLITE_GPU_DEFORMATION && BBLITE_GPU_INSTANCING
                3,
#elif BBLITE_GPU_DEFORMATION || BBLITE_GPU_INSTANCING
                2,
#else
                1,
#endif
                "mainVertex",
#if BBLITE_GPU_MORPH_STORAGE
                2);
#else
                0);
#endif
        SDL_GPUShader* fragment_shader =
            load_shader(
                state.device,
                "pbr.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                pbr_texture_binding_count,
                1,
                "mainFragment");
        SDL_GPUShader* image_processing_vertex_shader =
            transmission_enabled
                ? load_shader(
                      state.device,
                      "image-processing.vert",
                      SDL_GPU_SHADERSTAGE_VERTEX,
                      0,
                      0,
                      "mainVertex")
                : nullptr;
        SDL_GPUShader* image_processing_fragment_shader =
            transmission_enabled
                ? load_shader(
                      state.device,
                      "image-processing.frag",
                      SDL_GPU_SHADERSTAGE_FRAGMENT,
                      1,
                      1,
                      "mainFragment")
                : nullptr;
        const upstream::RenderFeatures render_features =
            upstream::build_render_features(scene, engine);
        const bool use_standard_material =
            render_features.standard_material;
        SDL_GPUShader* standard_fragment_shader = use_standard_material
            ? load_shader(
                  state.device,
                  "standard.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  6,
                  1,
                  "mainFragment")
            : nullptr;
        const bool use_grid_material =
            render_features.grid_material;
        SDL_GPUShader* grid_vertex_shader = use_grid_material
            ? load_shader(
                  state.device,
                  "grid.vert",
                  SDL_GPU_SHADERSTAGE_VERTEX,
                  0,
                  1,
                  "mainVertex")
            : nullptr;
        SDL_GPUShader* grid_fragment_shader = use_grid_material
            ? load_shader(
                  state.device,
                  "grid.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  0,
                  1,
                  "mainFragment")
            : nullptr;
        const bool use_no_color_material =
            render_features.no_color_material;
        SDL_GPUShader* depth_only_fragment_shader =
            use_no_color_material
                ? load_shader(
                      state.device,
                      "depth-only.frag",
                      SDL_GPU_SHADERSTAGE_FRAGMENT,
                      0,
                      0,
                      "mainFragment")
                : nullptr;
        const bool use_alpha_card =
            render_features.shader_alpha_card;
        const bool use_circular_cutout =
            render_features.shader_circular_cutout;
        SDL_GPUShader* card_vertex_shader = use_alpha_card
            ? load_shader(
                  state.device,
                  "alpha-card.vert",
                  SDL_GPU_SHADERSTAGE_VERTEX,
                  0,
                  upstream::shader_uniform_buffer_count(
                      ShaderMaterialVariant::alpha_card,
                      false),
                  "mainVertex")
            : nullptr;
        SDL_GPUShader* card_fragment_shader = use_alpha_card
            ? load_shader(
                  state.device,
                  "alpha-card.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  0,
                  upstream::shader_uniform_buffer_count(
                      ShaderMaterialVariant::alpha_card,
                      true),
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* circular_cutout_vertex_shader = use_circular_cutout
            ? load_shader(
                  state.device,
                  "circular-cutout.vert",
                  SDL_GPU_SHADERSTAGE_VERTEX,
                  0,
                  upstream::shader_uniform_buffer_count(
                      ShaderMaterialVariant::circular_cutout,
                      false),
                  "mainVertex")
            : nullptr;
        SDL_GPUShader* circular_cutout_fragment_shader = use_circular_cutout
            ? load_shader(
                  state.device,
                  "circular-cutout.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  0,
                  upstream::shader_uniform_buffer_count(
                      ShaderMaterialVariant::circular_cutout,
                      true),
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* background_fragment_shader = use_ground
            ? load_shader(
                  state.device,
                  "background-ground.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* skybox_fragment_shader = use_skybox
            ? load_shader(
                  state.device,
                  "background-skybox.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        SDL_GPUShader* id_fragment_shader = !id_buffer_path.empty()
            ? load_shader(
                  state.device,
                  "diagnostic-id.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;
        std::array<SDL_GPUShader*, 3> diagnostics_fragment_shaders{};
        if (!diagnostic_directory.empty()) {
            diagnostics_fragment_shaders[0] = load_shader(
                state.device,
                "pbr-diagnostics-a.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                pbr_texture_binding_count,
                1,
                "mainFragment");
            diagnostics_fragment_shaders[1] = load_shader(
                state.device,
                "pbr-diagnostics-b.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                pbr_texture_binding_count,
                1,
                "mainFragment");
            diagnostics_fragment_shaders[2] = load_shader(
                state.device,
                "pbr-diagnostics-c.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                pbr_texture_binding_count,
                1,
                "mainFragment");
        }
        SDL_GPUShader* cluster_fragment_shader = !cluster_buffer_path.empty()
            ? load_shader(
                  state.device,
                  "diagnostic-cluster.frag",
                  SDL_GPU_SHADERSTAGE_FRAGMENT,
                  1,
                  1,
                  "mainFragment")
            : nullptr;

        std::array<
            SDL_GPUVertexBufferDescription,
#if BBLITE_GPU_INSTANCING
            2
#else
            1
#endif
        > vertex_buffers{};
        vertex_buffers[0].slot = 0;
        vertex_buffers[0].pitch = sizeof(GpuVertex);
        vertex_buffers[0].input_rate =
            SDL_GPU_VERTEXINPUTRATE_VERTEX;
#if BBLITE_GPU_DEFORMATION
        constexpr Uint32 base_attribute_count = 16;
#else
        constexpr Uint32 base_attribute_count = 8;
#endif
        std::array<
            SDL_GPUVertexAttribute,
#if BBLITE_GPU_INSTANCING
            base_attribute_count + 4
#else
            base_attribute_count
#endif
        > attributes{};
        constexpr Uint32 attribute_count =
            static_cast<Uint32>(attributes.size());
        attributes[0] = SDL_GPUVertexAttribute{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 0};
        attributes[1] = SDL_GPUVertexAttribute{1, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 12};
        attributes[2] = SDL_GPUVertexAttribute{2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 24};
        attributes[3] = SDL_GPUVertexAttribute{3, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 40};
        attributes[4] = SDL_GPUVertexAttribute{4, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 48};
        attributes[5] = SDL_GPUVertexAttribute{5, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2, 60};
        attributes[6] = SDL_GPUVertexAttribute{6, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 68};
        attributes[7] = SDL_GPUVertexAttribute{7, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 84};
#if BBLITE_GPU_DEFORMATION
        attributes[8] = SDL_GPUVertexAttribute{8, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 96};
        attributes[9] = SDL_GPUVertexAttribute{9, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4, 112};
        attributes[10] = SDL_GPUVertexAttribute{10, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 128};
        attributes[11] = SDL_GPUVertexAttribute{11, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 140};
        attributes[12] = SDL_GPUVertexAttribute{12, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 152};
        attributes[13] = SDL_GPUVertexAttribute{13, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 164};
        attributes[14] = SDL_GPUVertexAttribute{14, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 176};
        attributes[15] = SDL_GPUVertexAttribute{15, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3, 188};
#endif
#if BBLITE_GPU_INSTANCING
        vertex_buffers[1].slot = 1;
        vertex_buffers[1].pitch =
            sizeof(std::array<float, 16>);
        vertex_buffers[1].input_rate =
            SDL_GPU_VERTEXINPUTRATE_INSTANCE;
        attributes[base_attribute_count] =
            SDL_GPUVertexAttribute{
                16,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                0};
        attributes[base_attribute_count + 1] =
            SDL_GPUVertexAttribute{
                17,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                16};
        attributes[base_attribute_count + 2] =
            SDL_GPUVertexAttribute{
                18,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                32};
        attributes[base_attribute_count + 3] =
            SDL_GPUVertexAttribute{
                19,
                1,
                SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4,
                48};
#endif
        SDL_GPUColorTargetDescription color_target{};
        color_target.format = transmission_enabled
            ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
            : swapchain_format;
        SDL_GPUGraphicsPipelineCreateInfo pipeline_info{};
        pipeline_info.vertex_shader = vertex_shader;
        pipeline_info.fragment_shader = fragment_shader;
        pipeline_info.vertex_input_state =
            SDL_GPUVertexInputState{
                vertex_buffers.data(),
                static_cast<Uint32>(
                    vertex_buffers.size()),
                attributes.data(),
                attribute_count,
            };
        pipeline_info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        pipeline_info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
        pipeline_info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        pipeline_info.rasterizer_state.enable_depth_clip = true;
        pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
        pipeline_info.depth_stencil_state.enable_depth_test = true;
        pipeline_info.depth_stencil_state.enable_depth_write = true;
        pipeline_info.multisample_state.sample_count = state.sample_count;
        pipeline_info.target_info.color_target_descriptions = &color_target;
        pipeline_info.target_info.num_color_targets = 1;
        pipeline_info.target_info.depth_stencil_format =
            state.depth_format;
        pipeline_info.target_info.has_depth_stencil_target = true;
        state.pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        if (!state.pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline");
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        state.double_sided_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        if (!state.double_sided_pipeline) {
            gpu_error("SDL_CreateGPUGraphicsPipeline double-sided");
        }
        if (use_clockwise_front_face) {
            pipeline_info.rasterizer_state.front_face =
                SDL_GPU_FRONTFACE_CLOCKWISE;
            state.clockwise_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.clockwise_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline clockwise double-sided");
            }
            pipeline_info.rasterizer_state.front_face =
                SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        }
        if (
            image_processing_vertex_shader &&
            image_processing_fragment_shader) {
            SDL_GPUColorTargetDescription image_processing_target{};
            image_processing_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo image_processing_info{};
            image_processing_info.vertex_shader =
                image_processing_vertex_shader;
            image_processing_info.fragment_shader =
                image_processing_fragment_shader;
            image_processing_info.primitive_type =
                SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            image_processing_info.rasterizer_state.fill_mode =
                SDL_GPU_FILLMODE_FILL;
            image_processing_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            image_processing_info.multisample_state.sample_count =
                SDL_GPU_SAMPLECOUNT_1;
            image_processing_info.target_info.color_target_descriptions =
                &image_processing_target;
            image_processing_info.target_info.num_color_targets = 1;
            state.image_processing_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &image_processing_info);
            if (!state.image_processing_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline image processing");
            }
        }
        if (standard_fragment_shader) {
            SDL_GPUGraphicsPipelineCreateInfo standard_pipeline_info =
                pipeline_info;
            standard_pipeline_info.fragment_shader =
                standard_fragment_shader;
            standard_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.standard_pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &standard_pipeline_info);
            if (!state.standard_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline standard material");
            }
            standard_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.standard_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &standard_pipeline_info);
            if (!state.standard_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline standard double-sided");
            }
        }
        if (grid_vertex_shader && grid_fragment_shader) {
            SDL_GPUGraphicsPipelineCreateInfo grid_pipeline_info =
                pipeline_info;
            grid_pipeline_info.vertex_shader = grid_vertex_shader;
            grid_pipeline_info.fragment_shader = grid_fragment_shader;
            grid_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.grid_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &grid_pipeline_info);
            if (!state.grid_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid material");
            }
            grid_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.grid_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &grid_pipeline_info);
            if (!state.grid_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid double-sided");
            }
        }
        for (std::size_t index = 0;
             depth_only_fragment_shader &&
             index < state.depth_only_pipelines.size();
             ++index) {
            SDL_GPUGraphicsPipelineCreateInfo depth_pipeline_info =
                pipeline_info;
            depth_pipeline_info.fragment_shader =
                depth_only_fragment_shader;
            depth_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            depth_pipeline_info.depth_stencil_state.compare_op =
                SDL_GPU_COMPAREOP_GREATER;
            depth_pipeline_info.depth_stencil_state.enable_depth_test = true;
            depth_pipeline_info.depth_stencil_state.enable_depth_write = true;
            depth_pipeline_info.multisample_state.sample_count =
                index == 0
                    ? SDL_GPU_SAMPLECOUNT_1
                    : state.sample_count;
            depth_pipeline_info.target_info.color_target_descriptions =
                nullptr;
            depth_pipeline_info.target_info.num_color_targets = 0;
            depth_pipeline_info.target_info.depth_stencil_format =
                state.depth_format;
            depth_pipeline_info.target_info.has_depth_stencil_target = true;
            state.depth_only_pipelines[index] =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &depth_pipeline_info);
            if (!state.depth_only_pipelines[index]) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline depth-only");
            }
            depth_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.depth_only_double_sided_pipelines[index] =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &depth_pipeline_info);
            if (!state.depth_only_double_sided_pipelines[index]) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline depth-only double-sided");
            }
        }
        if (card_vertex_shader && card_fragment_shader) {
            SDL_GPUGraphicsPipelineCreateInfo card_pipeline_info = pipeline_info;
            card_pipeline_info.vertex_shader = card_vertex_shader;
            card_pipeline_info.fragment_shader = card_fragment_shader;
            card_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.shader_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &card_pipeline_info);
            if (!state.shader_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline shader material");
            }
            card_pipeline_info.multisample_state.enable_alpha_to_coverage = true;
            state.shader_alpha_to_coverage_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &card_pipeline_info);
            if (!state.shader_alpha_to_coverage_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline alpha to coverage");
            }
        }
        if (circular_cutout_vertex_shader && circular_cutout_fragment_shader) {
            SDL_GPUColorTargetDescription circular_cutout_target = color_target;
            circular_cutout_target.blend_state.src_color_blendfactor =
                SDL_GPU_BLENDFACTOR_SRC_ALPHA;
            circular_cutout_target.blend_state.dst_color_blendfactor =
                SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
            circular_cutout_target.blend_state.color_blend_op =
                SDL_GPU_BLENDOP_ADD;
            circular_cutout_target.blend_state.src_alpha_blendfactor =
                SDL_GPU_BLENDFACTOR_ONE;
            circular_cutout_target.blend_state.dst_alpha_blendfactor =
                SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
            circular_cutout_target.blend_state.alpha_blend_op =
                SDL_GPU_BLENDOP_ADD;
            circular_cutout_target.blend_state.enable_blend = true;
            SDL_GPUGraphicsPipelineCreateInfo circular_cutout_pipeline_info =
                pipeline_info;
            circular_cutout_pipeline_info.vertex_shader =
                circular_cutout_vertex_shader;
            circular_cutout_pipeline_info.fragment_shader =
                circular_cutout_fragment_shader;
            circular_cutout_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            circular_cutout_pipeline_info.depth_stencil_state.compare_op =
                SDL_GPU_COMPAREOP_LESS_OR_EQUAL;
            circular_cutout_pipeline_info.depth_stencil_state
                .enable_depth_write = false;
            circular_cutout_pipeline_info.target_info
                .color_target_descriptions = &circular_cutout_target;
            state.shader_circular_cutout_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &circular_cutout_pipeline_info);
            if (!state.shader_circular_cutout_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline circular cutout");
            }
        }
        state.geometry_tasks.resize(engine.frame_tasks.size());
        for (std::size_t task_index = 0;
             task_index < engine.frame_tasks.size();
             ++task_index) {
            const FrameTaskRecord& task = engine.frame_tasks[task_index];
            if (task.kind != FrameTaskKind::geometry) continue;
            const std::string shader_name =
                "pbr-geometry-" +
                std::to_string(task.geometry.shader_index) +
                ".frag";
            SDL_GPUShader* geometry_fragment_shader = load_shader(
                state.device,
                shader_name.c_str(),
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                6,
                1,
                "mainFragment");
            const std::string standard_shader_name =
                "standard-geometry-" +
                std::to_string(task.geometry.shader_index) +
                ".frag";
            SDL_GPUShader* standard_geometry_fragment_shader =
                use_standard_material
                    ? load_shader(
                          state.device,
                          standard_shader_name.c_str(),
                          SDL_GPU_SHADERSTAGE_FRAGMENT,
                          6,
                          1,
                          "mainFragment")
                    : nullptr;
            std::vector<SDL_GPUColorTargetDescription> geometry_targets;
            geometry_targets.reserve(
                task.geometry.attachments.size() +
                (task.geometry.target.value != invalid_handle ? 1u : 0u));
            for (const GeometryTextureDescription& description :
                 task.geometry.attachments) {
                SDL_GPUColorTargetDescription target{};
                target.format = geometry_texture_format(description);
                geometry_targets.push_back(target);
            }
            if (task.geometry.target.value != invalid_handle) {
                SDL_GPUColorTargetDescription target{};
                target.format = swapchain_format;
                geometry_targets.push_back(target);
            }
            SDL_GPUGraphicsPipelineCreateInfo geometry_pipeline_info =
                pipeline_info;
            geometry_pipeline_info.fragment_shader = geometry_fragment_shader;
            geometry_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            geometry_pipeline_info.depth_stencil_state.compare_op =
                SDL_GPU_COMPAREOP_LESS;
            geometry_pipeline_info.depth_stencil_state.enable_depth_write =
                true;
            geometry_pipeline_info.multisample_state.sample_count =
                task_sample_count(state, task.geometry.samples);
            geometry_pipeline_info.target_info.color_target_descriptions =
                geometry_targets.data();
            geometry_pipeline_info.target_info.num_color_targets =
                static_cast<Uint32>(geometry_targets.size());
            GpuGeometryTask& gpu_task = state.geometry_tasks[task_index];
            gpu_task.pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &geometry_pipeline_info);
            if (!gpu_task.pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline geometry");
            }
            geometry_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            gpu_task.double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &geometry_pipeline_info);
            if (!gpu_task.double_sided_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline geometry double-sided");
            }
            if (use_clockwise_front_face) {
                geometry_pipeline_info.rasterizer_state.front_face =
                    SDL_GPU_FRONTFACE_CLOCKWISE;
                gpu_task.clockwise_double_sided_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (!gpu_task.clockwise_double_sided_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline geometry clockwise double-sided");
                }
                geometry_pipeline_info.rasterizer_state.front_face =
                    SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
            }
            if (standard_geometry_fragment_shader) {
                geometry_pipeline_info.fragment_shader =
                    standard_geometry_fragment_shader;
                geometry_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_BACK;
                gpu_task.standard_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (!gpu_task.standard_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline standard geometry");
                }
                geometry_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_NONE;
                gpu_task.standard_double_sided_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (!gpu_task.standard_double_sided_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline standard geometry double-sided");
                }
            }
            for (SDL_GPUColorTargetDescription& target : geometry_targets) {
                target.blend_state.src_color_blendfactor =
                    SDL_GPU_BLENDFACTOR_SRC_ALPHA;
                target.blend_state.dst_color_blendfactor =
                    SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
                target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
                target.blend_state.src_alpha_blendfactor =
                    SDL_GPU_BLENDFACTOR_ONE;
                target.blend_state.dst_alpha_blendfactor =
                    SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
                target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
                target.blend_state.enable_blend = true;
            }
            geometry_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            geometry_pipeline_info.depth_stencil_state.enable_depth_write =
                false;
            geometry_pipeline_info.fragment_shader =
                geometry_fragment_shader;
            gpu_task.transparent_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &geometry_pipeline_info);
            if (!gpu_task.transparent_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline geometry transparent");
            }
            geometry_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            gpu_task.transparent_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &geometry_pipeline_info);
            if (!gpu_task.transparent_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline geometry transparent double-sided");
            }
            if (use_clockwise_front_face) {
                geometry_pipeline_info.rasterizer_state.front_face =
                    SDL_GPU_FRONTFACE_CLOCKWISE;
                gpu_task.transparent_clockwise_double_sided_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (!gpu_task.transparent_clockwise_double_sided_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline geometry transparent clockwise double-sided");
                }
                geometry_pipeline_info.rasterizer_state.front_face =
                    SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
            }
            if (standard_geometry_fragment_shader) {
                geometry_pipeline_info.fragment_shader =
                    standard_geometry_fragment_shader;
                geometry_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_BACK;
                gpu_task.standard_transparent_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (!gpu_task.standard_transparent_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline standard geometry transparent");
                }
                geometry_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_NONE;
                gpu_task.standard_transparent_double_sided_pipeline =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &geometry_pipeline_info);
                if (
                    !gpu_task
                         .standard_transparent_double_sided_pipeline) {
                    gpu_error(
                        "SDL_CreateGPUGraphicsPipeline standard geometry transparent double-sided");
                }
            }
            SDL_ReleaseGPUShader(state.device, geometry_fragment_shader);
            if (standard_geometry_fragment_shader) {
                SDL_ReleaseGPUShader(
                    state.device,
                    standard_geometry_fragment_shader);
            }
        }
        if (!scene.tasks.empty()) {
            SDL_GPUShader* blit_vertex_shader = load_shader(
                state.device,
                "blit.vert",
                SDL_GPU_SHADERSTAGE_VERTEX,
                0,
                0,
                "mainVertex");
            SDL_GPUShader* blit_fragment_shader = load_shader(
                state.device,
                "blit.frag",
                SDL_GPU_SHADERSTAGE_FRAGMENT,
                1,
                0,
                "mainFragment");
            SDL_GPUColorTargetDescription blit_target{};
            blit_target.format = swapchain_format;
            SDL_GPUGraphicsPipelineCreateInfo blit_pipeline_info{};
            blit_pipeline_info.vertex_shader = blit_vertex_shader;
            blit_pipeline_info.fragment_shader = blit_fragment_shader;
            blit_pipeline_info.primitive_type =
                SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
            blit_pipeline_info.rasterizer_state.fill_mode =
                SDL_GPU_FILLMODE_FILL;
            blit_pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            blit_pipeline_info.multisample_state.sample_count =
                SDL_GPU_SAMPLECOUNT_1;
            blit_pipeline_info.target_info.color_target_descriptions =
                &blit_target;
            blit_pipeline_info.target_info.num_color_targets = 1;
            state.blit_pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &blit_pipeline_info);
            if (!state.blit_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit");
            }
            blit_pipeline_info.multisample_state.sample_count =
                state.sample_count;
            state.blit_msaa_pipeline = SDL_CreateGPUGraphicsPipeline(
                state.device,
                &blit_pipeline_info);
            if (!state.blit_msaa_pipeline) {
                gpu_error("SDL_CreateGPUGraphicsPipeline blit MSAA");
            }
            SDL_ReleaseGPUShader(state.device, blit_vertex_shader);
            SDL_ReleaseGPUShader(state.device, blit_fragment_shader);
        }
        if (id_fragment_shader) {
            SDL_GPUColorTargetDescription id_target{};
            id_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo id_pipeline_info = pipeline_info;
            id_pipeline_info.fragment_shader = id_fragment_shader;
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            id_pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
            id_pipeline_info.depth_stencil_state.enable_depth_write = true;
            id_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            id_pipeline_info.target_info.color_target_descriptions = &id_target;
            state.id_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
            id_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.id_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &id_pipeline_info);
        }
        if (cluster_fragment_shader) {
            SDL_GPUColorTargetDescription cluster_target{};
            cluster_target.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
            SDL_GPUGraphicsPipelineCreateInfo cluster_pipeline_info = pipeline_info;
            cluster_pipeline_info.fragment_shader = cluster_fragment_shader;
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            cluster_pipeline_info.depth_stencil_state.compare_op = SDL_GPU_COMPAREOP_LESS;
            cluster_pipeline_info.depth_stencil_state.enable_depth_write = true;
            cluster_pipeline_info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
            cluster_pipeline_info.target_info.color_target_descriptions =
                &cluster_target;
            state.cluster_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &cluster_pipeline_info);
            cluster_pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.cluster_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(state.device, &cluster_pipeline_info);
        }
        if (diagnostics_fragment_shaders[0]) {
            for (std::size_t index = 0; index < diagnostics_fragment_shaders.size(); ++index) {
                std::array<SDL_GPUColorTargetDescription, 4> diagnostic_targets{};
                constexpr std::array<std::size_t, 3> target_counts{4, 3, 2};
                constexpr std::array<std::size_t, 3> target_offsets{0, 4, 7};
                const std::size_t target_count = target_counts[index];
                constexpr std::array<SDL_GPUTextureFormat, 9> diagnostic_formats{
                    SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                    SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                    SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                    SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                    SDL_GPU_TEXTUREFORMAT_R16_FLOAT,
                    SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                    SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                    SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM,
                    SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
                };
                for (std::size_t target_index = 0; target_index < target_count; ++target_index) {
                    diagnostic_targets[target_index].format =
                        diagnostic_formats[
                            target_offsets[index] + target_index];
                }
                SDL_GPUGraphicsPipelineCreateInfo diagnostic_pipeline_info = pipeline_info;
                diagnostic_pipeline_info.fragment_shader =
                    diagnostics_fragment_shaders[index];
                diagnostic_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_BACK;
                diagnostic_pipeline_info.depth_stencil_state.compare_op =
                    SDL_GPU_COMPAREOP_LESS;
                diagnostic_pipeline_info.depth_stencil_state.enable_depth_write =
                    true;
                diagnostic_pipeline_info.multisample_state.sample_count =
                    state.sample_count;
                diagnostic_pipeline_info.target_info.color_target_descriptions =
                    diagnostic_targets.data();
                diagnostic_pipeline_info.target_info.num_color_targets =
                    static_cast<Uint32>(target_count);
                state.diagnostics_pipelines[index] =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &diagnostic_pipeline_info);
                diagnostic_pipeline_info.rasterizer_state.cull_mode =
                    SDL_GPU_CULLMODE_NONE;
                state.diagnostics_double_sided_pipelines[index] =
                    SDL_CreateGPUGraphicsPipeline(
                        state.device,
                        &diagnostic_pipeline_info);
            }
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
        if (!state.transparent_pipeline) {
            gpu_error(
                "SDL_CreateGPUGraphicsPipeline transparent");
        }
        pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        state.transparent_double_sided_pipeline =
            SDL_CreateGPUGraphicsPipeline(
                state.device,
                &pipeline_info);
        if (!state.transparent_double_sided_pipeline) {
            gpu_error(
                "SDL_CreateGPUGraphicsPipeline transparent double-sided");
        }
        if (use_clockwise_front_face) {
            pipeline_info.rasterizer_state.front_face =
                SDL_GPU_FRONTFACE_CLOCKWISE;
            state.transparent_clockwise_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.transparent_clockwise_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline transparent clockwise double-sided");
            }
            pipeline_info.rasterizer_state.front_face =
                SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        }
        if (standard_fragment_shader) {
            pipeline_info.fragment_shader = standard_fragment_shader;
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.standard_transparent_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.standard_transparent_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline standard transparent");
            }
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.standard_transparent_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.standard_transparent_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline standard transparent double-sided");
            }
        }
        if (grid_vertex_shader && grid_fragment_shader) {
            pipeline_info.vertex_shader = grid_vertex_shader;
            pipeline_info.fragment_shader = grid_fragment_shader;
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_BACK;
            state.grid_transparent_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.grid_transparent_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid transparent");
            }
            pipeline_info.rasterizer_state.cull_mode =
                SDL_GPU_CULLMODE_NONE;
            state.grid_transparent_double_sided_pipeline =
                SDL_CreateGPUGraphicsPipeline(
                    state.device,
                    &pipeline_info);
            if (!state.grid_transparent_double_sided_pipeline) {
                gpu_error(
                    "SDL_CreateGPUGraphicsPipeline grid transparent double-sided");
            }
        }
        if (skybox_fragment_shader) {
            pipeline_info.vertex_shader = vertex_shader;
            pipeline_info.fragment_shader = skybox_fragment_shader;
            color_target.blend_state.enable_blend = false;
            pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
            state.skybox_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
        if (background_fragment_shader) {
            pipeline_info.vertex_shader = vertex_shader;
            pipeline_info.fragment_shader = background_fragment_shader;
            color_target.blend_state.enable_blend = true;
            color_target.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
            pipeline_info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_BACK;
            state.background_pipeline = SDL_CreateGPUGraphicsPipeline(state.device, &pipeline_info);
        }
        SDL_ReleaseGPUShader(state.device, vertex_shader);
        SDL_ReleaseGPUShader(state.device, fragment_shader);
        if (image_processing_vertex_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                image_processing_vertex_shader);
        }
        if (image_processing_fragment_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                image_processing_fragment_shader);
        }
        if (standard_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, standard_fragment_shader);
        }
        if (grid_vertex_shader) {
            SDL_ReleaseGPUShader(state.device, grid_vertex_shader);
        }
        if (grid_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, grid_fragment_shader);
        }
        if (depth_only_fragment_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                depth_only_fragment_shader);
        }
        if (card_vertex_shader) SDL_ReleaseGPUShader(state.device, card_vertex_shader);
        if (card_fragment_shader) SDL_ReleaseGPUShader(state.device, card_fragment_shader);
        if (circular_cutout_vertex_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                circular_cutout_vertex_shader);
        }
        if (circular_cutout_fragment_shader) {
            SDL_ReleaseGPUShader(
                state.device,
                circular_cutout_fragment_shader);
        }
        if (background_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, background_fragment_shader);
        }
        if (skybox_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, skybox_fragment_shader);
        }
        if (id_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, id_fragment_shader);
        }
        for (SDL_GPUShader* shader : diagnostics_fragment_shaders) {
            if (shader) SDL_ReleaseGPUShader(state.device, shader);
        }
        if (cluster_fragment_shader) {
            SDL_ReleaseGPUShader(state.device, cluster_fragment_shader);
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
        if (diagnostics_fragment_shaders[0]) {
            for (std::size_t index = 0; index < diagnostics_fragment_shaders.size(); ++index) {
                if (
                    !state.diagnostics_pipelines[index] ||
                    !state.diagnostics_double_sided_pipelines[index]) {
                    gpu_error("SDL_CreateGPUGraphicsPipeline PBR diagnostic");
                }
            }
        }
        if (
            cluster_fragment_shader &&
            (!state.cluster_pipeline || !state.cluster_double_sided_pipeline)) {
            gpu_error("SDL_CreateGPUGraphicsPipeline triangle cluster");
        }

        SDL_GPUSamplerCreateInfo sampler_info{};
        sampler_info.min_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mag_filter = SDL_GPU_FILTER_LINEAR;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_LINEAR;
        sampler_info.address_mode_u =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_v =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_REPEAT;
        sampler_info.max_lod = 1000.0f;
        state.sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.sampler) gpu_error("SDL_CreateGPUSampler");
        // Scene-color grab sampler mirrors Babylon Lite's
        // trilinear-anisotropic sampler: linear filters, repeat
        // addressing, maxAnisotropy 4 (inert under explicit-LOD
        // sampling but kept for descriptor parity).
        sampler_info.enable_anisotropy = true;
        sampler_info.max_anisotropy = 4.0f;
        state.transmission_sampler =
            SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.transmission_sampler) {
            gpu_error("SDL_CreateGPUSampler transmission");
        }
        sampler_info.enable_anisotropy = false;
        sampler_info.max_anisotropy = 0.0f;
#if BBLITE_GPU_MORPH_STORAGE
        {
            const std::array<float, 1> zero_delta{0.0f};
            state.empty_morph_deltas = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                zero_delta.data(),
                sizeof(zero_delta));
            const std::array<std::uint32_t, 4> zero_header{};
            state.empty_morph_weights = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                zero_header.data(),
                sizeof(zero_header));
        }
#endif
        sampler_info.address_mode_u =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_v =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler_info.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        state.background_sampler = SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.background_sampler) gpu_error("SDL_CreateGPUSampler background");
        sampler_info.max_lod = 0.0f;
        state.ground_sampler =
            SDL_CreateGPUSampler(
                state.device,
                &sampler_info);
        if (!state.ground_sampler) {
            gpu_error("SDL_CreateGPUSampler ground");
        }
        sampler_info.max_lod = 1000.0f;
        sampler_info.min_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mag_filter = SDL_GPU_FILTER_NEAREST;
        sampler_info.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        state.depth_sampler =
            SDL_CreateGPUSampler(state.device, &sampler_info);
        if (!state.depth_sampler) {
            gpu_error("SDL_CreateGPUSampler depth");
        }
        state.environment = upload_environment(state.device, scene.environment);
        state.brdf_lut = upload_brdf_lut(state.device, scene.environment);
        if (use_standard_material) {
            state.reflection_fallback =
                upload_cube_texture(state.device, nullptr);
            state.reflection_cubes.reserve(
                engine.reflection_cubes.size());
            for (const auto& cube : engine.reflection_cubes) {
                state.reflection_cubes.push_back(
                    upload_cube_texture(state.device, &cube));
            }
        }
        if (use_skybox) {
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
                    {vertex.local_position.x, vertex.local_position.y, vertex.local_position.z},
                    {vertex.uv2.x, vertex.uv2.y},
                    {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
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
            if (scene.environment.skybox_uses_environment) {
                state.skybox.texture = state.environment;
                state.skybox.owns_texture = false;
            } else {
                state.skybox.texture =
                    upload_dds_skybox(
                        state.device,
                        scene.environment);
                state.skybox.owns_texture = true;
            }
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
                    {vertex.local_position.x, vertex.local_position.y, vertex.local_position.z},
                    {vertex.uv2.x, vertex.uv2.y},
                    {vertex.color.x, vertex.color.y, vertex.color.z, vertex.color.w},
                    {vertex.normal.x, vertex.normal.y, vertex.normal.z},
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

        upstream::RenderPlan render_plan =
            upstream::build_render_plan(scene, engine);
        const auto upload_render_item =
            [&](const upstream::RenderItem& item) {
            const ModelGeometry& geometry = engine.geometries[item.geometry];
            const MeshRecord& mesh_record =
                engine.meshes[item.mesh.value];
            const std::vector<GpuVertex> vertices =
                transformed_vertices(geometry, mesh_record);
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
#if BBLITE_GPU_MORPH_STORAGE
            gpu_mesh.morph_deltas = state.empty_morph_deltas;
            gpu_mesh.morph_weights = state.empty_morph_weights;
            if (
                mesh_record.gpu_deformation &&
                !geometry.morph_positions.empty()) {
                // Flat 6-float deltas indexed
                // (target * vertexCount + vertex) * 6, packed with the
                // same x negation as the vertex attributes.
                const std::size_t target_count =
                    geometry.morph_positions.size();
                const std::size_t vertex_count =
                    geometry.vertices.size();
                std::vector<float> deltas(
                    target_count * vertex_count * 6,
                    0.0f);
                for (
                    std::size_t target = 0;
                    target < target_count;
                    ++target) {
                    const std::vector<Vec3>& positions =
                        geometry.morph_positions[target];
                    for (
                        std::size_t vertex = 0;
                        vertex < vertex_count;
                        ++vertex) {
                        const std::size_t offset =
                            (target * vertex_count + vertex) * 6;
                        const Vec3 position =
                            vertex < positions.size()
                                ? positions[vertex]
                                : Vec3{};
                        const Vec3 normal =
                            target < geometry.morph_normals.size() &&
                            vertex <
                                geometry.morph_normals[target].size()
                                ? geometry.morph_normals[target][vertex]
                                : Vec3{};
                        deltas[offset] = -position.x;
                        deltas[offset + 1] = position.y;
                        deltas[offset + 2] = position.z;
                        deltas[offset + 3] = -normal.x;
                        deltas[offset + 4] = normal.y;
                        deltas[offset + 5] = normal.z;
                    }
                }
                gpu_mesh.morph_deltas = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                    deltas.data(),
                    deltas.size() * sizeof(float));
                std::vector<std::uint8_t> weights_blob(
                    16 + target_count * sizeof(float),
                    0);
                const std::uint32_t header[2] = {
                    static_cast<std::uint32_t>(target_count),
                    static_cast<std::uint32_t>(vertex_count),
                };
                std::memcpy(
                    weights_blob.data(),
                    header,
                    sizeof(header));
                for (
                    std::size_t target = 0;
                    target < target_count;
                    ++target) {
                    const float weight =
                        target <
                        mesh_record.morph_storage_weights.size()
                            ? mesh_record
                                  .morph_storage_weights[target]
                            : 0.0f;
                    std::memcpy(
                        weights_blob.data() + 16 +
                            target * sizeof(float),
                        &weight,
                        sizeof(float));
                }
                gpu_mesh.morph_weights = upload_buffer(
                    state.device,
                    SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ,
                    weights_blob.data(),
                    weights_blob.size());
                gpu_mesh.morph_weights_version =
                    mesh_record.morph_weights_version;
                gpu_mesh.owns_morph_buffers = true;
            }
#endif
#if BBLITE_GPU_INSTANCING
            std::vector<std::array<float, 16>>
                instance_matrices =
                    mesh_record.instance_matrices;
            if (instance_matrices.empty()) {
                std::array<float, 16> identity{};
                identity[0] = 1.0f;
                identity[5] = 1.0f;
                identity[10] = 1.0f;
                identity[15] = 1.0f;
                instance_matrices.push_back(identity);
            }
            gpu_mesh.instances = upload_buffer(
                state.device,
                SDL_GPU_BUFFERUSAGE_VERTEX,
                instance_matrices.data(),
                instance_matrices.size() *
                    sizeof(instance_matrices.front()));
            gpu_mesh.instance_count =
                static_cast<std::uint32_t>(
                    instance_matrices.size());
#endif
            gpu_mesh.index_count =             static_cast<std::uint32_t>(geometry.indices.size());
            gpu_mesh.transform_version =
            mesh_record.transform_version;
            const TextureData* texture = nullptr;
            const TextureData* metallic_roughness = nullptr;
            const TextureData* normal = nullptr;
            const TextureData* emissive = nullptr;
            const TextureData* transmission = nullptr;
            const TextureData* thickness = nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
            const TextureData* clearcoat = nullptr;
            const TextureData* clearcoat_roughness = nullptr;
            const TextureData* clearcoat_normal = nullptr;
#endif
#if BBLITE_MATERIAL_SHEEN
            const TextureData* sheen_color = nullptr;
            const TextureData* sheen_roughness = nullptr;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
            const TextureData* iridescence = nullptr;
            const TextureData* iridescence_thickness = nullptr;
#endif
            const TextureData* standard_emissive = nullptr;
            bool has_pbr_emissive_factor = false;
            const bool standard_material =
                item.material_kind == upstream::RenderMaterialKind::standard;
            if (item.material.value < engine.materials.size()) {
                const MaterialRecord& material =
                    engine.materials[item.material.value];
                texture = &material.base_color_texture;
                metallic_roughness = standard_material
                    ? &material.specular_texture
                    : &material.metallic_roughness_texture;
                normal = standard_material
                    ? &material.opacity_texture
                    : &material.normal_texture;
                emissive = standard_material
                    ? &material.ambient_texture
                    : &material.emissive_texture;
                has_pbr_emissive_factor =
                    material.emissive_factor.r != 0.0f ||
                    material.emissive_factor.g != 0.0f ||
                    material.emissive_factor.b != 0.0f;
                transmission = standard_material
                    ? nullptr
                    : &material.transmission_texture;
                thickness = standard_material
                    ? nullptr
                    : &material.thickness_texture;
                standard_emissive = standard_material
                    ? &material.emissive_texture
                    : nullptr;
#if BBLITE_MATERIAL_CLEARCOAT
                clearcoat = standard_material
                    ? nullptr
                    : &material.clearcoat_texture;
                clearcoat_roughness = standard_material
                    ? nullptr
                    : &material.clearcoat_roughness_texture;
                clearcoat_normal = standard_material
                    ? nullptr
                    : &material.clearcoat_normal_texture;
#endif
#if BBLITE_MATERIAL_SHEEN
                sheen_color = standard_material
                    ? nullptr
                    : &material.sheen_color_texture;
                sheen_roughness = standard_material
                    ? nullptr
                    : &material.sheen_roughness_texture;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
                iridescence = standard_material
                    ? nullptr
                    : &material.iridescence_texture;
                iridescence_thickness = standard_material
                    ? nullptr
                    : &material.iridescence_thickness_texture;
#endif
                if (
                    standard_material &&
                    material.reflection_cube <
                        state.reflection_cubes.size()) {
                    gpu_mesh.reflection =
                        state.reflection_cubes[
                            material.reflection_cube];
                }
            }
            if (standard_material && !gpu_mesh.reflection) {
                gpu_mesh.reflection =
                    state.reflection_fallback;
            }
            gpu_mesh.base_color = upload_texture(
                state.device,
                texture ? *texture : TextureData{},
                !standard_material,
                {255, 255, 255, 255});
            gpu_mesh.base_color_sampler = create_texture_sampler(
                state.device,
                texture ? texture->sampler : TextureSamplerState{});
            gpu_mesh.metallic_roughness = upload_texture(
                state.device,
                metallic_roughness ? *metallic_roughness : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.metallic_roughness_sampler = create_texture_sampler(
                state.device,
                metallic_roughness
                    ? metallic_roughness->sampler
                    : TextureSamplerState{});
            gpu_mesh.normal = upload_texture(
                state.device,
                normal ? *normal : TextureData{},
                false,
                standard_material
                    ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
                    : std::array<std::uint8_t, 4>{128, 128, 255, 255});
            gpu_mesh.normal_sampler = create_texture_sampler(
                state.device,
                normal ? normal->sampler : TextureSamplerState{});
            gpu_mesh.emissive = upload_texture(
                state.device,
                emissive ? *emissive : TextureData{},
                !standard_material,
                standard_material
                    ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
                    : has_pbr_emissive_factor
                        ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
                        : std::array<std::uint8_t, 4>{0, 0, 0, 255});
            gpu_mesh.emissive_sampler = create_texture_sampler(
                state.device,
                emissive ? emissive->sampler : TextureSamplerState{});
            gpu_mesh.transmission = upload_texture(
                state.device,
                transmission ? *transmission : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.transmission_sampler = create_texture_sampler(
                state.device,
                transmission
                    ? transmission->sampler
                    : TextureSamplerState{});
            gpu_mesh.thickness = upload_texture(
                state.device,
                thickness ? *thickness : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.thickness_sampler = create_texture_sampler(
                state.device,
                thickness ? thickness->sampler : TextureSamplerState{});
#if BBLITE_MATERIAL_CLEARCOAT
            gpu_mesh.clearcoat = upload_texture(
                state.device,
                clearcoat ? *clearcoat : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.clearcoat_sampler = create_texture_sampler(
                state.device,
                clearcoat ? clearcoat->sampler : TextureSamplerState{});
            gpu_mesh.clearcoat_roughness = upload_texture(
                state.device,
                clearcoat_roughness
                    ? *clearcoat_roughness
                    : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.clearcoat_roughness_sampler =
                create_texture_sampler(
                    state.device,
                    clearcoat_roughness
                        ? clearcoat_roughness->sampler
                        : TextureSamplerState{});
            gpu_mesh.clearcoat_normal = upload_texture(
                state.device,
                clearcoat_normal ? *clearcoat_normal : TextureData{},
                false,
                {128, 128, 255, 255});
            gpu_mesh.clearcoat_normal_sampler = create_texture_sampler(
                state.device,
                clearcoat_normal
                    ? clearcoat_normal->sampler
                    : TextureSamplerState{});
#endif
#if BBLITE_MATERIAL_SHEEN
            gpu_mesh.sheen_color = upload_texture(
                state.device,
                sheen_color ? *sheen_color : TextureData{},
                true,
                {255, 255, 255, 255});
            gpu_mesh.sheen_color_sampler = create_texture_sampler(
                state.device,
                sheen_color ? sheen_color->sampler : TextureSamplerState{});
            gpu_mesh.sheen_roughness = upload_texture(
                state.device,
                sheen_roughness ? *sheen_roughness : TextureData{},
                false,
                {255, 255, 255, 255});
            gpu_mesh.sheen_roughness_sampler = create_texture_sampler(
                state.device,
                sheen_roughness
                    ? sheen_roughness->sampler
                    : TextureSamplerState{});
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
            gpu_mesh.iridescence = upload_texture(
                state.device,
                iridescence ? *iridescence : TextureData{},
                true,
                {255, 255, 255, 255});
            gpu_mesh.iridescence_sampler = create_texture_sampler(
                state.device,
                iridescence ? iridescence->sampler : TextureSamplerState{});
            gpu_mesh.iridescence_thickness = upload_texture(
                state.device,
                iridescence_thickness
                    ? *iridescence_thickness
                    : TextureData{},
                true,
                {255, 255, 255, 255});
            gpu_mesh.iridescence_thickness_sampler =
                create_texture_sampler(
                    state.device,
                    iridescence_thickness
                        ? iridescence_thickness->sampler
                        : TextureSamplerState{});
#endif
            gpu_mesh.standard_emissive = upload_texture(
                state.device,
                standard_emissive
                    ? *standard_emissive
                    : TextureData{},
                false,
                {0, 0, 0, 255});
            gpu_mesh.standard_emissive_sampler =
                create_texture_sampler(
                    state.device,
                    standard_emissive
                        ? standard_emissive->sampler
                        : TextureSamplerState{});
            state.meshes.push_back(gpu_mesh);
        };
        for (const upstream::RenderItem& item : render_plan.items) {
            upload_render_item(item);
        }
        std::vector<upstream::RenderDrawLists> task_draw_lists(
            engine.frame_tasks.size());
        const auto rebuild_task_draw_lists = [&] {
            for (
                std::size_t index = 0;
                index < engine.frame_tasks.size();
                ++index) {
                task_draw_lists[index] =
                    upstream::build_render_task_draw_lists(
                        render_plan.items,
                        engine,
                        engine.frame_tasks[index]);
            }
        };
        rebuild_task_draw_lists();
        std::uint64_t synced_mesh_membership_version =
            scene.mesh_membership_version;
        std::uint32_t synced_material_family_mask =
            scene.material_family_mask;

        CameraRecord fallback_camera;
        CameraRecord& camera =
            scene.camera.value < engine.cameras.size()
                ? engine.cameras[scene.camera.value]
                : fallback_camera;
        CameraPointerState pointer_state;
        const std::string screenshot_path = environment_variable("BBLITE_SCREENSHOT");
        const long screenshot_frame = [&] {
            const std::string value =
                environment_variable("BBLITE_SCREENSHOT_FRAME");
            return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
        }();
        bool screenshot_saved = false;
        bool id_buffer_saved = false;
        bool cluster_buffer_saved = false;
        bool diagnostics_saved = false;
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
        double previous_frame_time = 0.0;
        // Topology updates defer captures by one frame, and null
        // swapchain acquisitions advance scene callbacks without
        // consuming a frame, so a requested capture may still be
        // pending at the configured frame limit. Extend the loop by a
        // bounded grace period until every requested capture lands.
        const auto pending_capture = [&] {
            return (!screenshot_path.empty() && !screenshot_saved) ||
                (!id_buffer_path.empty() && !id_buffer_saved) ||
                (!cluster_buffer_path.empty() &&
                 !cluster_buffer_saved) ||
                (!diagnostic_directory.empty() && !diagnostics_saved);
        };
        constexpr long capture_grace_frames = 8;
        while (running &&
               (limit <= 0 || frame < limit ||
                (pending_capture() &&
                 frame < limit + capture_grace_frames))) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_EVENT_QUIT) running = false;
                if (!hidden_test_pass) {
                    handle_camera_pointer_event(
                        event,
                        camera,
                        pointer_state);
                }
            }
            const double frame_time = monotonic_milliseconds();
            const float real_delta_ms =
                previous_frame_time > 0.0
                    ? static_cast<float>(
                          frame_time - previous_frame_time)
                    : 0.0f;
            previous_frame_time = frame_time;
            const float delta_ms =
                scene.fixed_delta_ms > 0.0f
                    ? scene.fixed_delta_ms
                    : real_delta_ms;
            for (const auto& callback : scene.before_render) {
                callback(delta_ms);
            }
            for (
                std::size_t index = 0;
                index < render_plan.items.size() &&
                index < state.meshes.size();
                ++index) {
                const upstream::RenderItem& item =
                    render_plan.items[index];
                const MeshRecord& mesh =
                    engine.meshes[item.mesh.value];
                GpuMesh& gpu_mesh = state.meshes[index];
                if (
                    mesh.gpu_deformation &&
                    !engine.geometries[item.geometry].flat_normals) {
#if BBLITE_GPU_MORPH_STORAGE
                    if (
                        gpu_mesh.owns_morph_buffers &&
                        gpu_mesh.morph_weights_version !=
                            mesh.morph_weights_version) {
                        const ModelGeometry& morph_geometry =
                            engine.geometries[item.geometry];
                        const std::size_t target_count =
                            morph_geometry.morph_positions.size();
                        std::vector<std::uint8_t> weights_blob(
                            16 + target_count * sizeof(float),
                            0);
                        const std::uint32_t header[2] = {
                            static_cast<std::uint32_t>(target_count),
                            static_cast<std::uint32_t>(
                                morph_geometry.vertices.size()),
                        };
                        std::memcpy(
                            weights_blob.data(),
                            header,
                            sizeof(header));
                        for (
                            std::size_t target = 0;
                            target < target_count;
                            ++target) {
                            const float weight =
                                target <
                                mesh.morph_storage_weights.size()
                                    ? mesh.morph_storage_weights
                                          [target]
                                    : 0.0f;
                            std::memcpy(
                                weights_blob.data() + 16 +
                                    target * sizeof(float),
                                &weight,
                                sizeof(float));
                        }
                        update_buffer(
                            state.device,
                            gpu_mesh.morph_weights,
                            weights_blob.data(),
                            weights_blob.size());
                        gpu_mesh.morph_weights_version =
                            mesh.morph_weights_version;
                    }
#endif
                    gpu_mesh.transform_version =
                        mesh.transform_version;
                    continue;
                }
                if (gpu_mesh.transform_version == mesh.transform_version) {
                    continue;
                }
                const std::vector<GpuVertex> vertices =
                    transformed_vertices(
                        engine.geometries[item.geometry],
                        mesh);
                update_buffer(
                    state.device,
                    gpu_mesh.vertices,
                    vertices.data(),
                    vertices.size() * sizeof(GpuVertex));
                gpu_mesh.transform_version =
                    mesh.transform_version;
            }
            bool topology_updated = false;
            if (
                scene.mesh_membership_version !=
                synced_mesh_membership_version) {
                if (!SDL_WaitForGPUIdle(state.device)) {
                    gpu_error(
                        "SDL_WaitForGPUIdle topology update");
                }
                const std::uint32_t added_families =
                    scene.material_family_mask &
                    ~synced_material_family_mask;
                if (
                    (added_families & material_family_standard) != 0 &&
                    !state.standard_pipeline) {
                    throw std::runtime_error(
                        "Post-registration Standard material family has no reached pipeline.");
                }
                if (
                    (added_families & material_family_shader) != 0 &&
                    !state.shader_pipeline &&
                    !state.shader_circular_cutout_pipeline) {
                    throw std::runtime_error(
                        "Post-registration shader material family has no reached pipeline.");
                }
                if (
                    (added_families & material_family_grid) != 0 &&
                    !state.grid_pipeline) {
                    throw std::runtime_error(
                        "Post-registration Grid material family has no reached pipeline.");
                }
                upstream::RenderPlan updated_plan =
                    upstream::build_render_plan(scene, engine);
                if (
                    updated_plan.items.size() <
                    render_plan.items.size()) {
                    throw std::runtime_error(
                        "Post-registration mesh removal is unsupported.");
                }
                for (
                    std::size_t index = 0;
                    index < render_plan.items.size();
                    ++index) {
                    if (
                        updated_plan.items[index].mesh.value !=
                        render_plan.items[index].mesh.value) {
                        throw std::runtime_error(
                            "Post-registration mesh insertion must append to the scene.");
                    }
                }
                for (
                    std::size_t index = render_plan.items.size();
                    index < updated_plan.items.size();
                    ++index) {
                    upload_render_item(updated_plan.items[index]);
                }
                render_plan = std::move(updated_plan);
                rebuild_task_draw_lists();
                synced_mesh_membership_version =
                    scene.mesh_membership_version;
                synced_material_family_mask =
                    scene.material_family_mask;
                topology_updated = true;
            }
            update_camera(camera);
            upstream::sort_transparent_draws(
                render_plan.draw_lists.transparent,
                engine,
                camera);
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
            const bool capture_ready =
                frame >= screenshot_frame &&
                !topology_updated;
            const bool capture_frame =
                capture_ready &&
                !screenshot_saved &&
                !screenshot_path.empty();
            const bool capture_ids =
                capture_ready &&
                !id_buffer_saved &&
                !id_buffer_path.empty();
            const bool capture_clusters =
                capture_ready &&
                !cluster_buffer_saved &&
                !cluster_buffer_path.empty();
            const bool capture_diagnostics =
                capture_ready &&
                !diagnostics_saved &&
                !diagnostic_directory.empty();
            const std::array<float, 16> matrix =
                upstream::build_view_projection(
                    camera,
                    static_cast<float>(width) / height);
            const std::array<float, 16> skybox_matrix =
                upstream::build_skybox_view_projection(
                    camera,
                    static_cast<float>(width) / height);
            if (!scene.tasks.empty()) {
                create_frame_graph_textures(
                    state,
                    engine,
                    swapchain_format,
                    width,
                    height);
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    matrix.data(),
                    sizeof(matrix));

                const auto target_texture = [&](
                                                RenderTargetHandle handle,
                                                bool sampled) {
                    if (handle.value >= state.render_targets.size()) {
                        throw std::runtime_error(
                            "Frame graph render target handle is invalid.");
                    }
                    const RenderTargetRecord& record =
                        engine.render_targets[handle.value];
                    if (record.swapchain) return swapchain;
                    const GpuRenderTarget& target =
                        state.render_targets[handle.value];
                    if (!record.has_color) {
                        if (sampled && record.has_depth && target.depth) {
                            return target.depth;
                        }
                        throw std::runtime_error(
                            "Depth-only render target has no color texture.");
                    }
                    return sampled ? target.sampled_color : target.color;
                };
                const auto source_texture =
                    [&](const RenderTextureRef& source) -> SDL_GPUTexture* {
                    if (source.source == RenderTextureSource::render_target) {
                        return target_texture(source.target, true);
                    }
                    if (source.task.value >= engine.frame_tasks.size()) {
                        throw std::runtime_error(
                            "Frame graph source task handle is invalid.");
                    }
                    const FrameTaskRecord& task =
                        engine.frame_tasks[source.task.value];
                    if (task.kind != FrameTaskKind::geometry) {
                        throw std::runtime_error(
                            "Frame graph source task is not geometry.");
                    }
                    if (
                        source.source ==
                        RenderTextureSource::geometry_output) {
                        return target_texture(task.geometry.target, true);
                    }
                    const auto found = std::find_if(
                        task.geometry.attachments.begin(),
                        task.geometry.attachments.end(),
                        [&](const GeometryTextureDescription& description) {
                            return description.type == source.geometry_type;
                        });
                    if (found == task.geometry.attachments.end()) {
                        throw std::runtime_error(
                            "Geometry source attachment was not requested.");
                    }
                    const std::size_t attachment_index =
                        static_cast<std::size_t>(
                            std::distance(
                                task.geometry.attachments.begin(),
                                found));
                    return state.geometry_tasks[source.task.value]
                        .sampled_colors[attachment_index];
                };
                const auto gpu_mesh_index = [&](MeshHandle handle) {
                    for (std::size_t index = 0;
                         index < render_plan.items.size();
                         ++index) {
                        if (
                            render_plan.items[index].mesh.value ==
                            handle.value) {
                            return index;
                        }
                    }
                    return state.meshes.size();
                };
                const auto draw_scene = [&](
                                          SDL_GPURenderPass* task_pass,
                                          SDL_GPUGraphicsPipeline* opaque,
                                          SDL_GPUGraphicsPipeline* double_sided,
                                          SDL_GPUGraphicsPipeline* clockwise_double_sided,
                                          SDL_GPUGraphicsPipeline* transparent,
                                          SDL_GPUGraphicsPipeline* transparent_double_sided,
                                          SDL_GPUGraphicsPipeline* transparent_clockwise_double_sided,
                                          SDL_GPUGraphicsPipeline* standard_opaque,
                                          SDL_GPUGraphicsPipeline* standard_double_sided,
                                          SDL_GPUGraphicsPipeline* standard_transparent,
                                          SDL_GPUGraphicsPipeline* standard_transparent_double_sided,
                                          SDL_GPUGraphicsPipeline* grid_opaque,
                                          SDL_GPUGraphicsPipeline* grid_double_sided,
                                          SDL_GPUGraphicsPipeline* grid_transparent,
                                          SDL_GPUGraphicsPipeline* grid_transparent_double_sided,
                                          SDL_GPUGraphicsPipeline* shader_alpha_card,
                                          SDL_GPUGraphicsPipeline* shader_alpha_card_a2c,
                                          SDL_GPUGraphicsPipeline* shader_circular_cutout,
                                          const std::array<float, 16>& draw_matrix,
                                          const CameraRecord& draw_camera,
                                          const upstream::RenderDrawLists& draw_lists) {
                    bool scene_matrix_bound = true;
                    const auto pipeline_for =
                        [&](upstream::RenderPipelineKind kind) {
                        switch (kind) {
                            case upstream::RenderPipelineKind::pbr_opaque_back:
                                return opaque;
                            case upstream::RenderPipelineKind::pbr_opaque_none:
                                return double_sided;
                            case upstream::RenderPipelineKind::pbr_opaque_none_clockwise:
                                return clockwise_double_sided;
                            case upstream::RenderPipelineKind::pbr_transparent_back:
                                return transparent;
                            case upstream::RenderPipelineKind::pbr_transparent_none:
                                return transparent_double_sided;
                            case upstream::RenderPipelineKind::pbr_transparent_none_clockwise:
                                return transparent_clockwise_double_sided;
                            case upstream::RenderPipelineKind::standard_opaque_back:
                                return standard_opaque;
                            case upstream::RenderPipelineKind::standard_opaque_none:
                                return standard_double_sided;
                            case upstream::RenderPipelineKind::standard_transparent_back:
                                return standard_transparent;
                            case upstream::RenderPipelineKind::standard_transparent_none:
                                return standard_transparent_double_sided;
                            case upstream::RenderPipelineKind::grid_opaque_back:
                                return grid_opaque;
                            case upstream::RenderPipelineKind::grid_opaque_none:
                                return grid_double_sided;
                            case upstream::RenderPipelineKind::grid_transparent_back:
                                return grid_transparent;
                            case upstream::RenderPipelineKind::grid_transparent_none:
                                return grid_transparent_double_sided;
                            case upstream::RenderPipelineKind::shader_alpha_card:
                                return shader_alpha_card;
                            case upstream::RenderPipelineKind::shader_alpha_card_a2c:
                                return shader_alpha_card_a2c;
                            case upstream::RenderPipelineKind::shader_circular_cutout:
                                return shader_circular_cutout;
                        }
                        return static_cast<
                            SDL_GPUGraphicsPipeline*>(nullptr);
                    };
                    const auto draw_list =
                        [&](const upstream::RenderDrawList& list) {
                        SDL_GPUGraphicsPipeline* bound_pipeline =
                            nullptr;
                        for (
                            const upstream::RenderDrawCommand& draw :
                            list.commands) {
                            if (
                                draw.item_index >=
                                state.meshes.size()) {
                                continue;
                            }
                            SDL_GPUGraphicsPipeline* pipeline =
                                pipeline_for(draw.pipeline);
                            if (!pipeline) {
                                throw std::runtime_error(
                                    "Reached secondary render pipeline was not created.");
                            }
                            if (pipeline != bound_pipeline) {
                                SDL_BindGPUGraphicsPipeline(
                                    task_pass,
                                    pipeline);
                                bound_pipeline = pipeline;
                            }
                            const GpuMesh& mesh =
                                state.meshes[draw.item_index];
                            const upstream::RenderItem& draw_item =
                                draw.item;
                            const MaterialRecord* material =
                                draw_item.material.value <
                                        engine.materials.size()
                                    ? &engine.materials[
                                          draw_item.material.value]
                                    : nullptr;
                            const bool standard_bucket =
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::standard;
                            const bool grid_bucket =
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::grid;
                            const bool shader_bucket =
                                draw_item.material_kind ==
                                upstream::RenderMaterialKind::shader;
                            if (shader_bucket) {
                                if (!material) {
                                    throw std::runtime_error(
                                        "Shader draw has an invalid material.");
                                }
                                if (
                                    draw_item.shader_variant ==
                                    ShaderMaterialVariant::alpha_card) {
                                    const CardVertexUniforms vertex_uniforms{{
                                        material->shader_center.x,
                                        material->shader_center.y,
                                        material->shader_angle,
                                        material->shader_depth,
                                    }};
                                    const CardFragmentUniforms
                                        fragment_uniforms{{
                                            material->shader_color.r,
                                            material->shader_color.g,
                                            material->shader_color.b,
                                            material->shader_opacity,
                                        }};
                                    SDL_PushGPUVertexUniformData(
                                        command,
                                        0,
                                        &vertex_uniforms,
                                        sizeof(vertex_uniforms));
                                    SDL_PushGPUFragmentUniformData(
                                        command,
                                        0,
                                        &fragment_uniforms,
                                        sizeof(fragment_uniforms));
                                    scene_matrix_bound = false;
                                } else if (!scene_matrix_bound) {
                                    SDL_PushGPUVertexUniformData(
                                        command,
                                        0,
                                        draw_matrix.data(),
                                        sizeof(draw_matrix));
                                    scene_matrix_bound = true;
                                }
                            } else {
                                if (!scene_matrix_bound) {
                                    SDL_PushGPUVertexUniformData(
                                        command,
                                        0,
                                        draw_matrix.data(),
                                        sizeof(draw_matrix));
                                    scene_matrix_bound = true;
                                }
#if BBLITE_GPU_DEFORMATION
                            if (!grid_bucket) {
                                const DeformationUniforms deformation =
                                    build_deformation_uniforms(
                                        engine.meshes[
                                            draw_item.mesh.value],
                                        engine.geometries[
                                            draw_item.geometry].flat_normals);
                                SDL_PushGPUVertexUniformData(
                                    command,
                                    1,
                                    &deformation,
                                    sizeof(deformation));
                            }
#endif
#if BBLITE_GPU_INSTANCING
                            if (!grid_bucket) {
                                const std::array<float, 16>& parent_world =
                                    engine.meshes[
                                        draw_item.mesh.value]
                                        .instance_parent_matrix;
                                SDL_PushGPUVertexUniformData(
                                    command,
                                    instance_uniform_slot,
                                    parent_world.data(),
                                    sizeof(parent_world));
                            }
#endif
                            if (standard_bucket) {
                                const upstream::StandardUniforms fragment =
                                    upstream::build_standard_uniforms(
                                        scene,
                                        engine,
                                        draw_camera,
                                        draw_item);
                                SDL_PushGPUFragmentUniformData(
                                    command,
                                    0,
                                    &fragment,
                                    sizeof(fragment));
                            } else if (grid_bucket) {
                                const upstream::GridUniforms fragment =
                                    upstream::build_grid_uniforms(
                                        engine,
                                        draw_item);
                                SDL_PushGPUFragmentUniformData(
                                    command,
                                    0,
                                    &fragment,
                                    sizeof(fragment));
                            } else {
                                const upstream::PbrUniforms fragment =
                                    upstream::build_pbr_uniforms(
                                        scene,
                                        engine,
                                        draw_camera,
                                        draw_item);
                                SDL_PushGPUFragmentUniformData(
                                    command,
                                    0,
                                    &fragment,
                                    sizeof(fragment));
                            }
                            }
                            const SDL_GPUBufferBinding index_binding{
                                mesh.indices,
                                0,
                            };
                            if (
                                draw_item.material_kind ==
                                    upstream::RenderMaterialKind::pbr ||
                                standard_bucket) {
                                SDL_GPUTextureSamplerBinding
                                    texture_bindings[
                                        pbr_texture_binding_capacity]{
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.base_color,
                                        mesh.base_color_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.metallic_roughness,
                                        mesh.metallic_roughness_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.normal,
                                        mesh.normal_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.emissive,
                                        mesh.emissive_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        standard_bucket
                                            ? mesh.reflection
                                            : state.environment,
                                        state.sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        state.brdf_lut,
                                        state.background_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.base_color,
                                        mesh.base_color_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.transmission,
                                        mesh.transmission_sampler,
                                    },
                                    SDL_GPUTextureSamplerBinding{
                                        mesh.thickness,
                                        mesh.thickness_sampler,
                                    },
                                    };
                                if (standard_bucket) {
                                    texture_bindings[5] =
                                        material &&
                                            material
                                                ->has_emissive_render_texture
                                            ? SDL_GPUTextureSamplerBinding{
                                                  source_texture(
                                                      material
                                                          ->emissive_render_texture),
                                                  state.depth_sampler,
                                              }
                                            : SDL_GPUTextureSamplerBinding{
                                                  mesh.standard_emissive,
                                                  mesh
                                                      .standard_emissive_sampler,
                                              };
                                } else {
                                    append_material_extension_bindings(
                                        &texture_bindings[
                                            pbr_base_texture_binding_count],
                                        mesh);
                                }
                                SDL_BindGPUFragmentSamplers(
                                    task_pass,
                                    0,
                                    texture_bindings,
                                    standard_bucket
                                        ? 6
                                        : pbr_texture_binding_count);
                            }
                            bind_mesh_vertex_buffers(
                                task_pass,
                                mesh);
                            SDL_BindGPUIndexBuffer(
                                task_pass,
                                &index_binding,
                                SDL_GPU_INDEXELEMENTSIZE_32BIT);
                            SDL_DrawGPUIndexedPrimitives(
                                task_pass,
                                mesh.index_count,
                                mesh.instance_count,
                                0,
                                0,
                                0);
                        }
                    };
                    draw_list(draw_lists.opaque);
                    draw_list(draw_lists.transparent);
                };

                SDL_GPUTexture* capture_texture = nullptr;
                for (const TaskHandle handle : scene.tasks) {
                    if (handle.value >= engine.frame_tasks.size()) {
                        throw std::runtime_error(
                            "Scene frame task handle is invalid.");
                    }
                    const FrameTaskRecord& task =
                        engine.frame_tasks[handle.value];
                    if (task.kind == FrameTaskKind::render) {
                        if (
                            task.render.target.value >=
                            engine.render_targets.size()) {
                            throw std::runtime_error(
                                "Render task target is invalid.");
                        }
                        const RenderTargetRecord& target_record =
                            engine.render_targets[task.render.target.value];
                        GpuRenderTarget& target =
                            state.render_targets[task.render.target.value];
                        const CameraRecord& task_camera =
                            task.render.has_camera &&
                                    task.render.camera.value <
                                        engine.cameras.size()
                                ? engine.cameras[task.render.camera.value]
                                : camera;
                        const float task_aspect =
                            task.render.canvas_size
                                ? static_cast<float>(width) /
                                    static_cast<float>(height)
                                : static_cast<float>(target.width) /
                                    static_cast<float>(target.height);
                        const std::array<float, 16> task_matrix =
                            upstream::build_view_projection(
                                task_camera,
                                task_aspect,
                                !target_record.has_color);
                        SDL_PushGPUVertexUniformData(
                            command,
                            0,
                            task_matrix.data(),
                            sizeof(task_matrix));
                        if (!target_record.has_color) {
                            if (!target_record.has_depth || !target.depth) {
                                throw std::runtime_error(
                                    "Depth-only render task has no depth attachment.");
                            }
                            if (task.render_meshes.empty()) {
                                throw std::runtime_error(
                                    "Depth-only render task requires explicit meshes.");
                            }
                            SDL_GPUDepthStencilTargetInfo task_depth{};
                            task_depth.texture = target.depth;
                            task_depth.clear_depth = 0.0f;
                            task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            task_depth.store_op =
                                target_record.sampled_depth
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_DONT_CARE;
                            task_depth.stencil_load_op =
                                SDL_GPU_LOADOP_DONT_CARE;
                            task_depth.stencil_store_op =
                                SDL_GPU_STOREOP_DONT_CARE;
                            SDL_GPURenderPass* task_pass =
                                SDL_BeginGPURenderPass(
                                    command,
                                    nullptr,
                                    0,
                                    &task_depth);
                            const std::size_t pipeline_index =
                                target_record.samples == 4 ? 1u : 0u;
                            for (int sided_mode = 0;
                                 sided_mode < 2;
                                 ++sided_mode) {
                                SDL_BindGPUGraphicsPipeline(
                                    task_pass,
                                    sided_mode == 0
                                        ? state.depth_only_pipelines[
                                              pipeline_index]
                                        : state
                                              .depth_only_double_sided_pipelines[
                                                  pipeline_index]);
                                for (
                                    const RenderTaskMesh& entry :
                                    task.render_meshes) {
                                    if (
                                        entry.material.value >=
                                        engine.materials.size()) {
                                        throw std::runtime_error(
                                            "Depth task material override is invalid.");
                                    }
                                    const MaterialRecord& material =
                                        engine.materials[
                                            entry.material.value];
                                    if (!material.no_color) {
                                        throw std::runtime_error(
                                            "Depth-only render task requires a no-color material view.");
                                    }
                                    if (
                                        material.double_sided !=
                                        (sided_mode == 1)) {
                                        continue;
                                    }
                                    const std::size_t mesh_index =
                                        gpu_mesh_index(entry.mesh);
                                    if (
                                        mesh_index >=
                                        state.meshes.size()) {
                                        throw std::runtime_error(
                                            "Depth task mesh is not in the scene.");
                                    }
                                    const GpuMesh& mesh =
                                        state.meshes[mesh_index];
                                    const SDL_GPUBufferBinding index_binding{
                                        mesh.indices,
                                        0,
                                    };
                                    bind_mesh_vertex_buffers(
                                        task_pass,
                                        mesh);
                                    SDL_BindGPUIndexBuffer(
                                        task_pass,
                                        &index_binding,
                                        SDL_GPU_INDEXELEMENTSIZE_32BIT);
                                    SDL_DrawGPUIndexedPrimitives(
                                        task_pass,
                                        mesh.index_count,
                                        mesh.instance_count,
                                        0,
                                        0,
                                        0);
                                }
                            }
                            SDL_EndGPURenderPass(task_pass);
                            continue;
                        }
                        SDL_GPUColorTargetInfo target_info{};
                        target_info.texture =
                            target_record.swapchain
                                ? swapchain
                                : target.color;
                        target_info.clear_color = SDL_FColor{
                            task.render.clear_color.r,
                            task.render.clear_color.g,
                            task.render.clear_color.b,
                            task.render.clear_color.a,
                        };
                        target_info.load_op =
                            task.render.clear
                                ? SDL_GPU_LOADOP_CLEAR
                                : SDL_GPU_LOADOP_LOAD;
                        target_info.store_op = SDL_GPU_STOREOP_STORE;
                        SDL_GPUDepthStencilTargetInfo task_depth{};
                        SDL_GPUDepthStencilTargetInfo* task_depth_pointer =
                            nullptr;
                        if (target_record.has_depth && target.depth) {
                            task_depth.texture = target.depth;
                            task_depth.clear_depth = 1.0f;
                            task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                            task_depth.store_op =
                                target_record.sampled_depth
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_DONT_CARE;
                            task_depth.stencil_load_op =
                                SDL_GPU_LOADOP_DONT_CARE;
                            task_depth.stencil_store_op =
                                SDL_GPU_STOREOP_DONT_CARE;
                            task_depth_pointer = &task_depth;
                        }
                        SDL_GPURenderPass* task_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                &target_info,
                                1,
                                task_depth_pointer);
                        upstream::sort_transparent_draws(
                            task_draw_lists[handle.value].transparent,
                            engine,
                            task_camera);
                        draw_scene(
                            task_pass,
                            state.pipeline,
                            state.double_sided_pipeline,
                            state.clockwise_double_sided_pipeline,
                            state.transparent_pipeline,
                            state.transparent_double_sided_pipeline,
                            state
                                .transparent_clockwise_double_sided_pipeline,
                            state.standard_pipeline,
                            state.standard_double_sided_pipeline,
                            state.standard_transparent_pipeline,
                            state
                                .standard_transparent_double_sided_pipeline,
                            state.grid_pipeline,
                            state.grid_double_sided_pipeline,
                            state.grid_transparent_pipeline,
                            state
                                .grid_transparent_double_sided_pipeline,
                            state.shader_pipeline,
                            state.shader_alpha_to_coverage_pipeline,
                            state.shader_circular_cutout_pipeline,
                            task_matrix,
                            task_camera,
                            task_draw_lists[handle.value]);
                        SDL_EndGPURenderPass(task_pass);
                        continue;
                    }
                    if (task.kind == FrameTaskKind::geometry) {
                        GpuGeometryTask& geometry =
                            state.geometry_tasks[handle.value];
                        const SDL_GPUSampleCount task_samples =
                            task_sample_count(
                                state,
                                task.geometry.samples);
                        std::vector<SDL_GPUColorTargetInfo> target_infos;
                        target_infos.reserve(
                            task.geometry.attachments.size() +
                            (task.geometry.target.value != invalid_handle
                                 ? 1u
                                 : 0u));
                        for (
                            std::size_t index = 0;
                            index < task.geometry.attachments.size();
                            ++index) {
                            SDL_GPUColorTargetInfo target_info{};
                            target_info.texture = geometry.colors[index];
                            target_info.clear_color =
                                geometry_clear_color(
                                    task.geometry.attachments[index].type);
                            target_info.load_op = SDL_GPU_LOADOP_CLEAR;
                            target_info.store_op =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_RESOLVE;
                            target_info.resolve_texture =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? nullptr
                                    : geometry.sampled_colors[index];
                            target_infos.push_back(target_info);
                        }
                        if (
                            task.geometry.target.value != invalid_handle) {
                            GpuRenderTarget& output_target =
                                state.render_targets[
                                    task.geometry.target.value];
                            SDL_GPUColorTargetInfo target_info{};
                            target_info.texture = output_target.color;
                            target_info.clear_color = SDL_FColor{
                                task.geometry.target_clear_color.r,
                                task.geometry.target_clear_color.g,
                                task.geometry.target_clear_color.b,
                                task.geometry.target_clear_color.a,
                            };
                            target_info.load_op =
                                task.geometry.clear_target
                                    ? SDL_GPU_LOADOP_CLEAR
                                    : SDL_GPU_LOADOP_LOAD;
                            target_info.store_op =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? SDL_GPU_STOREOP_STORE
                                    : SDL_GPU_STOREOP_RESOLVE;
                            target_info.resolve_texture =
                                task_samples == SDL_GPU_SAMPLECOUNT_1
                                    ? nullptr
                                    : output_target.sampled_color;
                            target_infos.push_back(target_info);
                        }
                        SDL_GPUDepthStencilTargetInfo task_depth{};
                        task_depth.texture = geometry.depth;
                        task_depth.clear_depth = 1.0f;
                        task_depth.load_op = SDL_GPU_LOADOP_CLEAR;
                        task_depth.store_op =
                            SDL_GPU_STOREOP_DONT_CARE;
                        task_depth.stencil_load_op =
                            SDL_GPU_LOADOP_DONT_CARE;
                        task_depth.stencil_store_op =
                            SDL_GPU_STOREOP_DONT_CARE;
                        SDL_GPURenderPass* task_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                target_infos.data(),
                                static_cast<Uint32>(target_infos.size()),
                                &task_depth);
                        SDL_PushGPUVertexUniformData(
                            command,
                            0,
                            matrix.data(),
                            sizeof(matrix));
                        upstream::sort_transparent_draws(
                            task_draw_lists[handle.value].transparent,
                            engine,
                            camera);
                        draw_scene(
                            task_pass,
                            geometry.pipeline,
                            geometry.double_sided_pipeline,
                            geometry.clockwise_double_sided_pipeline,
                            geometry.transparent_pipeline,
                            geometry.transparent_double_sided_pipeline,
                            geometry
                                .transparent_clockwise_double_sided_pipeline,
                            geometry.standard_pipeline,
                            geometry.standard_double_sided_pipeline,
                            geometry.standard_transparent_pipeline,
                            geometry
                                .standard_transparent_double_sided_pipeline,
                            nullptr,
                            nullptr,
                            nullptr,
                            nullptr,
                            nullptr,
                            nullptr,
                            nullptr,
                            matrix,
                            camera,
                            task_draw_lists[handle.value]);
                        SDL_EndGPURenderPass(task_pass);
                        continue;
                    }

                    const CopyTaskOptions& copy = task.copy;
                    const bool filtered_copy =
                        copy.has_viewport &&
                        copy.name.find("-impostor-") !=
                            std::string::npos;
                    if (
                        !copy_task_filter.empty() &&
                        filtered_copy &&
                        copy.name != copy_task_filter) {
                        continue;
                    }
                    const bool force_full_viewport =
                        !copy_task_filter.empty() &&
                        copy.name == copy_task_filter;
                    if (
                        copy.resolve_target.value != invalid_handle &&
                        copy.target.value == invalid_handle) {
                        if (
                            copy.source.source !=
                            RenderTextureSource::render_target) {
                            throw std::runtime_error(
                                "Resolve source must be a render target.");
                        }
                        SDL_GPUColorTargetInfo resolve_info{};
                        resolve_info.texture =
                            target_texture(copy.source.target, false);
                        resolve_info.load_op = SDL_GPU_LOADOP_LOAD;
                        resolve_info.store_op = SDL_GPU_STOREOP_RESOLVE;
                        resolve_info.resolve_texture =
                            target_texture(copy.resolve_target, false);
                        SDL_GPURenderPass* resolve_pass =
                            SDL_BeginGPURenderPass(
                                command,
                                &resolve_info,
                                1,
                                nullptr);
                        SDL_EndGPURenderPass(resolve_pass);
                        continue;
                    }

                    const RenderTargetRecord& target_record =
                        engine.render_targets[copy.target.value];
                    SDL_GPUColorTargetInfo blit_target{};
                    blit_target.texture =
                        target_texture(copy.target, false);
                    blit_target.load_op =
                        copy.has_viewport && !force_full_viewport
                            ? SDL_GPU_LOADOP_LOAD
                            : SDL_GPU_LOADOP_DONT_CARE;
                    blit_target.store_op = SDL_GPU_STOREOP_STORE;
                    SDL_GPURenderPass* blit_pass =
                        SDL_BeginGPURenderPass(
                            command,
                            &blit_target,
                            1,
                            nullptr);
                    SDL_BindGPUGraphicsPipeline(
                        blit_pass,
                        target_record.samples == 4
                            ? state.blit_msaa_pipeline
                            : state.blit_pipeline);
                    if (force_full_viewport || copy.has_viewport) {
#if defined(BBLITE_HAS_GEOMETRY_OUTPUT) && BBLITE_HAS_GEOMETRY_OUTPUT
                        const GpuRenderTarget& target =
                            state.render_targets[copy.target.value];
                        const NormalizedViewport normalized_viewport =
                            force_full_viewport
                                ? NormalizedViewport{}
                                : copy.viewport;
                        const upstream::PixelViewport pixel_viewport =
                            upstream::resolve_copy_viewport(
                                normalized_viewport,
                                target.width,
                                target.height);
                        const SDL_GPUViewport gpu_viewport{
                            static_cast<float>(pixel_viewport.x),
                            static_cast<float>(pixel_viewport.y),
                            static_cast<float>(pixel_viewport.width),
                            static_cast<float>(pixel_viewport.height),
                            0.0f,
                            1.0f,
                        };
                        SDL_SetGPUViewport(
                            blit_pass,
                            &gpu_viewport);
                        const SDL_Rect scissor{
                            pixel_viewport.x,
                            pixel_viewport.y,
                            pixel_viewport.width,
                            pixel_viewport.height,
                        };
                        SDL_SetGPUScissor(blit_pass, &scissor);
#else
                        throw std::runtime_error(
                            "Viewport copy requires geometry-output support.");
#endif
                    }
                    const SDL_GPUTextureSamplerBinding texture_binding{
                        source_texture(copy.source),
                        state.background_sampler,
                    };
                    SDL_BindGPUFragmentSamplers(
                        blit_pass,
                        0,
                        &texture_binding,
                        1);
                    SDL_DrawGPUPrimitives(blit_pass, 3, 1, 0, 0);
                    SDL_EndGPURenderPass(blit_pass);
                    if (target_record.swapchain) {
                        capture_texture = source_texture(copy.source);
                    }
                }
                if (capture_frame) {
                    if (!capture_texture) {
                        throw std::runtime_error(
                            "Frame graph did not present a capture source.");
                    }
                    save_texture_png(
                        state.device,
                        command,
                        capture_texture,
                        swapchain_format,
                        width,
                        height,
                        screenshot_path);
                    screenshot_saved = true;
                } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                    gpu_error("SDL_SubmitGPUCommandBuffer frame graph");
                }
            } else {
            if (capture_frame || transmission_enabled) {
                create_color(
                    state,
                    transmission_enabled
                        ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                        : swapchain_format,
                    width,
                    height);
            }
            if (transmission_enabled) {
                create_transmission_color(
                    state,
                    width,
                    height);
                create_processed_color(
                    state,
                    swapchain_format,
                    width,
                    height);
            }
            create_msaa_color(
                state,
                transmission_enabled
                    ? SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT
                    : swapchain_format,
                width,
                height);
            create_depth(state, width, height);
            SDL_PushGPUVertexUniformData(command, 0, matrix.data(), sizeof(matrix));

            SDL_GPUColorTargetInfo color_info{};
            const bool multisampled =
                state.sample_count != SDL_GPU_SAMPLECOUNT_1;
            color_info.texture =
                multisampled
                    ? state.msaa_color
                    : capture_frame || transmission_enabled
                        ? state.color
                        : swapchain;
            color_info.clear_color = transmission_enabled
                ? SDL_FColor{
                      inverse_image_processed_channel(
                          scene.clear_color.r,
                          scene.environment.exposure,
                          scene.environment.contrast,
                          scene.environment.tone_mapping_enabled),
                      inverse_image_processed_channel(
                          scene.clear_color.g,
                          scene.environment.exposure,
                          scene.environment.contrast,
                          scene.environment.tone_mapping_enabled),
                      inverse_image_processed_channel(
                          scene.clear_color.b,
                          scene.environment.exposure,
                          scene.environment.contrast,
                          scene.environment.tone_mapping_enabled),
                      scene.clear_color.a}
                : SDL_FColor{
                      scene.clear_color.r,
                      scene.clear_color.g,
                      scene.clear_color.b,
                      scene.clear_color.a};
            color_info.load_op = SDL_GPU_LOADOP_CLEAR;
            // Resolve opaque color for transmission sampling while preserving
            // the multisample attachment so transmissive draws can resume it.
            color_info.store_op =
                multisampled
                    ? transmission_enabled
                        ? SDL_GPU_STOREOP_RESOLVE_AND_STORE
                        : SDL_GPU_STOREOP_RESOLVE
                    : SDL_GPU_STOREOP_STORE;
            color_info.resolve_texture =
                multisampled
                    ? capture_frame || transmission_enabled
                        ? state.color
                        : swapchain
                    : nullptr;
            SDL_GPUDepthStencilTargetInfo depth_info{};
            depth_info.texture = state.depth;
            depth_info.clear_depth = 1.0f;
            depth_info.load_op = SDL_GPU_LOADOP_CLEAR;
            depth_info.store_op = SDL_GPU_STOREOP_DONT_CARE;
            if (transmission_enabled) {
                depth_info.store_op = SDL_GPU_STOREOP_STORE;
            }
            depth_info.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
            depth_info.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;
            SDL_GPURenderPass* pass =
                SDL_BeginGPURenderPass(command, &color_info, 1, &depth_info);
            bool transmission_copied = false;
            bool scene_matrix_bound = true;
            const auto draw_skybox = [&] {
                if (!state.skybox.enabled) return;
                const upstream::SkyboxUniforms skybox =
                    upstream::build_skybox_uniforms(
                        scene.environment,
                        transmission_enabled);
                SDL_PushGPUVertexUniformData(
                    command,
                    0,
                    scene.environment.skybox_uses_environment
                        ? skybox_matrix.data()
                        : matrix.data(),
                    sizeof(matrix));
                SDL_BindGPUGraphicsPipeline(pass, state.skybox_pipeline);
                SDL_PushGPUFragmentUniformData(command, 0, &skybox, sizeof(skybox));
                const SDL_GPUBufferBinding vertex_binding{state.skybox.vertices, 0};
                const SDL_GPUBufferBinding index_binding{state.skybox.indices, 0};
                const SDL_GPUTextureSamplerBinding texture_binding{
                    state.skybox.texture,
                    state.background_sampler,
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
#if BBLITE_GPU_MORPH_STORAGE
                const std::array<SDL_GPUBuffer*, 2> morph_storage{
                    state.empty_morph_deltas,
                    state.empty_morph_weights,
                };
                SDL_BindGPUVertexStorageBuffers(
                    pass,
                    0,
                    morph_storage.data(),
                    static_cast<Uint32>(morph_storage.size()));
#endif
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 36, 1, 0, 0, 0);
                scene_matrix_bound = false;
            };
            const auto pipeline_for =
                [&](upstream::RenderPipelineKind kind) {
                switch (kind) {
                    case upstream::RenderPipelineKind::pbr_opaque_back:
                        return state.pipeline;
                    case upstream::RenderPipelineKind::pbr_opaque_none:
                        return state.double_sided_pipeline;
                    case upstream::RenderPipelineKind::pbr_opaque_none_clockwise:
                        return state.clockwise_double_sided_pipeline;
                    case upstream::RenderPipelineKind::pbr_transparent_back:
                        return state.transparent_pipeline;
                    case upstream::RenderPipelineKind::pbr_transparent_none:
                        return state.transparent_double_sided_pipeline;
                    case upstream::RenderPipelineKind::pbr_transparent_none_clockwise:
                        return state
                            .transparent_clockwise_double_sided_pipeline;
                    case upstream::RenderPipelineKind::standard_opaque_back:
                        return state.standard_pipeline;
                    case upstream::RenderPipelineKind::standard_opaque_none:
                        return state.standard_double_sided_pipeline;
                    case upstream::RenderPipelineKind::standard_transparent_back:
                        return state.standard_transparent_pipeline;
                    case upstream::RenderPipelineKind::standard_transparent_none:
                        return state
                            .standard_transparent_double_sided_pipeline;
                    case upstream::RenderPipelineKind::grid_opaque_back:
                        return state.grid_pipeline;
                    case upstream::RenderPipelineKind::grid_opaque_none:
                        return state.grid_double_sided_pipeline;
                    case upstream::RenderPipelineKind::grid_transparent_back:
                        return state.grid_transparent_pipeline;
                    case upstream::RenderPipelineKind::grid_transparent_none:
                        return state
                            .grid_transparent_double_sided_pipeline;
                    case upstream::RenderPipelineKind::shader_alpha_card:
                        return state.shader_pipeline;
                    case upstream::RenderPipelineKind::shader_alpha_card_a2c:
                        return state.shader_alpha_to_coverage_pipeline;
                    case upstream::RenderPipelineKind::shader_circular_cutout:
                        return state.shader_circular_cutout_pipeline;
                }
                return static_cast<
                    SDL_GPUGraphicsPipeline*>(nullptr);
            };
            const auto draw_render_list =
                [&](const upstream::RenderDrawList& list) {
                SDL_GPUGraphicsPipeline* bound_pipeline = nullptr;
                for (
                    const upstream::RenderDrawCommand& draw :
                    list.commands) {
                    if (
                        draw.item_index >=
                        state.meshes.size()) {
                        continue;
                    }
                    SDL_GPUGraphicsPipeline* pipeline =
                        pipeline_for(draw.pipeline);
                    if (!pipeline) {
                        throw std::runtime_error(
                            "Reached render pipeline was not created.");
                    }
                    if (pipeline != bound_pipeline) {
                        SDL_BindGPUGraphicsPipeline(
                            pass,
                            pipeline);
                        bound_pipeline = pipeline;
                    }
                    const upstream::RenderItem& item = draw.item;
                    const GpuMesh& mesh =
                        state.meshes[draw.item_index];
                    const MaterialRecord* material =
                        item.material.value <
                                engine.materials.size()
                            ? &engine.materials[
                                  item.material.value]
                            : nullptr;
                    if (
                        transmission_enabled &&
                        !transmission_copied &&
                        material &&
                        (material->transmission_factor > 0.0f ||
                         !material->transmission_texture.bytes.empty())) {
                        SDL_EndGPURenderPass(pass);
                        SDL_GPUBlitInfo transmission_blit{};
                        transmission_blit.source = SDL_GPUBlitRegion{
                            state.color,
                            0,
                            0,
                            0,
                            0,
                            width,
                            height,
                        };
                        transmission_blit.destination = SDL_GPUBlitRegion{
                            state.transmission_color,
                            0,
                            0,
                            0,
                            0,
                            state.transmission_width,
                            state.transmission_height,
                        };
                        transmission_blit.load_op =
                            SDL_GPU_LOADOP_DONT_CARE;
                        transmission_blit.flip_mode = SDL_FLIP_NONE;
                        transmission_blit.filter = SDL_GPU_FILTER_LINEAR;
                        SDL_BlitGPUTexture(command, &transmission_blit);
                        SDL_GenerateMipmapsForGPUTexture(
                            command,
                            state.transmission_color);
                        color_info.load_op = SDL_GPU_LOADOP_LOAD;
                        color_info.store_op =
                            multisampled
                                ? SDL_GPU_STOREOP_RESOLVE
                                : SDL_GPU_STOREOP_STORE;
                        depth_info.load_op = SDL_GPU_LOADOP_LOAD;
                        pass = SDL_BeginGPURenderPass(
                            command,
                            &color_info,
                            1,
                            &depth_info);
                        SDL_BindGPUGraphicsPipeline(pass, pipeline);
                        bound_pipeline = pipeline;
                        transmission_copied = true;
                    }
                    if (
                        item.material_kind ==
                        upstream::RenderMaterialKind::shader) {
                        if (!material) {
                            throw std::runtime_error(
                                "Shader draw has an invalid material.");
                        }
                        if (
                            item.shader_variant ==
                            ShaderMaterialVariant::alpha_card) {
                            const CardVertexUniforms vertex_uniforms{{
                                material->shader_center.x,
                                material->shader_center.y,
                                material->shader_angle,
                                material->shader_depth,
                            }};
                            const CardFragmentUniforms fragment_uniforms{{
                                material->shader_color.r,
                                material->shader_color.g,
                                material->shader_color.b,
                                material->shader_opacity,
                            }};
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                &vertex_uniforms,
                                sizeof(vertex_uniforms));
                            SDL_PushGPUFragmentUniformData(
                                command,
                                0,
                                &fragment_uniforms,
                                sizeof(fragment_uniforms));
                            scene_matrix_bound = false;
                        } else if (!scene_matrix_bound) {
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                matrix.data(),
                                sizeof(matrix));
                            scene_matrix_bound = true;
                        }
                    } else {
                        if (!scene_matrix_bound) {
                            SDL_PushGPUVertexUniformData(
                                command,
                                0,
                                matrix.data(),
                                sizeof(matrix));
                            scene_matrix_bound = true;
                        }
#if BBLITE_GPU_DEFORMATION
                        if (
                            item.material_kind !=
                            upstream::RenderMaterialKind::grid) {
                            const DeformationUniforms deformation =
                                build_deformation_uniforms(
                                    engine.meshes[
                                        item.mesh.value],
                                    engine.geometries[
                                        item.geometry].flat_normals);
                            SDL_PushGPUVertexUniformData(
                                command,
                                1,
                                &deformation,
                                sizeof(deformation));
                        }
#endif
#if BBLITE_GPU_INSTANCING
                        if (
                            item.material_kind !=
                            upstream::RenderMaterialKind::grid) {
                            const std::array<float, 16>& parent_world =
                                engine.meshes[
                                    item.mesh.value]
                                    .instance_parent_matrix;
                            SDL_PushGPUVertexUniformData(
                                command,
                                instance_uniform_slot,
                                parent_world.data(),
                                sizeof(parent_world));
                        }
#endif
                        if (
                            item.material_kind ==
                            upstream::RenderMaterialKind::standard) {
                            const upstream::StandardUniforms fragment =
                                upstream::build_standard_uniforms(
                                    scene,
                                    engine,
                                    camera,
                                    item);
                            SDL_PushGPUFragmentUniformData(
                                command,
                                0,
                                &fragment,
                                sizeof(fragment));
                        } else if (
                            item.material_kind ==
                            upstream::RenderMaterialKind::grid) {
                            const upstream::GridUniforms fragment =
                                upstream::build_grid_uniforms(
                                    engine,
                                    item);
                            SDL_PushGPUFragmentUniformData(
                                command,
                                0,
                                &fragment,
                                sizeof(fragment));
                        } else {
                            const upstream::PbrUniforms fragment =
                                upstream::build_pbr_uniforms(
                                    scene,
                                    engine,
                                    camera,
                                    item);
                            SDL_PushGPUFragmentUniformData(
                                command,
                                0,
                                &fragment,
                                sizeof(fragment));
                        }
                    }
                    const SDL_GPUBufferBinding index_binding{
                        mesh.indices,
                        0,
                    };
                    bind_mesh_vertex_buffers(
                        pass,
                        mesh);
                    SDL_BindGPUIndexBuffer(
                        pass,
                        &index_binding,
                        SDL_GPU_INDEXELEMENTSIZE_32BIT);
                    if (
                        item.material_kind ==
                            upstream::RenderMaterialKind::pbr ||
                        item.material_kind ==
                            upstream::RenderMaterialKind::standard) {
                        const bool standard =
                            item.material_kind ==
                            upstream::RenderMaterialKind::standard;
                        SDL_GPUTextureSamplerBinding
                            texture_bindings[pbr_texture_binding_capacity]{
                                SDL_GPUTextureSamplerBinding{
                                    mesh.base_color,
                                    mesh.base_color_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    mesh.metallic_roughness,
                                    mesh.metallic_roughness_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    mesh.normal,
                                    mesh.normal_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    mesh.emissive,
                                    mesh.emissive_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    standard
                                        ? mesh.reflection
                                        : state.environment,
                                    state.sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    standard
                                        ? mesh.standard_emissive
                                        : state.brdf_lut,
                                    standard
                                        ? mesh
                                              .standard_emissive_sampler
                                        : state.background_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    transmission_enabled
                                        ? state.transmission_color
                                        : mesh.base_color,
                                    transmission_enabled
                                        ? state.transmission_sampler
                                        : mesh.base_color_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    mesh.transmission,
                                    mesh.transmission_sampler,
                                },
                                SDL_GPUTextureSamplerBinding{
                                    mesh.thickness,
                                    mesh.thickness_sampler,
                                },
                            };
                        if (!standard) {
                            append_material_extension_bindings(
                                &texture_bindings[
                                    pbr_base_texture_binding_count],
                                mesh);
                        }
                        SDL_BindGPUFragmentSamplers(
                            pass,
                            0,
                            texture_bindings,
                            standard ? 6 : pbr_texture_binding_count);
                    }
                    SDL_DrawGPUIndexedPrimitives(
                        pass,
                        mesh.index_count,
                        mesh.instance_count,
                        0,
                        0,
                        0);
                }
            };
            const auto draw_ground = [&] {
                if (!state.background.enabled) return;
                if (!scene_matrix_bound) {
                    SDL_PushGPUVertexUniformData(
                        command,
                        0,
                        matrix.data(),
                        sizeof(matrix));
                }
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
                    state.ground_sampler,
                };
                SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
#if BBLITE_GPU_MORPH_STORAGE
                const std::array<SDL_GPUBuffer*, 2> morph_storage{
                    state.empty_morph_deltas,
                    state.empty_morph_weights,
                };
                SDL_BindGPUVertexStorageBuffers(
                    pass,
                    0,
                    morph_storage.data(),
                    static_cast<Uint32>(morph_storage.size()));
#endif
                SDL_BindGPUIndexBuffer(
                    pass,
                    &index_binding,
                    SDL_GPU_INDEXELEMENTSIZE_32BIT);
                SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                SDL_DrawGPUIndexedPrimitives(pass, 6, 1, 0, 0, 0);
                scene_matrix_bound = true;
            };
            for (const upstream::RenderStage stage : render_plan.stages) {
                switch (stage) {
                    case upstream::RenderStage::skybox:
                        draw_skybox();
                        break;
                    case upstream::RenderStage::opaque:
                        draw_render_list(render_plan.draw_lists.opaque);
                        break;
                    case upstream::RenderStage::transparent:
                        draw_render_list(render_plan.draw_lists.transparent);
                        break;
                    case upstream::RenderStage::ground:
                        draw_ground();
                        break;
                }
            }
            SDL_EndGPURenderPass(pass);
            SDL_GPUTexture* visible_color = state.color;
            if (transmission_enabled) {
                SDL_GPUColorTargetInfo image_processing_target{};
                image_processing_target.texture =
                    state.processed_color;
                image_processing_target.load_op =
                    SDL_GPU_LOADOP_DONT_CARE;
                image_processing_target.store_op =
                    SDL_GPU_STOREOP_STORE;
                SDL_GPURenderPass* image_processing_pass =
                    SDL_BeginGPURenderPass(
                        command,
                        &image_processing_target,
                        1,
                        nullptr);
                SDL_BindGPUGraphicsPipeline(
                    image_processing_pass,
                    state.image_processing_pipeline);
                const ImageProcessingUniforms image_processing{{
                    scene.environment.exposure,
                    scene.environment.contrast,
                    scene.environment.tone_mapping_enabled
                        ? 1.0f
                        : 0.0f,
                    0.0f,
                }};
                SDL_PushGPUFragmentUniformData(
                    command,
                    0,
                    &image_processing,
                    sizeof(image_processing));
                const SDL_GPUTextureSamplerBinding source_binding{
                    state.color,
                    state.background_sampler,
                };
                SDL_BindGPUFragmentSamplers(
                    image_processing_pass,
                    0,
                    &source_binding,
                    1);
                SDL_DrawGPUPrimitives(
                    image_processing_pass,
                    3,
                    1,
                    0,
                    0);
                SDL_EndGPURenderPass(image_processing_pass);
                visible_color = state.processed_color;
            }
            if (capture_frame || transmission_enabled) {
                SDL_GPUBlitInfo blit{};
                blit.source = SDL_GPUBlitRegion{
                    visible_color,
                    0,
                    0,
                    0,
                    0,
                    width,
                    height};
                blit.destination = SDL_GPUBlitRegion{swapchain, 0, 0, 0, 0, width, height};
                blit.load_op = SDL_GPU_LOADOP_DONT_CARE;
                blit.flip_mode = SDL_FLIP_NONE;
                blit.filter = SDL_GPU_FILTER_NEAREST;
                SDL_BlitGPUTexture(command, &blit);
            }
            if (capture_frame) {
                save_texture_png(
                    state.device,
                    command,
                    visible_color,
                    swapchain_format,
                    width,
                    height,
                    screenshot_path);
                screenshot_saved = true;
            } else if (!SDL_SubmitGPUCommandBuffer(command)) {
                gpu_error("SDL_SubmitGPUCommandBuffer");
            }
            }
            if (capture_ids) {
                save_geometry_id_buffer_png(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan.items,
                    engine,
                    id_buffer_path,
                    false);
                id_buffer_saved = true;
            }
            if (capture_clusters) {
                save_geometry_id_buffer_png(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan.items,
                    engine,
                    cluster_buffer_path,
                    true);
                cluster_buffer_saved = true;
            }
            if (capture_diagnostics) {
                save_pbr_diagnostic_buffers(
                    state,
                    width,
                    height,
                    matrix,
                    render_plan.items,
                    scene,
                    engine,
                    camera,
                    diagnostic_directory);
                diagnostics_saved = true;
            }
            const double end = monotonic_milliseconds();
            if (benchmark && frame >= warmup) {
                samples.push_back(end - start);
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
        if (!SDL_WaitForGPUIdle(state.device)) {
            gpu_error("SDL_WaitForGPUIdle");
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
