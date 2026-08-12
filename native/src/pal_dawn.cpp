// Dawn (WebGPU) render backend. Renders through the same pinned Dawn
// commit as the Tint shader compiler so native output shares the
// browser reference's compiler and rasterization stack. Generated
// native WGSL is fed to Dawn directly; there is no offline shader
// compilation in this backend.
//
// Current slice: Standard-material opaque scenes without environment
// features. Unreached paths fail explicitly instead of approximating.

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>

#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN

#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include "pal_gpu_shared.hpp"

#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>
#include <webgpu/webgpu.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

namespace {

std::string view_text(WGPUStringView view) {
    if (!view.data) return {};
    return view.length == WGPU_STRLEN
        ? std::string(view.data)
        : std::string(view.data, view.length);
}

WGPUStringView string_view(const char* text) {
    return WGPUStringView{text, WGPU_STRLEN};
}

[[noreturn]] void dawn_error(const std::string& message) {
    throw std::runtime_error("Dawn backend: " + message);
}

struct DawnMeshBindings {
    WGPUBindGroup scene = nullptr;
    WGPUBindGroup textures = nullptr;
    WGPUBindGroup material = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBindGroup morph = nullptr;
#endif
};

// Vertex uniform bindings in group 1 mirror the SDL vertex uniform
// slots: 0 = viewProjection, 1 = deformation, then the instance
// parent world matrix.
#if BBLITE_GPU_INSTANCING
#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t instance_uniform_binding = 2;
#else
constexpr std::uint32_t instance_uniform_binding = 1;
#endif
#endif

// Texture pair slots 0-3 and 5 mirror the SDL_GPU order; slot 4 is
// the environment or reflection cube bound from shared state. When the
// scene compiles the transmission renderer, the scene-color/
// transmission/thickness trio follows the base six pairs; reached
// material-extension pairs append after that in the
// append_material_extension_bindings order: clearcoat intensity/
// roughness/normal, sheen color/roughness, iridescence intensity/
// thickness. Mesh-owned slots: 0-3 material textures, 4 standard
// emissive, then transmission/thickness, then extension textures.
#if defined(BBLITE_RENDERER_TRANSMISSION)
constexpr std::size_t transmission_texture_slots = 2;
// The bound trio is one pair wider than the mesh-owned slots: the
// scene-color pair rebinds the base color when no grab exists.
constexpr std::size_t transmission_texture_pairs = 3;
#else
constexpr std::size_t transmission_texture_slots = 0;
constexpr std::size_t transmission_texture_pairs = 0;
#endif
constexpr std::size_t material_extension_slots =
    (BBLITE_MATERIAL_CLEARCOAT ? 3 : 0) +
    (BBLITE_MATERIAL_SHEEN ? 2 : 0) +
    (BBLITE_MATERIAL_IRIDESCENCE ? 2 : 0);
constexpr std::size_t material_extension_slot_base =
    5 + transmission_texture_slots;
constexpr std::size_t mesh_texture_slots =
    5 + transmission_texture_slots + material_extension_slots;

struct DawnMesh {
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    std::uint32_t index_count = 0;
    WGPUBuffer material_uniforms = nullptr;
    std::uint64_t material_uniform_size = 0;
    std::array<WGPUTexture, mesh_texture_slots> owned_textures{};
    std::array<WGPUTextureView, mesh_texture_slots> owned_views{};
    std::array<WGPUTextureView, mesh_texture_slots> views{};
    std::array<WGPUSampler, mesh_texture_slots> samplers{};
    // Standard-material `.babylon` reflection cube view, non-owning
    // (points into DawnState::reflection_cube_views).
    WGPUTextureView reflection = nullptr;
    // Alpha-card shader vertex uniforms (center/angle/depth).
    WGPUBuffer shader_vertex_uniforms = nullptr;
    std::uint64_t transform_version = 0;
#if BBLITE_GPU_DEFORMATION
    WGPUBuffer deformation_uniforms = nullptr;
#endif
#if BBLITE_GPU_INSTANCING
    WGPUBuffer instances = nullptr;
    WGPUBuffer instance_uniform = nullptr;
    std::uint32_t instance_count = 1;
#endif
#if BBLITE_GPU_MORPH_STORAGE
    // Owned when the mesh has storage morphs; otherwise these alias
    // the shared empty fallbacks.
    WGPUBuffer morph_deltas = nullptr;
    WGPUBuffer morph_weights = nullptr;
    bool owns_morph_buffers = false;
    std::uint64_t morph_weights_version = 0;
#endif
    std::map<upstream::RenderPipelineKind, DawnMeshBindings> bindings;
};

struct DawnPipeline {
    WGPURenderPipeline pipeline = nullptr;
};

struct DawnState {
    SDL_Window* window = nullptr;
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUSurface surface = nullptr;
    WGPUTextureFormat surface_format = WGPUTextureFormat_BGRA8Unorm;
    WGPUTexture msaa_color = nullptr;
    WGPUTextureView msaa_color_view = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUShaderModule vertex_module = nullptr;
    WGPUShaderModule standard_module = nullptr;
    WGPUShaderModule pbr_module = nullptr;
    WGPUShaderModule grid_vertex_module = nullptr;
    WGPUShaderModule grid_fragment_module = nullptr;
    WGPUShaderModule card_vertex_module = nullptr;
    WGPUShaderModule card_fragment_module = nullptr;
    WGPUShaderModule cutout_vertex_module = nullptr;
    WGPUShaderModule cutout_fragment_module = nullptr;
    WGPUBuffer view_projection = nullptr;
    WGPUTexture white_texture = nullptr;
    WGPUTextureView white_view = nullptr;
    WGPUTexture black_texture = nullptr;
    WGPUTextureView black_view = nullptr;
    WGPUTexture black_cube = nullptr;
    WGPUTextureView black_cube_view = nullptr;
    WGPUTexture normal_flat_texture = nullptr;
    WGPUTextureView normal_flat_view = nullptr;
    std::vector<WGPUTexture> reflection_cubes;
    std::vector<WGPUTextureView> reflection_cube_views;
    WGPUTexture environment_cube = nullptr;
    WGPUTextureView environment_cube_view = nullptr;
    WGPUTexture brdf_texture = nullptr;
    WGPUTextureView brdf_view = nullptr;
    WGPUSampler default_sampler = nullptr;
    WGPUSampler clamp_sampler = nullptr;
    WGPUSampler ground_sampler = nullptr;
    WGPUShaderModule ground_module = nullptr;
    WGPURenderPipeline ground_pipeline = nullptr;
    WGPUBuffer ground_vertices = nullptr;
    WGPUBuffer ground_indices = nullptr;
    WGPUTexture ground_texture = nullptr;
    WGPUTextureView ground_texture_view = nullptr;
    WGPUBuffer ground_uniforms = nullptr;
    WGPUBindGroup ground_scene_group = nullptr;
    WGPUBindGroup ground_texture_group = nullptr;
    WGPUBindGroup ground_material_group = nullptr;
    bool ground_enabled = false;
    WGPUShaderModule skybox_module = nullptr;
    WGPURenderPipeline skybox_pipeline = nullptr;
    WGPUBuffer skybox_vertices = nullptr;
    WGPUBuffer skybox_indices = nullptr;
    WGPUTexture skybox_texture = nullptr;
    WGPUTextureView skybox_texture_view = nullptr;
    WGPUBuffer skybox_matrix = nullptr;
    WGPUBuffer skybox_uniforms = nullptr;
    WGPUBindGroup skybox_scene_group = nullptr;
    WGPUBindGroup skybox_texture_group = nullptr;
    WGPUBindGroup skybox_material_group = nullptr;
    bool skybox_enabled = false;
    WGPUShaderModule mip_module = nullptr;
    WGPUSampler mip_sampler = nullptr;
#if BBLITE_GPU_MORPH_STORAGE
    WGPUBuffer empty_morph_deltas = nullptr;
    WGPUBuffer empty_morph_weights = nullptr;
#endif
    std::map<WGPUTextureFormat, WGPURenderPipeline> mip_pipelines;
    std::map<upstream::RenderPipelineKind, DawnPipeline> pipelines;
    std::vector<DawnMesh> meshes;
    std::string uncaptured_error;

    // Runtime scene mutation rebuilds the mesh set; the GPU must be
    // idle before release (the frame loop waits on submitted work).
    void release_meshes() {
        for (DawnMesh& mesh : meshes) {
            for (std::size_t slot = 0;
                 slot < mesh_texture_slots;
                 ++slot) {
                if (mesh.owned_views[slot]) {
                    wgpuTextureViewRelease(mesh.owned_views[slot]);
                }
                if (mesh.owned_textures[slot]) {
                    wgpuTextureRelease(mesh.owned_textures[slot]);
                }
                if (mesh.samplers[slot]) {
                    wgpuSamplerRelease(mesh.samplers[slot]);
                }
            }
            for (auto& [kind, binding] : mesh.bindings) {
                if (binding.scene) wgpuBindGroupRelease(binding.scene);
                if (binding.textures) {
                    wgpuBindGroupRelease(binding.textures);
                }
                if (binding.material) {
                    wgpuBindGroupRelease(binding.material);
                }
#if BBLITE_GPU_MORPH_STORAGE
                if (binding.morph) wgpuBindGroupRelease(binding.morph);
#endif
            }
            if (mesh.material_uniforms) {
                wgpuBufferRelease(mesh.material_uniforms);
            }
            if (mesh.shader_vertex_uniforms) {
                wgpuBufferRelease(mesh.shader_vertex_uniforms);
            }
#if BBLITE_GPU_DEFORMATION
            if (mesh.deformation_uniforms) {
                wgpuBufferRelease(mesh.deformation_uniforms);
            }
#endif
#if BBLITE_GPU_INSTANCING
            if (mesh.instance_uniform) {
                wgpuBufferRelease(mesh.instance_uniform);
            }
            if (mesh.instances) wgpuBufferRelease(mesh.instances);
#endif
#if BBLITE_GPU_MORPH_STORAGE
            if (mesh.owns_morph_buffers) {
                if (mesh.morph_deltas) {
                    wgpuBufferRelease(mesh.morph_deltas);
                }
                if (mesh.morph_weights) {
                    wgpuBufferRelease(mesh.morph_weights);
                }
            }
#endif
            if (mesh.vertices) wgpuBufferRelease(mesh.vertices);
            if (mesh.indices) wgpuBufferRelease(mesh.indices);
        }
        meshes.clear();
    }

    ~DawnState() {
        for (auto& [format, pipeline] : mip_pipelines) {
            if (pipeline) wgpuRenderPipelineRelease(pipeline);
        }
        if (mip_sampler) wgpuSamplerRelease(mip_sampler);
        if (mip_module) wgpuShaderModuleRelease(mip_module);
        release_meshes();
#if BBLITE_GPU_MORPH_STORAGE
        if (empty_morph_weights) {
            wgpuBufferRelease(empty_morph_weights);
        }
        if (empty_morph_deltas) {
            wgpuBufferRelease(empty_morph_deltas);
        }
#endif
        for (auto& [kind, pipeline] : pipelines) {
            if (pipeline.pipeline) {
                wgpuRenderPipelineRelease(pipeline.pipeline);
            }
        }
        if (skybox_material_group) wgpuBindGroupRelease(skybox_material_group);
        if (skybox_texture_group) wgpuBindGroupRelease(skybox_texture_group);
        if (skybox_scene_group) wgpuBindGroupRelease(skybox_scene_group);
        if (skybox_uniforms) wgpuBufferRelease(skybox_uniforms);
        if (skybox_matrix) wgpuBufferRelease(skybox_matrix);
        if (skybox_texture_view) wgpuTextureViewRelease(skybox_texture_view);
        if (skybox_texture) wgpuTextureRelease(skybox_texture);
        if (skybox_indices) wgpuBufferRelease(skybox_indices);
        if (skybox_vertices) wgpuBufferRelease(skybox_vertices);
        if (skybox_pipeline) wgpuRenderPipelineRelease(skybox_pipeline);
        if (skybox_module) wgpuShaderModuleRelease(skybox_module);
        if (ground_material_group) wgpuBindGroupRelease(ground_material_group);
        if (ground_texture_group) wgpuBindGroupRelease(ground_texture_group);
        if (ground_scene_group) wgpuBindGroupRelease(ground_scene_group);
        if (ground_uniforms) wgpuBufferRelease(ground_uniforms);
        if (ground_texture_view) wgpuTextureViewRelease(ground_texture_view);
        if (ground_texture) wgpuTextureRelease(ground_texture);
        if (ground_indices) wgpuBufferRelease(ground_indices);
        if (ground_vertices) wgpuBufferRelease(ground_vertices);
        if (ground_pipeline) wgpuRenderPipelineRelease(ground_pipeline);
        if (ground_module) wgpuShaderModuleRelease(ground_module);
        if (ground_sampler) wgpuSamplerRelease(ground_sampler);
        if (clamp_sampler) wgpuSamplerRelease(clamp_sampler);
        if (default_sampler) wgpuSamplerRelease(default_sampler);
        if (brdf_view) wgpuTextureViewRelease(brdf_view);
        if (brdf_texture) wgpuTextureRelease(brdf_texture);
        if (environment_cube_view) {
            wgpuTextureViewRelease(environment_cube_view);
        }
        if (environment_cube) wgpuTextureRelease(environment_cube);
        for (WGPUTextureView view : reflection_cube_views) {
            if (view) wgpuTextureViewRelease(view);
        }
        for (WGPUTexture texture : reflection_cubes) {
            if (texture) wgpuTextureRelease(texture);
        }
        if (normal_flat_view) wgpuTextureViewRelease(normal_flat_view);
        if (normal_flat_texture) wgpuTextureRelease(normal_flat_texture);
        if (black_cube_view) wgpuTextureViewRelease(black_cube_view);
        if (black_cube) wgpuTextureRelease(black_cube);
        if (black_view) wgpuTextureViewRelease(black_view);
        if (black_texture) wgpuTextureRelease(black_texture);
        if (white_view) wgpuTextureViewRelease(white_view);
        if (white_texture) wgpuTextureRelease(white_texture);
        if (view_projection) wgpuBufferRelease(view_projection);
        if (cutout_fragment_module) {
            wgpuShaderModuleRelease(cutout_fragment_module);
        }
        if (cutout_vertex_module) {
            wgpuShaderModuleRelease(cutout_vertex_module);
        }
        if (card_fragment_module) {
            wgpuShaderModuleRelease(card_fragment_module);
        }
        if (card_vertex_module) {
            wgpuShaderModuleRelease(card_vertex_module);
        }
        if (grid_fragment_module) {
            wgpuShaderModuleRelease(grid_fragment_module);
        }
        if (grid_vertex_module) {
            wgpuShaderModuleRelease(grid_vertex_module);
        }
        if (pbr_module) wgpuShaderModuleRelease(pbr_module);
        if (standard_module) wgpuShaderModuleRelease(standard_module);
        if (vertex_module) wgpuShaderModuleRelease(vertex_module);
        if (depth_view) wgpuTextureViewRelease(depth_view);
        if (depth) wgpuTextureRelease(depth);
        if (msaa_color_view) wgpuTextureViewRelease(msaa_color_view);
        if (msaa_color) wgpuTextureRelease(msaa_color);
        if (surface) wgpuSurfaceRelease(surface);
        if (queue) wgpuQueueRelease(queue);
        if (device) wgpuDeviceRelease(device);
        if (adapter) wgpuAdapterRelease(adapter);
        if (instance) wgpuInstanceRelease(instance);
        if (window) SDL_DestroyWindow(window);
    }
};

void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo wait_info{};
    wait_info.future = future;
    const WGPUWaitStatus status =
        wgpuInstanceWaitAny(instance, 1, &wait_info, UINT64_MAX);
    if (status != WGPUWaitStatus_Success) {
        dawn_error("wgpuInstanceWaitAny failed.");
    }
}

WGPUShaderModule load_wgsl_module(
    DawnState& state,
    const std::string& base_name) {
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> bytes = read_binary_file(
        join_path(shader_root, base_name + ".native.wgsl"));
    const std::string source(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size());
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source.c_str(), source.size()};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view(base_name.c_str());
    WGPUShaderModule module =
        wgpuDeviceCreateShaderModule(state.device, &descriptor);
    if (!module) {
        dawn_error("wgpuDeviceCreateShaderModule " + base_name);
    }
    return module;
}

WGPUBuffer create_buffer(
    DawnState& state,
    WGPUBufferUsage usage,
    const void* data,
    std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    WGPUBuffer buffer =
        wgpuDeviceCreateBuffer(state.device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer");
    if (data) {
        wgpuQueueWriteBuffer(state.queue, buffer, 0, data, size);
    }
    return buffer;
}

WGPUTexture create_solid_texture(
    DawnState& state,
    const std::vector<std::uint8_t>& texel,
    WGPUTextureFormat format,
    std::uint32_t layers) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {1, 1, layers};
    descriptor.format = format;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture solid");
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, layer};
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = 256;
        layout.rowsPerImage = 1;
        const WGPUExtent3D size{1, 1, 1};
        std::array<std::uint8_t, 256> row{};
        std::memcpy(row.data(), texel.data(), texel.size());
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            row.data(),
            row.size(),
            &layout,
            &size);
    }
    return texture;
}

// Verbatim transcription of the pinned mip generator
// (src/texture/generate-mipmaps.ts BLIT_SHADER): a fullscreen-triangle
// bilinear blit from mip N-1 into mip N.
constexpr const char* mip_blit_wgsl =
    "@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var "
    "s:sampler;\n"
    "struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};\n"
    "@vertex fn vs(@builtin(vertex_index)i:u32)->V{let "
    "p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return "
    "V(vec4f(p,0,1),p*vec2f(.5,-.5)+.5);}\n"
    "@fragment fn fs(v:V)->@location(0)vec4f{return "
    "textureSample(t,s,v.u);}";

WGPURenderPipeline mip_pipeline_for(
    DawnState& state,
    WGPUTextureFormat format) {
    const auto existing = state.mip_pipelines.find(format);
    if (existing != state.mip_pipelines.end()) return existing->second;
    if (!state.mip_module) {
        WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
        wgsl.code = string_view(mip_blit_wgsl);
        WGPUShaderModuleDescriptor descriptor{};
        descriptor.nextInChain = &wgsl.chain;
        descriptor.label = string_view("mip-blit");
        state.mip_module =
            wgpuDeviceCreateShaderModule(state.device, &descriptor);
        // The pinned generator samples with the bilinear sampler:
        // linear filters and WebGPU-default clamp addressing.
        WGPUSamplerDescriptor sampler_descriptor =
            WGPU_SAMPLER_DESCRIPTOR_INIT;
        sampler_descriptor.magFilter = WGPUFilterMode_Linear;
        sampler_descriptor.minFilter = WGPUFilterMode_Linear;
        state.mip_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.mip_module;
    descriptor.vertex.entryPoint = string_view("vs");
    descriptor.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = format;
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.mip_module;
    fragment.entryPoint = string_view("fs");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;
    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("mip blit pipeline creation failed.");
    state.mip_pipelines[format] = pipeline;
    return pipeline;
}

// The pinned generator blits one face at a time for cube textures
// (recordMipmaps' optional layer): views become single-layer 2D.
void generate_mipmaps(
    DawnState& state,
    WGPUTexture texture,
    WGPUTextureFormat format,
    std::uint32_t mip_count,
    std::int32_t face = -1) {
    if (mip_count <= 1) return;
    WGPURenderPipeline pipeline = mip_pipeline_for(state, format);
    WGPUBindGroupLayout layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
    WGPUCommandEncoder encoder =
        wgpuDeviceCreateCommandEncoder(state.device, nullptr);
    for (std::uint32_t level = 1; level < mip_count; ++level) {
        WGPUTextureViewDescriptor source_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        source_descriptor.baseMipLevel = level - 1;
        source_descriptor.mipLevelCount = 1;
        WGPUTextureViewDescriptor target_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        target_descriptor.baseMipLevel = level;
        target_descriptor.mipLevelCount = 1;
        if (face >= 0) {
            source_descriptor.dimension = WGPUTextureViewDimension_2D;
            source_descriptor.baseArrayLayer =
                static_cast<std::uint32_t>(face);
            source_descriptor.arrayLayerCount = 1;
            target_descriptor.dimension = WGPUTextureViewDimension_2D;
            target_descriptor.baseArrayLayer =
                static_cast<std::uint32_t>(face);
            target_descriptor.arrayLayerCount = 1;
        }
        WGPUTextureView source =
            wgpuTextureCreateView(texture, &source_descriptor);
        WGPUTextureView target =
            wgpuTextureCreateView(texture, &target_descriptor);

        std::array<WGPUBindGroupEntry, 2> entries{};
        entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[0].binding = 0;
        entries[0].textureView = source;
        entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        entries[1].binding = 1;
        entries[1].sampler = state.mip_sampler;
        WGPUBindGroupDescriptor bind_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        bind_descriptor.layout = layout;
        bind_descriptor.entryCount = entries.size();
        bind_descriptor.entries = entries.data();
        WGPUBindGroup bind_group =
            wgpuDeviceCreateBindGroup(state.device, &bind_descriptor);

        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = target;
        color_attachment.loadOp = WGPULoadOp_Clear;
        color_attachment.storeOp = WGPUStoreOp_Store;
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        wgpuRenderPassEncoderSetPipeline(pass, pipeline);
        wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_group, 0, nullptr);
        wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        wgpuBindGroupRelease(bind_group);
        wgpuTextureViewRelease(target);
        wgpuTextureViewRelease(source);
    }
    wgpuBindGroupLayoutRelease(layout);
    WGPUCommandBuffer command = wgpuCommandEncoderFinish(encoder, nullptr);
    wgpuQueueSubmit(state.queue, 1, &command);
    wgpuCommandBufferRelease(command);
    wgpuCommandEncoderRelease(encoder);
}

WGPUTexture upload_material_texture(
    DawnState& state,
    const TextureData& texture_data,
    bool srgb,
    const std::array<std::uint8_t, 4>& fallback,
    std::uint32_t& out_mip_count) {
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
                image.rgba.data() +
                static_cast<std::size_t>(y) * row_bytes;
            std::uint8_t* bottom =
                image.rgba.data() +
                static_cast<std::size_t>(image.height - 1 - y) *
                    row_bytes;
            std::memcpy(row.data(), top, row_bytes);
            std::memcpy(top, bottom, row_bytes);
            std::memcpy(bottom, row.data(), row_bytes);
        }
    }
    const std::uint32_t mip_count =
        1u + static_cast<std::uint32_t>(
                 std::floor(
                     std::log2(
                         static_cast<double>(
                             std::max(image.width, image.height)))));
    out_mip_count = mip_count;
    const WGPUTextureFormat format = srgb
        ? WGPUTextureFormat_RGBA8UnormSrgb
        : WGPUTextureFormat_RGBA8Unorm;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding |
        WGPUTextureUsage_RenderAttachment |
        WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    descriptor.format = format;
    descriptor.mipLevelCount = mip_count;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture material");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = static_cast<std::uint32_t>(image.width) * 4;
    layout.rowsPerImage = static_cast<std::uint32_t>(image.height);
    const WGPUExtent3D size{
        static_cast<std::uint32_t>(image.width),
        static_cast<std::uint32_t>(image.height),
        1,
    };
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        image.rgba.data(),
        image.rgba.size(),
        &layout,
        &size);
    generate_mipmaps(state, texture, format, mip_count);
    return texture;
}

// `.babylon` reflection cube, matching the pinned loadCubeTexture:
// rgba8unorm faces with a full GPU-blit mip chain generated per face.
WGPUTexture upload_reflection_cube(
    DawnState& state,
    const std::array<TextureData, 6>& texture_data) {
    std::array<DecodedImage, 6> images;
    int width = 1;
    int height = 1;
    for (std::size_t index = 0; index < images.size(); ++index) {
        if (!texture_data[index].bytes.empty()) {
            images[index] = decode_image(
                ts::ArrayBuffer(texture_data[index].bytes));
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
    const std::uint32_t mip_count =
        1u + static_cast<std::uint32_t>(
                 std::floor(
                     std::log2(
                         static_cast<double>(
                             std::max(width, height)))));
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding |
        WGPUTextureUsage_RenderAttachment |
        WGPUTextureUsage_CopyDst;
    descriptor.size = {
        static_cast<std::uint32_t>(width),
        static_cast<std::uint32_t>(height),
        6,
    };
    descriptor.format = WGPUTextureFormat_RGBA8Unorm;
    descriptor.mipLevelCount = mip_count;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture reflection cube");
    for (std::uint32_t face = 0; face < 6; ++face) {
        const DecodedImage& image = images[face];
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, face};
        WGPUTexelCopyBufferLayout layout{};
        layout.bytesPerRow = static_cast<std::uint32_t>(width) * 4;
        layout.rowsPerImage = static_cast<std::uint32_t>(height);
        const WGPUExtent3D size{
            static_cast<std::uint32_t>(width),
            static_cast<std::uint32_t>(height),
            1,
        };
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            image.rgba.data(),
            image.rgba.size(),
            &layout,
            &size);
        generate_mipmaps(
            state,
            texture,
            WGPUTextureFormat_RGBA8Unorm,
            mip_count,
            static_cast<std::int32_t>(face));
    }
    return texture;
}

WGPUSampler create_texture_sampler(
    DawnState& state,
    const TextureSamplerState& sampler) {
    const auto filter = [](TextureFilter value) {
        return value == TextureFilter::nearest
            ? WGPUFilterMode_Nearest
            : WGPUFilterMode_Linear;
    };
    const auto address = [](TextureAddressMode value) {
        return value == TextureAddressMode::clamp
            ? WGPUAddressMode_ClampToEdge
            : value == TextureAddressMode::mirror
                ? WGPUAddressMode_MirrorRepeat
                : WGPUAddressMode_Repeat;
    };
    WGPUSamplerDescriptor descriptor = WGPU_SAMPLER_DESCRIPTOR_INIT;
    descriptor.minFilter = filter(sampler.min_filter);
    descriptor.magFilter = filter(sampler.mag_filter);
    descriptor.mipmapFilter =
        sampler.mipmap_mode == TextureMipmapMode::nearest
            ? WGPUMipmapFilterMode_Nearest
            : WGPUMipmapFilterMode_Linear;
    descriptor.addressModeU = address(sampler.address_u);
    descriptor.addressModeV = address(sampler.address_v);
    // Mirror the pinned descriptor exactly: W stays at the WebGPU
    // clamp default, and only the noMip path overrides the LOD clamp
    // (gltf-sampler-desc.ts leaves lodMaxClamp at the default 32
    // otherwise).
    if (sampler.max_lod < 32.0f) {
        descriptor.lodMaxClamp = sampler.max_lod;
    }
    descriptor.maxAnisotropy = static_cast<std::uint16_t>(
        std::max(1.0f, sampler.max_anisotropy));
    WGPUSampler result =
        wgpuDeviceCreateSampler(state.device, &descriptor);
    if (!result) dawn_error("wgpuDeviceCreateSampler material");
    return result;
}

// Upload the environment cubemap exactly as the browser does: rgba16f
// faces with pre-baked mips, uploaded unflipped (the SDL_GPU vertical
// reversal is an SDL-only adaptation).
void upload_environment(DawnState& state, const EnvironmentState& environment) {
    const bool has_environment =
        environment.specular_width != 0 &&
        environment.specular_mip_count != 0 &&
        environment.specular_faces.size() >=
            static_cast<std::size_t>(environment.specular_mip_count) * 6;
    if (!has_environment) return;
    const std::uint32_t width = environment.specular_width;
    const std::uint32_t mip_count = environment.specular_mip_count;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, width, 6};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    descriptor.mipLevelCount = mip_count;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture environment");
    for (std::uint32_t mip = 0; mip < mip_count; ++mip) {
        const std::uint32_t mip_width = std::max(width >> mip, 1u);
        for (std::uint32_t face = 0; face < 6; ++face) {
            const TextureData& face_data =
                environment.specular_faces[
                    static_cast<std::size_t>(mip) * 6 + face];
            std::vector<std::uint16_t> half_pixels;
            const std::uint8_t* source_bytes = nullptr;
            std::size_t byte_size = 0;
            if (environment.specular_rgba16f) {
                byte_size = static_cast<std::size_t>(mip_width) *
                    mip_width * 8;
                if (face_data.bytes.size() != byte_size) {
                    throw std::runtime_error(
                        "Compiled HDR cubemap face has an invalid size.");
                }
                source_bytes = face_data.bytes.data();
            } else {
                // RGBD faces are Y-flipped on upload, matching the
                // pinned uploadCubemapRGBD (BJS invertY cubemaps).
                int face_width = 0;
                int face_height = 0;
                const std::vector<float> pixels =
                    decode_rgbd(face_data, face_width, face_height);
                half_pixels.resize(pixels.size());
                const std::size_t row_floats =
                    static_cast<std::size_t>(face_width) * 4;
                for (int row = 0; row < face_height; ++row) {
                    const std::size_t source_row =
                        static_cast<std::size_t>(
                            face_height - row - 1);
                    for (std::size_t column = 0;
                         column < row_floats;
                         ++column) {
                        half_pixels[
                            static_cast<std::size_t>(row) * row_floats +
                            column] = float_to_half(
                            pixels[source_row * row_floats + column]);
                    }
                }
                source_bytes = reinterpret_cast<const std::uint8_t*>(
                    half_pixels.data());
                byte_size =
                    half_pixels.size() * sizeof(std::uint16_t);
            }
            WGPUTexelCopyTextureInfo destination =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            destination.texture = texture;
            destination.mipLevel = mip;
            destination.origin = {0, 0, face};
            WGPUTexelCopyBufferLayout layout{};
            layout.bytesPerRow = mip_width * 8;
            layout.rowsPerImage = mip_width;
            const WGPUExtent3D size{mip_width, mip_width, 1};
            wgpuQueueWriteTexture(
                state.queue,
                &destination,
                source_bytes,
                byte_size,
                &layout,
                &size);
        }
    }
    if (state.environment_cube_view) {
        wgpuTextureViewRelease(state.environment_cube_view);
    }
    if (state.environment_cube) {
        wgpuTextureRelease(state.environment_cube);
    }
    state.environment_cube = texture;
    WGPUTextureViewDescriptor view_descriptor =
        WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
    view_descriptor.dimension = WGPUTextureViewDimension_Cube;
    view_descriptor.arrayLayerCount = 6;
    state.environment_cube_view =
        wgpuTextureCreateView(texture, &view_descriptor);
}

void upload_brdf(DawnState& state, const EnvironmentState& environment) {
    std::vector<std::uint16_t> half_pixels;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    if (environment.brdf_lut_rgba16f) {
        const std::size_t expected_size =
            static_cast<std::size_t>(environment.brdf_lut_width) *
            environment.brdf_lut_width * 8;
        if (
            environment.brdf_lut_width == 0 ||
            environment.brdf_lut.bytes.size() != expected_size) {
            throw std::runtime_error(
                "Compiled BRDF LUT has invalid RGBA16F dimensions.");
        }
        width = height = environment.brdf_lut_width;
        half_pixels.resize(expected_size / 2);
        std::memcpy(
            half_pixels.data(),
            environment.brdf_lut.bytes.data(),
            expected_size);
    } else {
        if (environment.brdf_lut.bytes.empty()) return;
        int lut_width = 0;
        int lut_height = 0;
        const std::vector<float> pixels =
            decode_rgbd(environment.brdf_lut, lut_width, lut_height);
        width = static_cast<std::uint32_t>(lut_width);
        height = static_cast<std::uint32_t>(lut_height);
        half_pixels.reserve(pixels.size());
        for (const float value : pixels) {
            half_pixels.push_back(float_to_half(value));
        }
    }
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {width, height, 1};
    descriptor.format = WGPUTextureFormat_RGBA16Float;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture brdf");
    WGPUTexelCopyTextureInfo destination =
        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    destination.texture = texture;
    WGPUTexelCopyBufferLayout layout{};
    layout.bytesPerRow = width * 8;
    layout.rowsPerImage = height;
    const WGPUExtent3D size{width, height, 1};
    wgpuQueueWriteTexture(
        state.queue,
        &destination,
        half_pixels.data(),
        half_pixels.size() * sizeof(std::uint16_t),
        &layout,
        &size);
    if (state.brdf_view) wgpuTextureViewRelease(state.brdf_view);
    if (state.brdf_texture) wgpuTextureRelease(state.brdf_texture);
    state.brdf_texture = texture;
    state.brdf_view = wgpuTextureCreateView(texture, nullptr);
}

WGPUShaderModule& fragment_module_for(
    DawnState& state,
    bool standard) {
    WGPUShaderModule& module =
        standard ? state.standard_module : state.pbr_module;
    if (!module) {
        module = load_wgsl_module(
            state,
            standard ? "standard.frag" : "pbr.frag");
    }
    return module;
}

#if BBLITE_GPU_DEFORMATION
constexpr std::uint32_t base_vertex_attribute_count = 16;
#else
constexpr std::uint32_t base_vertex_attribute_count = 8;
#endif

// The GpuVertex attribute table shared by mesh, skybox, and ground
// pipelines; deformation appends joints/weights/morph deltas at
// locations 8-15 exactly like the SDL backend.
void fill_base_vertex_attributes(WGPUVertexAttribute* attributes) {
    const auto attribute = [&](
                               std::uint32_t location,
                               WGPUVertexFormat format,
                               std::uint64_t offset) {
        attributes[location] = WGPUVertexAttribute{};
        attributes[location].format = format;
        attributes[location].offset = offset;
        attributes[location].shaderLocation = location;
    };
    attribute(0, WGPUVertexFormat_Float32x3, 0);
    attribute(1, WGPUVertexFormat_Float32x3, 12);
    attribute(2, WGPUVertexFormat_Float32x4, 24);
    attribute(3, WGPUVertexFormat_Float32x2, 40);
    attribute(4, WGPUVertexFormat_Float32x3, 48);
    attribute(5, WGPUVertexFormat_Float32x2, 60);
    attribute(6, WGPUVertexFormat_Float32x4, 68);
    attribute(7, WGPUVertexFormat_Float32x3, 84);
#if BBLITE_GPU_DEFORMATION
    attribute(8, WGPUVertexFormat_Float32x4, 96);
    attribute(9, WGPUVertexFormat_Float32x4, 112);
    attribute(10, WGPUVertexFormat_Float32x3, 128);
    attribute(11, WGPUVertexFormat_Float32x3, 140);
    attribute(12, WGPUVertexFormat_Float32x3, 152);
    attribute(13, WGPUVertexFormat_Float32x3, 164);
    attribute(14, WGPUVertexFormat_Float32x3, 176);
    attribute(15, WGPUVertexFormat_Float32x3, 188);
#endif
}

struct PipelineKindTraits {
    bool standard = false;
    bool transparent = false;
    WGPUCullMode cull = WGPUCullMode_Back;
    WGPUFrontFace front = WGPUFrontFace_CCW;
    bool grid = false;
    bool card = false;
    bool card_a2c = false;
    bool cutout = false;
};

PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind) {
    using Kind = upstream::RenderPipelineKind;
    switch (kind) {
        case Kind::standard_opaque_back:
            return {true, false, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::standard_opaque_none:
            return {true, false, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_back:
            return {false, false, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_none:
            return {false, false, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_opaque_none_clockwise:
            return {false, false, WGPUCullMode_None, WGPUFrontFace_CW};
        case Kind::standard_transparent_back:
            return {true, true, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::standard_transparent_none:
            return {true, true, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_back:
            return {false, true, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_none:
            return {false, true, WGPUCullMode_None, WGPUFrontFace_CCW};
        case Kind::pbr_transparent_none_clockwise:
            return {false, true, WGPUCullMode_None, WGPUFrontFace_CW};
        case Kind::grid_opaque_back:
            return {
                false, false, WGPUCullMode_Back, WGPUFrontFace_CCW,
                true};
        case Kind::grid_opaque_none:
            return {
                false, false, WGPUCullMode_None, WGPUFrontFace_CCW,
                true};
        case Kind::grid_transparent_back:
            return {
                false, true, WGPUCullMode_Back, WGPUFrontFace_CCW,
                true};
        case Kind::grid_transparent_none:
            return {
                false, true, WGPUCullMode_None, WGPUFrontFace_CCW,
                true};
        case Kind::shader_alpha_card: {
            PipelineKindTraits traits;
            traits.cull = WGPUCullMode_None;
            traits.card = true;
            return traits;
        }
        case Kind::shader_alpha_card_a2c: {
            PipelineKindTraits traits;
            traits.cull = WGPUCullMode_None;
            traits.card = true;
            traits.card_a2c = true;
            return traits;
        }
        case Kind::shader_circular_cutout: {
            // Blends like a transparent draw but keeps the opaque
            // stage ordering: LESS_EQUAL depth without writes.
            PipelineKindTraits traits;
            traits.cull = WGPUCullMode_None;
            traits.cutout = true;
            return traits;
        }
        default:
            dawn_error(
                "render pipeline kind " +
                std::to_string(static_cast<int>(kind)) +
                " is not implemented yet.");
    }
}

DawnPipeline& pipeline_for(
    DawnState& state,
    upstream::RenderPipelineKind kind) {
    const auto existing = state.pipelines.find(kind);
    if (existing != state.pipelines.end()) return existing->second;
    const PipelineKindTraits traits = pipeline_traits(kind);

    std::array<WGPUVertexAttribute, base_vertex_attribute_count>
        attributes{};
    fill_base_vertex_attributes(attributes.data());
    std::array<WGPUVertexBufferLayout, 2> vertex_layouts{};
    vertex_layouts[0].stepMode = WGPUVertexStepMode_Vertex;
    vertex_layouts[0].arrayStride = sizeof(GpuVertex);
    vertex_layouts[0].attributeCount = attributes.size();
    vertex_layouts[0].attributes = attributes.data();
#if BBLITE_GPU_INSTANCING
    // Per-instance world-matrix columns at locations 16-19, exactly
    // like the SDL backend's second vertex buffer.
    std::array<WGPUVertexAttribute, 4> instance_attributes{};
    for (std::uint32_t column = 0; column < 4; ++column) {
        instance_attributes[column].format = WGPUVertexFormat_Float32x4;
        instance_attributes[column].offset = column * 16;
        instance_attributes[column].shaderLocation = 16 + column;
    }
    vertex_layouts[1].stepMode = WGPUVertexStepMode_Instance;
    vertex_layouts[1].arrayStride = sizeof(std::array<float, 16>);
    vertex_layouts[1].attributeCount = instance_attributes.size();
    vertex_layouts[1].attributes = instance_attributes.data();
    constexpr std::uint32_t vertex_buffer_count = 2;
#else
    constexpr std::uint32_t vertex_buffer_count = 1;
#endif

    if (traits.grid && !state.grid_vertex_module) {
        state.grid_vertex_module = load_wgsl_module(state, "grid.vert");
        state.grid_fragment_module =
            load_wgsl_module(state, "grid.frag");
    }
    if (traits.card && !state.card_vertex_module) {
        state.card_vertex_module =
            load_wgsl_module(state, "alpha-card.vert");
        state.card_fragment_module =
            load_wgsl_module(state, "alpha-card.frag");
    }
    if (traits.cutout && !state.cutout_vertex_module) {
        state.cutout_vertex_module =
            load_wgsl_module(state, "circular-cutout.vert");
        state.cutout_fragment_module =
            load_wgsl_module(state, "circular-cutout.frag");
    }
    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = traits.grid
        ? state.grid_vertex_module
        : traits.card
            ? state.card_vertex_module
            : traits.cutout
                ? state.cutout_vertex_module
                : state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = vertex_buffer_count;
    descriptor.vertex.buffers = vertex_layouts.data();

    descriptor.primitive.topology =
        WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;

    WGPUDepthStencilState depth_stencil =
        WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled =
        traits.transparent || traits.cutout
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    depth_stencil.depthCompare = traits.transparent || traits.cutout
        ? WGPUCompareFunction_LessEqual
        : WGPUCompareFunction_Less;
    descriptor.depthStencil = &depth_stencil;

    descriptor.multisample.count = 4;
    descriptor.multisample.mask = ~0u;
    descriptor.multisample.alphaToCoverageEnabled = traits.card_a2c;

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.surface_format;
    WGPUBlendState blend{};
    if (traits.transparent || traits.cutout) {
        blend.color.operation = WGPUBlendOperation_Add;
        blend.color.srcFactor = WGPUBlendFactor_SrcAlpha;
        blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        blend.alpha.operation = WGPUBlendOperation_Add;
        blend.alpha.srcFactor = WGPUBlendFactor_One;
        blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = traits.grid
        ? state.grid_fragment_module
        : traits.card
            ? state.card_fragment_module
            : traits.cutout
                ? state.cutout_fragment_module
                : fragment_module_for(state, traits.standard);
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline");
    DawnPipeline& slot = state.pipelines[kind];
    slot.pipeline = pipeline;
    return slot;
}

DawnMeshBindings& bindings_for(
    DawnState& state,
    DawnMesh& mesh,
    upstream::RenderPipelineKind kind) {
    const auto existing = mesh.bindings.find(kind);
    if (existing != mesh.bindings.end()) return existing->second;
    DawnPipeline& pipeline = pipeline_for(state, kind);
    DawnMeshBindings bindings;

    const PipelineKindTraits binding_traits = pipeline_traits(kind);
    // Only the standard/pbr vertex module declares the deformation and
    // instancing uniforms; grid and shader-variant pipelines keep the
    // single vertex uniform (the alpha card replaces the scene matrix
    // with its own center/angle/depth block).
    const bool mesh_vertex_uniforms = !binding_traits.grid &&
        !binding_traits.card && !binding_traits.cutout;
    WGPUBindGroupLayout scene_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 1);
    std::array<WGPUBindGroupEntry, 3> scene_entries{};
    std::uint32_t scene_entry_count = 0;
    scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
    scene_entries[scene_entry_count].binding = 0;
    if (binding_traits.card) {
        scene_entries[scene_entry_count].buffer =
            mesh.shader_vertex_uniforms;
        scene_entries[scene_entry_count].size = 16;
    } else {
        scene_entries[scene_entry_count].buffer = state.view_projection;
        scene_entries[scene_entry_count].size = 64;
    }
    ++scene_entry_count;
#if BBLITE_GPU_DEFORMATION
    if (mesh_vertex_uniforms) {
        scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[scene_entry_count].binding = 1;
        scene_entries[scene_entry_count].buffer =
            mesh.deformation_uniforms;
        scene_entries[scene_entry_count].size =
            sizeof(DeformationUniforms);
        ++scene_entry_count;
    }
#endif
#if BBLITE_GPU_INSTANCING
    if (mesh_vertex_uniforms) {
        scene_entries[scene_entry_count] = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entries[scene_entry_count].binding =
            instance_uniform_binding;
        scene_entries[scene_entry_count].buffer = mesh.instance_uniform;
        scene_entries[scene_entry_count].size = 64;
        ++scene_entry_count;
    }
#endif
    WGPUBindGroupDescriptor scene_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    scene_descriptor.layout = scene_layout;
    scene_descriptor.entryCount = scene_entry_count;
    scene_descriptor.entries = scene_entries.data();
    bindings.scene =
        wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
    wgpuBindGroupLayoutRelease(scene_layout);

#if BBLITE_GPU_MORPH_STORAGE
    {
        WGPUBindGroupLayout morph_layout =
            wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 0);
        std::array<WGPUBindGroupEntry, 2> morph_entries{};
        morph_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        morph_entries[0].binding = 0;
        morph_entries[0].buffer = mesh.morph_deltas;
        morph_entries[0].size = WGPU_WHOLE_SIZE;
        morph_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        morph_entries[1].binding = 1;
        morph_entries[1].buffer = mesh.morph_weights;
        morph_entries[1].size = WGPU_WHOLE_SIZE;
        WGPUBindGroupDescriptor morph_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        morph_descriptor.layout = morph_layout;
        morph_descriptor.entryCount = morph_entries.size();
        morph_descriptor.entries = morph_entries.data();
        bindings.morph =
            wgpuDeviceCreateBindGroup(state.device, &morph_descriptor);
        wgpuBindGroupLayoutRelease(morph_layout);
    }
#endif

    // Fragment texture pairs mirror the SDL_GPU slot order. Standard:
    // base color, specular, opacity, ambient, reflection cube,
    // standard emissive. PBR: base color, metallic-roughness, normal,
    // emissive, environment cube, BRDF LUT.
    constexpr std::size_t max_texture_pairs =
        6 + transmission_texture_pairs + material_extension_slots;
    std::array<WGPUTextureView, max_texture_pairs> views{
        mesh.views[0],
        mesh.views[1],
        mesh.views[2],
        mesh.views[3],
        binding_traits.standard
            ? (mesh.reflection ? mesh.reflection : state.black_cube_view)
            : state.environment_cube_view,
        binding_traits.standard ? mesh.views[4] : state.brdf_view,
    };
    std::array<WGPUSampler, max_texture_pairs> samplers{
        mesh.samplers[0],
        mesh.samplers[1],
        mesh.samplers[2],
        mesh.samplers[3],
        state.default_sampler,
        binding_traits.standard
            ? mesh.samplers[4]
            : state.clamp_sampler,
    };
    // The transmission trio and material-extension pairs append after
    // the base six; only the PBR fragment declares them, so standard
    // pipelines keep six pairs. Without an implemented scene-color
    // grab, the scene-color slot binds the base color exactly like the
    // SDL backend does when transmission is disabled at runtime.
    // GridMaterial and the shader variants sample no textures; their
    // group-2 layouts are empty.
    const bool textureless = binding_traits.grid ||
        binding_traits.card || binding_traits.cutout;
    std::size_t pair = textureless ? 0 : 6;
    if (!binding_traits.standard && !textureless) {
#if defined(BBLITE_RENDERER_TRANSMISSION)
        views[pair] = mesh.views[0];
        samplers[pair] = mesh.samplers[0];
        ++pair;
        views[pair] = mesh.views[5];
        samplers[pair] = mesh.samplers[5];
        ++pair;
        views[pair] = mesh.views[6];
        samplers[pair] = mesh.samplers[6];
        ++pair;
#endif
        for (std::size_t slot = 0;
             slot < material_extension_slots;
             ++slot) {
            views[pair] = mesh.views[material_extension_slot_base + slot];
            samplers[pair] =
                mesh.samplers[material_extension_slot_base + slot];
            ++pair;
        }
    }
    const std::uint32_t pair_count =
        static_cast<std::uint32_t>(pair);
    std::array<WGPUBindGroupEntry, max_texture_pairs * 2>
        texture_entries{};
    for (std::uint32_t slot = 0; slot < pair_count; ++slot) {
        texture_entries[slot * 2] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2].binding = slot * 2;
        texture_entries[slot * 2].textureView = views[slot];
        texture_entries[slot * 2 + 1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2 + 1].binding = slot * 2 + 1;
        texture_entries[slot * 2 + 1].sampler = samplers[slot];
    }
    WGPUBindGroupLayout texture_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 2);
    WGPUBindGroupDescriptor texture_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    texture_descriptor.layout = texture_layout;
    texture_descriptor.entryCount = pair_count * 2;
    texture_descriptor.entries = texture_entries.data();
    bindings.textures =
        wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
    wgpuBindGroupLayoutRelease(texture_layout);

    WGPUBindGroupLayout material_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 3);
    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 0;
    material_entry.buffer = mesh.material_uniforms;
    material_entry.size = mesh.material_uniform_size;
    WGPUBindGroupDescriptor material_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    material_descriptor.layout = material_layout;
    // The circular cutout fragment declares no uniforms at all.
    material_descriptor.entryCount = binding_traits.cutout ? 0 : 1;
    material_descriptor.entries = &material_entry;
    bindings.material =
        wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
    wgpuBindGroupLayoutRelease(material_layout);

    return mesh.bindings.emplace(kind, bindings).first->second;
}

void save_capture_png(
    const std::vector<std::uint8_t>& pixels,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t bytes_per_row,
    bool bgra,
    const std::string& path) {
    SDL_Surface* surface = SDL_CreateSurface(
        static_cast<int>(width),
        static_cast<int>(height),
        bgra ? SDL_PIXELFORMAT_ARGB8888 : SDL_PIXELFORMAT_ABGR8888);
    if (!surface) {
        dawn_error(std::string("SDL_CreateSurface: ") + SDL_GetError());
    }
    for (std::uint32_t row = 0; row < height; ++row) {
        std::memcpy(
            static_cast<std::uint8_t*>(surface->pixels) +
                static_cast<std::size_t>(row) * surface->pitch,
            pixels.data() +
                static_cast<std::size_t>(row) * bytes_per_row,
            static_cast<std::size_t>(width) * 4);
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    if (!saved) {
        dawn_error(std::string("IMG_SavePNG: ") + SDL_GetError());
    }
}

} // namespace

bool run_dawn_engine(Engine& engine) {
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
    if (scene.transmission_enabled) {
        dawn_error("transmission is not implemented yet.");
    }
    if (!scene.tasks.empty()) {
        dawn_error("frame-graph tasks are not implemented yet.");
    }
    const std::string animation_seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    if (!animation_seek.empty()) {
        const float time = std::strtof(animation_seek.c_str(), nullptr);
        for (const auto& seek : scene.animation_seekers) {
            seek(time);
        }
    }
    const std::string background_flag =
        environment_variable("BBLITE_BACKGROUND");
    const bool background_enabled =
        background_flag == "1" ||
        background_flag == "true" ||
        (background_flag.empty() &&
         scene.environment.background_enabled_by_default);
    const bool use_skybox =
        background_enabled && scene.environment.has_skybox;
    const std::string ground_flag = environment_variable("BBLITE_GROUND");
    const bool use_ground =
        scene.environment.has_ground &&
        ground_flag != "0" &&
        ground_flag != "false";
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        dawn_error(std::string("SDL_Init: ") + SDL_GetError());
    }

    DawnState state;
    const bool hidden_test_pass =
        environment_variable("BBLITE_TEST_PASS") == "1";
    state.window = SDL_CreateWindow(
        engine.options.title.c_str(),
        engine.options.width,
        engine.options.height,
        hidden_test_pass
            ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
            : SDL_WINDOW_RESIZABLE);
    if (!state.window) {
        dawn_error(std::string("SDL_CreateWindow: ") + SDL_GetError());
    }

    static const WGPUInstanceFeatureName instance_features[] = {
        WGPUInstanceFeatureName_TimedWaitAny,
    };
    WGPUInstanceDescriptor instance_descriptor =
        WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = instance_features;
    state.instance = wgpuCreateInstance(&instance_descriptor);
    if (!state.instance) dawn_error("wgpuCreateInstance failed.");

    void* hwnd = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_HWND_POINTER,
        nullptr);
    void* hinstance = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER,
        nullptr);
    if (!hwnd) dawn_error("SDL window exposes no Win32 HWND.");
    WGPUSurfaceSourceWindowsHWND surface_source =
        WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
    surface_source.hinstance = hinstance;
    surface_source.hwnd = hwnd;
    WGPUSurfaceDescriptor surface_descriptor{};
    surface_descriptor.nextInChain = &surface_source.chain;
    state.surface =
        wgpuInstanceCreateSurface(state.instance, &surface_descriptor);
    if (!state.surface) dawn_error("wgpuInstanceCreateSurface failed.");

    // Chrome's Dawn compiles HLSL with DXC (dxcompiler.dll and
    // dxil.dll ship beside the browser); enable the same adapter
    // toggle so native shader codegen matches the reference captures.
    static const char* adapter_toggles[] = {"use_dxc"};
    WGPUDawnTogglesDescriptor toggles = WGPU_DAWN_TOGGLES_DESCRIPTOR_INIT;
    toggles.chain.sType = WGPUSType_DawnTogglesDescriptor;
    toggles.enabledToggleCount = 1;
    toggles.enabledToggles = adapter_toggles;
    WGPURequestAdapterOptions adapter_options =
        WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    adapter_options.nextInChain = &toggles.chain;
    adapter_options.powerPreference = WGPUPowerPreference_HighPerformance;
    adapter_options.backendType = WGPUBackendType_D3D12;
    adapter_options.compatibleSurface = state.surface;
    WGPURequestAdapterCallbackInfo adapter_callback =
        WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.callback = [](
                                    WGPURequestAdapterStatus status,
                                    WGPUAdapter adapter,
                                    WGPUStringView message,
                                    void* userdata1,
                                    void*) {
        auto* dawn_state = static_cast<DawnState*>(userdata1);
        if (status == WGPURequestAdapterStatus_Success) {
            dawn_state->adapter = adapter;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    adapter_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuInstanceRequestAdapter(
            state.instance,
            &adapter_options,
            adapter_callback));
    if (!state.adapter) {
        dawn_error("no D3D12 adapter: " + state.uncaptured_error);
    }

    WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
#if BBLITE_GPU_INSTANCING
    // The SDL-specialized WGSL feeds per-instance matrix columns at
    // locations 16-19; the WebGPU default caps attribute locations
    // below 16, so raise the device limit to cover location 19.
    WGPULimits required_limits = WGPU_LIMITS_INIT;
    required_limits.maxVertexAttributes = 20;
    device_descriptor.requiredLimits = &required_limits;
#endif
    device_descriptor.uncapturedErrorCallbackInfo.callback =
        [](
            WGPUDevice const*,
            WGPUErrorType,
            WGPUStringView message,
            void* userdata1,
            void*) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty()) *error = view_text(message);
        };
    device_descriptor.uncapturedErrorCallbackInfo.userdata1 =
        &state.uncaptured_error;
    WGPURequestDeviceCallbackInfo device_callback =
        WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = [](
                                   WGPURequestDeviceStatus status,
                                   WGPUDevice device,
                                   WGPUStringView message,
                                   void* userdata1,
                                   void*) {
        auto* dawn_state = static_cast<DawnState*>(userdata1);
        if (status == WGPURequestDeviceStatus_Success) {
            dawn_state->device = device;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    device_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuAdapterRequestDevice(
            state.adapter,
            &device_descriptor,
            device_callback));
    if (!state.device) {
        dawn_error("device creation failed: " + state.uncaptured_error);
    }
    state.queue = wgpuDeviceGetQueue(state.device);

    const std::uint32_t width =
        static_cast<std::uint32_t>(engine.options.width);
    const std::uint32_t height =
        static_cast<std::uint32_t>(engine.options.height);
    WGPUSurfaceConfiguration surface_configuration =
        WGPU_SURFACE_CONFIGURATION_INIT;
    surface_configuration.device = state.device;
    surface_configuration.format = state.surface_format;
    surface_configuration.usage =
        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    surface_configuration.width = width;
    surface_configuration.height = height;
    surface_configuration.presentMode = WGPUPresentMode_Immediate;
    wgpuSurfaceConfigure(state.surface, &surface_configuration);

    // Shared frame targets: 4x MSAA color resolving into the surface
    // texture, and the browser's depth24plus-stencil8 depth buffer.
    {
        WGPUTextureDescriptor color_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        color_descriptor.usage = WGPUTextureUsage_RenderAttachment;
        color_descriptor.size = {width, height, 1};
        color_descriptor.format = state.surface_format;
        color_descriptor.sampleCount = 4;
        state.msaa_color =
            wgpuDeviceCreateTexture(state.device, &color_descriptor);
        state.msaa_color_view =
            wgpuTextureCreateView(state.msaa_color, nullptr);
        WGPUTextureDescriptor depth_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        depth_descriptor.usage = WGPUTextureUsage_RenderAttachment;
        depth_descriptor.size = {width, height, 1};
        depth_descriptor.format =
            WGPUTextureFormat_Depth24PlusStencil8;
        depth_descriptor.sampleCount = 4;
        state.depth =
            wgpuDeviceCreateTexture(state.device, &depth_descriptor);
        state.depth_view = wgpuTextureCreateView(state.depth, nullptr);
    }

    state.vertex_module = load_wgsl_module(state, "pbr.vert");

    state.view_projection = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        nullptr,
        64);
    state.white_texture = create_solid_texture(
        state,
        {255, 255, 255, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.white_view =
        wgpuTextureCreateView(state.white_texture, nullptr);
    state.black_texture = create_solid_texture(
        state,
        {0, 0, 0, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.black_view =
        wgpuTextureCreateView(state.black_texture, nullptr);
    state.normal_flat_texture = create_solid_texture(
        state,
        {128, 128, 255, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.normal_flat_view =
        wgpuTextureCreateView(state.normal_flat_texture, nullptr);
    const auto cube_view = [&](WGPUTexture texture) {
        WGPUTextureViewDescriptor cube_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        cube_descriptor.dimension = WGPUTextureViewDimension_Cube;
        cube_descriptor.arrayLayerCount = 6;
        return wgpuTextureCreateView(texture, &cube_descriptor);
    };
    state.black_cube = create_solid_texture(
        state,
        {0, 0, 0, 255},
        WGPUTextureFormat_RGBA8Unorm,
        6);
    state.black_cube_view = cube_view(state.black_cube);
    const std::vector<std::uint8_t> zero_rgba16f(8, 0);
    state.environment_cube = create_solid_texture(
        state,
        zero_rgba16f,
        WGPUTextureFormat_RGBA16Float,
        6);
    state.environment_cube_view = cube_view(state.environment_cube);
    state.brdf_texture = create_solid_texture(
        state,
        zero_rgba16f,
        WGPUTextureFormat_RGBA16Float,
        1);
    state.brdf_view =
        wgpuTextureCreateView(state.brdf_texture, nullptr);
    {
        WGPUSamplerDescriptor sampler_descriptor =
            WGPU_SAMPLER_DESCRIPTOR_INIT;
        sampler_descriptor.addressModeU = WGPUAddressMode_Repeat;
        sampler_descriptor.addressModeV = WGPUAddressMode_Repeat;
        sampler_descriptor.addressModeW = WGPUAddressMode_Repeat;
        sampler_descriptor.magFilter = WGPUFilterMode_Linear;
        sampler_descriptor.minFilter = WGPUFilterMode_Linear;
        sampler_descriptor.mipmapFilter = WGPUMipmapFilterMode_Linear;
        state.default_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
        sampler_descriptor.addressModeU = WGPUAddressMode_ClampToEdge;
        sampler_descriptor.addressModeV = WGPUAddressMode_ClampToEdge;
        sampler_descriptor.addressModeW = WGPUAddressMode_ClampToEdge;
        state.clamp_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
        sampler_descriptor.lodMaxClamp = 0.0f;
        state.ground_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
    }
#if BBLITE_GPU_MORPH_STORAGE
    {
        const std::array<float, 1> zero_delta{0.0f};
        state.empty_morph_deltas = create_buffer(
            state,
            WGPUBufferUsage_Storage,
            zero_delta.data(),
            sizeof(zero_delta));
        const std::array<std::uint32_t, 4> zero_header{};
        state.empty_morph_weights = create_buffer(
            state,
            WGPUBufferUsage_Storage,
            zero_header.data(),
            sizeof(zero_header));
    }
#endif
    upload_environment(state, scene.environment);
    upload_brdf(state, scene.environment);
    state.reflection_cubes.reserve(engine.reflection_cubes.size());
    state.reflection_cube_views.reserve(engine.reflection_cubes.size());
    for (const auto& cube : engine.reflection_cubes) {
        WGPUTexture texture = upload_reflection_cube(state, cube);
        state.reflection_cubes.push_back(texture);
        state.reflection_cube_views.push_back(cube_view(texture));
    }

    upstream::RenderPlan render_plan;
    std::uint64_t synced_mesh_membership_version =
        scene.mesh_membership_version;
    const auto rebuild_meshes = [&] {
    render_plan = upstream::build_render_plan(scene, engine);
    for (const upstream::RenderItem& item : render_plan.items) {
        if (
            item.material_kind ==
            upstream::RenderMaterialKind::shader) {
            if (
                item.shader_variant !=
                    ShaderMaterialVariant::alpha_card &&
                item.shader_variant !=
                    ShaderMaterialVariant::circular_cutout) {
                dawn_error(
                    "this shader material variant is not implemented "
                    "yet.");
            }
        } else if (
            item.material_kind !=
                upstream::RenderMaterialKind::standard &&
            item.material_kind != upstream::RenderMaterialKind::pbr &&
            item.material_kind != upstream::RenderMaterialKind::grid) {
            dawn_error(
                "only Standard, PBR, Grid, and shader-variant "
                "materials are implemented yet.");
        }
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        const MeshRecord& mesh_record = engine.meshes[item.mesh.value];
        const std::vector<GpuVertex> vertices =
            transformed_vertices(geometry, mesh_record);
        DawnMesh mesh;
        mesh.vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            vertices.data(),
            vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            geometry.indices.data(),
            geometry.indices.size() * sizeof(std::uint32_t));
        mesh.index_count =
            static_cast<std::uint32_t>(geometry.indices.size());
#if BBLITE_GPU_DEFORMATION
        mesh.deformation_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            sizeof(DeformationUniforms));
#endif
#if BBLITE_GPU_MORPH_STORAGE
        mesh.morph_deltas = state.empty_morph_deltas;
        mesh.morph_weights = state.empty_morph_weights;
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
            mesh.morph_deltas = create_buffer(
                state,
                WGPUBufferUsage_Storage,
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
                        ? mesh_record.morph_storage_weights[target]
                        : 0.0f;
                std::memcpy(
                    weights_blob.data() + 16 +
                        target * sizeof(float),
                    &weight,
                    sizeof(float));
            }
            mesh.morph_weights = create_buffer(
                state,
                WGPUBufferUsage_Storage,
                weights_blob.data(),
                weights_blob.size());
            mesh.morph_weights_version =
                mesh_record.morph_weights_version;
            mesh.owns_morph_buffers = true;
        }
#endif
#if BBLITE_GPU_INSTANCING
        {
            std::vector<std::array<float, 16>> instance_matrices =
                mesh_record.instance_matrices;
            if (instance_matrices.empty()) {
                std::array<float, 16> identity{};
                identity[0] = 1.0f;
                identity[5] = 1.0f;
                identity[10] = 1.0f;
                identity[15] = 1.0f;
                instance_matrices.push_back(identity);
            }
            mesh.instances = create_buffer(
                state,
                WGPUBufferUsage_Vertex,
                instance_matrices.data(),
                instance_matrices.size() *
                    sizeof(instance_matrices.front()));
            mesh.instance_count = static_cast<std::uint32_t>(
                instance_matrices.size());
            mesh.instance_uniform = create_buffer(
                state,
                WGPUBufferUsage_Uniform,
                nullptr,
                64);
        }
#endif
        mesh.material_uniform_size =
            ((item.material_kind ==
                      upstream::RenderMaterialKind::standard
                  ? sizeof(upstream::StandardUniforms)
                  : item.material_kind ==
                          upstream::RenderMaterialKind::grid
                      ? sizeof(upstream::GridUniforms)
                      : item.material_kind ==
                              upstream::RenderMaterialKind::shader
                          ? 16
                          : sizeof(upstream::PbrUniforms)) +
             15) &
            ~15ull;
        mesh.material_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            mesh.material_uniform_size);
        if (
            item.material_kind ==
            upstream::RenderMaterialKind::shader) {
            mesh.shader_vertex_uniforms = create_buffer(
                state,
                WGPUBufferUsage_Uniform,
                nullptr,
                16);
        }
        mesh.transform_version =
            mesh_record.transform_version;

        // Per-slot texture selection mirrors the SDL_GPU backend's
        // material remapping for the Standard and PBR families.
        const bool standard_material =
            item.material_kind == upstream::RenderMaterialKind::standard;
        const TextureData* slot_data[mesh_texture_slots] = {};
        bool slot_srgb[mesh_texture_slots] = {};
        std::array<std::uint8_t, 4>
            slot_fallback[mesh_texture_slots] = {};
        bool has_pbr_emissive_factor = false;
        if (item.material.value < engine.materials.size()) {
            const MaterialRecord& material =
                engine.materials[item.material.value];
            if (
                standard_material &&
                material.reflection_cube <
                    state.reflection_cube_views.size()) {
                mesh.reflection =
                    state.reflection_cube_views[
                        material.reflection_cube];
            }
            slot_data[0] = &material.base_color_texture;
            slot_data[1] = standard_material
                ? &material.specular_texture
                : &material.metallic_roughness_texture;
            slot_data[2] = standard_material
                ? &material.opacity_texture
                : &material.normal_texture;
            slot_data[3] = standard_material
                ? &material.ambient_texture
                : &material.emissive_texture;
            slot_data[4] = standard_material
                ? &material.emissive_texture
                : nullptr;
            has_pbr_emissive_factor =
                material.emissive_factor.r != 0.0f ||
                material.emissive_factor.g != 0.0f ||
                material.emissive_factor.b != 0.0f;
            if (
                !standard_material &&
                (material.transmission_factor > 0.0f ||
                 !material.transmission_texture.bytes.empty())) {
                dawn_error(
                    "transmissive materials are not implemented yet.");
            }
            if (!standard_material) {
#if defined(BBLITE_RENDERER_TRANSMISSION)
                slot_data[5] = &material.transmission_texture;
                slot_data[6] = &material.thickness_texture;
#endif
                std::size_t extension_slot =
                    material_extension_slot_base;
#if BBLITE_MATERIAL_CLEARCOAT
                slot_data[extension_slot++] =
                    &material.clearcoat_texture;
                slot_data[extension_slot++] =
                    &material.clearcoat_roughness_texture;
                slot_data[extension_slot++] =
                    &material.clearcoat_normal_texture;
#endif
#if BBLITE_MATERIAL_SHEEN
                slot_data[extension_slot++] =
                    &material.sheen_color_texture;
                slot_data[extension_slot++] =
                    &material.sheen_roughness_texture;
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
                slot_data[extension_slot++] =
                    &material.iridescence_texture;
                slot_data[extension_slot++] =
                    &material.iridescence_thickness_texture;
#endif
                (void)extension_slot;
            }
        }
        slot_srgb[0] = !standard_material;
        slot_srgb[3] = !standard_material;
        slot_fallback[0] = {255, 255, 255, 255};
        slot_fallback[1] = {255, 255, 255, 255};
        slot_fallback[2] = standard_material
            ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
            : std::array<std::uint8_t, 4>{128, 128, 255, 255};
        slot_fallback[3] = standard_material
            ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
            : has_pbr_emissive_factor
                ? std::array<std::uint8_t, 4>{255, 255, 255, 255}
                : std::array<std::uint8_t, 4>{0, 0, 0, 255};
        slot_fallback[4] = {0, 0, 0, 255};
        {
            // sRGB flags and fallbacks mirror the SDL upload_texture
            // calls for the transmission trio and each extension pair.
#if defined(BBLITE_RENDERER_TRANSMISSION)
            slot_fallback[5] = {255, 255, 255, 255};
            slot_fallback[6] = {255, 255, 255, 255};
#endif
            std::size_t extension_slot = material_extension_slot_base;
#if BBLITE_MATERIAL_CLEARCOAT
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
            slot_fallback[extension_slot++] = {128, 128, 255, 255};
#endif
#if BBLITE_MATERIAL_SHEEN
            slot_srgb[extension_slot] = true;
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
#endif
#if BBLITE_MATERIAL_IRIDESCENCE
            slot_srgb[extension_slot] = true;
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
            slot_srgb[extension_slot] = true;
            slot_fallback[extension_slot++] = {255, 255, 255, 255};
#endif
            (void)extension_slot;
        }
        for (std::size_t slot = 0; slot < mesh_texture_slots; ++slot) {
            const TextureData empty{};
            const TextureData& data =
                slot_data[slot] ? *slot_data[slot] : empty;
            std::uint32_t mip_count = 1;
            mesh.owned_textures[slot] = upload_material_texture(
                state,
                data,
                slot_srgb[slot],
                slot_fallback[slot],
                mip_count);
            mesh.owned_views[slot] = wgpuTextureCreateView(
                mesh.owned_textures[slot],
                nullptr);
            mesh.views[slot] = mesh.owned_views[slot];
            mesh.samplers[slot] = create_texture_sampler(
                state,
                slot_data[slot]
                    ? slot_data[slot]->sampler
                    : TextureSamplerState{});
        }
        state.meshes.push_back(std::move(mesh));
    }
    };
    rebuild_meshes();

    if (use_skybox) {
        state.skybox_module =
            load_wgsl_module(state, "background-skybox.frag");
        const upstream::SkyboxPlan skybox_plan =
            upstream::build_skybox_plan(scene.environment);
        std::array<GpuVertex, 8> skybox_quad{};
        for (std::size_t index = 0; index < skybox_quad.size(); ++index) {
            const ModelVertex& vertex = skybox_plan.vertices[index];
            skybox_quad[index] = GpuVertex{
                {vertex.position.x, vertex.position.y, vertex.position.z},
                {vertex.normal.x, vertex.normal.y, vertex.normal.z},
                {vertex.tangent.x,
                 vertex.tangent.y,
                 vertex.tangent.z,
                 vertex.tangent.w},
                {vertex.uv.x, vertex.uv.y},
                {vertex.local_position.x,
                 vertex.local_position.y,
                 vertex.local_position.z},
                {vertex.uv2.x, vertex.uv2.y},
                {vertex.color.x,
                 vertex.color.y,
                 vertex.color.z,
                 vertex.color.w},
                {vertex.normal.x, vertex.normal.y, vertex.normal.z},
            };
        }
        state.skybox_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            skybox_quad.data(),
            sizeof(skybox_quad));
        state.skybox_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            skybox_plan.indices.data(),
            sizeof(skybox_plan.indices));
        WGPUTextureView skybox_view = nullptr;
        if (scene.environment.skybox_uses_environment) {
            skybox_view = state.environment_cube_view;
        } else {
            const EnvironmentState& environment = scene.environment;
            const TextureData& data = environment.skybox_texture;
            if (
                environment.skybox_width == 0 ||
                environment.skybox_mip_count == 0 ||
                environment.skybox_data_offset >= data.bytes.size()) {
                throw std::runtime_error(
                    "DDS skybox metadata is incomplete.");
            }
            WGPUTextureDescriptor descriptor =
                WGPU_TEXTURE_DESCRIPTOR_INIT;
            descriptor.usage =
                WGPUTextureUsage_TextureBinding |
                WGPUTextureUsage_CopyDst;
            descriptor.size = {
                environment.skybox_width,
                environment.skybox_width,
                6,
            };
            descriptor.format = WGPUTextureFormat_RGBA16Float;
            descriptor.mipLevelCount = environment.skybox_mip_count;
            state.skybox_texture =
                wgpuDeviceCreateTexture(state.device, &descriptor);
            if (!state.skybox_texture) {
                dawn_error("wgpuDeviceCreateTexture DDS skybox");
            }
            std::size_t offset = environment.skybox_data_offset;
            for (std::uint32_t face = 0; face < 6; ++face) {
                for (std::uint32_t mip = 0;
                     mip < environment.skybox_mip_count;
                     ++mip) {
                    const std::uint32_t mip_size =
                        std::max(environment.skybox_width >> mip, 1u);
                    const std::size_t byte_size =
                        static_cast<std::size_t>(mip_size) *
                        mip_size * 8;
                    if (offset + byte_size > data.bytes.size()) {
                        throw std::runtime_error(
                            "DDS skybox payload is truncated.");
                    }
                    WGPUTexelCopyTextureInfo destination =
                        WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
                    destination.texture = state.skybox_texture;
                    destination.mipLevel = mip;
                    destination.origin = {0, 0, face};
                    WGPUTexelCopyBufferLayout layout{};
                    layout.bytesPerRow = mip_size * 8;
                    layout.rowsPerImage = mip_size;
                    const WGPUExtent3D size{mip_size, mip_size, 1};
                    wgpuQueueWriteTexture(
                        state.queue,
                        &destination,
                        data.bytes.data() + offset,
                        byte_size,
                        &layout,
                        &size);
                    offset += byte_size;
                }
            }
            WGPUTextureViewDescriptor view_descriptor =
                WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
            view_descriptor.dimension = WGPUTextureViewDimension_Cube;
            view_descriptor.arrayLayerCount = 6;
            state.skybox_texture_view = wgpuTextureCreateView(
                state.skybox_texture,
                &view_descriptor);
            skybox_view = state.skybox_texture_view;
        }

        std::array<WGPUVertexAttribute, base_vertex_attribute_count>
            attributes{};
        fill_base_vertex_attributes(attributes.data());
        WGPUVertexBufferLayout vertex_layout{};
        vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
        vertex_layout.arrayStride = sizeof(GpuVertex);
        vertex_layout.attributeCount = attributes.size();
        vertex_layout.attributes = attributes.data();
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = 1;
        descriptor.vertex.buffers = &vertex_layout;
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.primitive.cullMode = WGPUCullMode_None;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_False;
        depth_stencil.depthCompare = WGPUCompareFunction_Less;
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = 4;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.surface_format;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.skybox_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.skybox_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.skybox_pipeline) {
            dawn_error("skybox pipeline creation failed.");
        }

        state.skybox_matrix = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            64);
        state.skybox_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::SkyboxUniforms) + 15) & ~15ull);
        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 1);
        WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entry.binding = 0;
        scene_entry.buffer = state.skybox_matrix;
        scene_entry.size = 64;
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = 1;
        scene_descriptor.entries = &scene_entry;
        state.skybox_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        wgpuBindGroupLayoutRelease(scene_layout);
        WGPUBindGroupLayout texture_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 2);
        std::array<WGPUBindGroupEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].textureView = skybox_view;
        texture_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[1].binding = 1;
        texture_entries[1].sampler = state.clamp_sampler;
        WGPUBindGroupDescriptor texture_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_descriptor.layout = texture_layout;
        texture_descriptor.entryCount = texture_entries.size();
        texture_descriptor.entries = texture_entries.data();
        state.skybox_texture_group =
            wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
        wgpuBindGroupLayoutRelease(texture_layout);
        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.skybox_pipeline, 3);
        WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.skybox_uniforms;
        material_entry.size =
            (sizeof(upstream::SkyboxUniforms) + 15) & ~15ull;
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.skybox_material_group =
            wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
        wgpuBindGroupLayoutRelease(material_layout);
        state.skybox_enabled = true;
    }

    if (use_ground) {
        state.ground_module =
            load_wgsl_module(state, "background-ground.frag");
        const upstream::BackgroundPlan background =
            upstream::build_background_plan(scene.environment);
        std::array<GpuVertex, 4> ground_quad{};
        for (std::size_t index = 0; index < ground_quad.size(); ++index) {
            const ModelVertex& vertex = background.vertices[index];
            ground_quad[index] = GpuVertex{
                {vertex.position.x, vertex.position.y, vertex.position.z},
                {vertex.normal.x, vertex.normal.y, vertex.normal.z},
                {vertex.tangent.x,
                 vertex.tangent.y,
                 vertex.tangent.z,
                 vertex.tangent.w},
                {vertex.uv.x, vertex.uv.y},
                {vertex.local_position.x,
                 vertex.local_position.y,
                 vertex.local_position.z},
                {vertex.uv2.x, vertex.uv2.y},
                {vertex.color.x,
                 vertex.color.y,
                 vertex.color.z,
                 vertex.color.w},
                {vertex.normal.x, vertex.normal.y, vertex.normal.z},
            };
        }
        state.ground_vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            ground_quad.data(),
            sizeof(ground_quad));
        state.ground_indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            background.indices.data(),
            sizeof(background.indices));
        std::uint32_t ground_mips = 1;
        state.ground_texture = upload_material_texture(
            state,
            scene.environment.ground_texture,
            false,
            {255, 255, 255, 255},
            ground_mips);
        state.ground_texture_view =
            wgpuTextureCreateView(state.ground_texture, nullptr);

        std::array<WGPUVertexAttribute, base_vertex_attribute_count>
            attributes{};
        fill_base_vertex_attributes(attributes.data());
        WGPUVertexBufferLayout vertex_layout{};
        vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
        vertex_layout.arrayStride = sizeof(GpuVertex);
        vertex_layout.attributeCount = attributes.size();
        vertex_layout.attributes = attributes.data();
        WGPURenderPipelineDescriptor descriptor =
            WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
        descriptor.vertex.module = state.vertex_module;
        descriptor.vertex.entryPoint = string_view("mainVertex");
        descriptor.vertex.bufferCount = 1;
        descriptor.vertex.buffers = &vertex_layout;
        descriptor.primitive.topology =
            WGPUPrimitiveTopology_TriangleList;
        descriptor.primitive.frontFace = WGPUFrontFace_CCW;
        descriptor.primitive.cullMode = WGPUCullMode_Back;
        WGPUDepthStencilState depth_stencil =
            WGPU_DEPTH_STENCIL_STATE_INIT;
        depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
        depth_stencil.depthWriteEnabled = WGPUOptionalBool_False;
        depth_stencil.depthCompare = WGPUCompareFunction_Less;
        descriptor.depthStencil = &depth_stencil;
        descriptor.multisample.count = 4;
        descriptor.multisample.mask = ~0u;
        WGPUColorTargetState color_target =
            WGPU_COLOR_TARGET_STATE_INIT;
        color_target.format = state.surface_format;
        WGPUBlendState blend{};
        blend.color.operation = WGPUBlendOperation_Add;
        blend.color.srcFactor = WGPUBlendFactor_One;
        blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        blend.alpha.operation = WGPUBlendOperation_Add;
        blend.alpha.srcFactor = WGPUBlendFactor_One;
        blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        color_target.blend = &blend;
        WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
        fragment.module = state.ground_module;
        fragment.entryPoint = string_view("mainFragment");
        fragment.targetCount = 1;
        fragment.targets = &color_target;
        descriptor.fragment = &fragment;
        state.ground_pipeline =
            wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
        if (!state.ground_pipeline) {
            dawn_error("ground pipeline creation failed.");
        }

        state.ground_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            (sizeof(upstream::BackgroundUniforms) + 15) & ~15ull);
        WGPUBindGroupLayout scene_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 1);
        WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        scene_entry.binding = 0;
        scene_entry.buffer = state.view_projection;
        scene_entry.size = 64;
        WGPUBindGroupDescriptor scene_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        scene_descriptor.layout = scene_layout;
        scene_descriptor.entryCount = 1;
        scene_descriptor.entries = &scene_entry;
        state.ground_scene_group =
            wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
        wgpuBindGroupLayoutRelease(scene_layout);
        WGPUBindGroupLayout texture_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 2);
        std::array<WGPUBindGroupEntry, 2> texture_entries{};
        texture_entries[0] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[0].binding = 0;
        texture_entries[0].textureView = state.ground_texture_view;
        texture_entries[1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[1].binding = 1;
        texture_entries[1].sampler = state.ground_sampler;
        WGPUBindGroupDescriptor texture_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        texture_descriptor.layout = texture_layout;
        texture_descriptor.entryCount = texture_entries.size();
        texture_descriptor.entries = texture_entries.data();
        state.ground_texture_group =
            wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
        wgpuBindGroupLayoutRelease(texture_layout);
        WGPUBindGroupLayout material_layout =
            wgpuRenderPipelineGetBindGroupLayout(
                state.ground_pipeline, 3);
        WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
        material_entry.binding = 0;
        material_entry.buffer = state.ground_uniforms;
        material_entry.size =
            (sizeof(upstream::BackgroundUniforms) + 15) & ~15ull;
        WGPUBindGroupDescriptor material_descriptor =
            WGPU_BIND_GROUP_DESCRIPTOR_INIT;
        material_descriptor.layout = material_layout;
        material_descriptor.entryCount = 1;
        material_descriptor.entries = &material_entry;
        state.ground_material_group =
            wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
        wgpuBindGroupLayoutRelease(material_layout);
        state.ground_enabled = true;
    }

    CameraRecord fallback_camera;
    CameraRecord& camera =
        scene.camera.value < engine.cameras.size()
            ? engine.cameras[scene.camera.value]
            : fallback_camera;

    const std::string screenshot_path =
        environment_variable("BBLITE_SCREENSHOT");
    const long screenshot_frame = [&] {
        const std::string value =
            environment_variable("BBLITE_SCREENSHOT_FRAME");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();
    const long limit = [&] {
        const std::string value = environment_variable("BBLITE_MAX_FRAMES");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();

    bool screenshot_saved = false;
    bool running = true;
    long frame = 0;
    constexpr long capture_grace_frames = 8;
    while (running &&
           (limit <= 0 || frame < limit ||
            (!screenshot_path.empty() && !screenshot_saved &&
             frame < limit + capture_grace_frames))) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) running = false;
        }
        const float delta_ms =
            scene.fixed_delta_ms > 0.0f ? scene.fixed_delta_ms : 16.0f;
        for (const auto& callback : scene.before_render) {
            callback(delta_ms);
        }
        bool topology_updated = false;
        if (
            scene.mesh_membership_version !=
            synced_mesh_membership_version) {
            // Runtime mesh append: wait for the submitted work, then
            // rebuild the mesh set from a fresh render plan. Capture
            // defers past this frame exactly like the SDL backend.
            WGPUQueueWorkDoneCallbackInfo done_callback =
                WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
            done_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            done_callback.callback = [](
                                         WGPUQueueWorkDoneStatus,
                                         WGPUStringView,
                                         void*,
                                         void*) {};
            wait_for(
                state.instance,
                wgpuQueueOnSubmittedWorkDone(
                    state.queue,
                    done_callback));
            state.release_meshes();
            rebuild_meshes();
            synced_mesh_membership_version =
                scene.mesh_membership_version;
            topology_updated = true;
        }
        upstream::sort_transparent_draws(
            render_plan.draw_lists.transparent,
            engine,
            camera);

        const std::array<float, 16> matrix =
            upstream::build_view_projection(
                camera,
                static_cast<float>(width) / height);
        wgpuQueueWriteBuffer(
            state.queue,
            state.view_projection,
            0,
            matrix.data(),
            sizeof(matrix));
        const auto write_material_uniforms =
            [&](const upstream::RenderDrawList& list) {
                for (const upstream::RenderDrawCommand& draw :
                     list.commands) {
                    DawnMesh& draw_mesh = state.meshes[draw.item_index];
                    const MeshRecord& draw_record =
                        engine.meshes[draw.item.mesh.value];
                    const bool grid_draw =
                        draw.item.material_kind ==
                        upstream::RenderMaterialKind::grid;
                    const bool shader_draw =
                        draw.item.material_kind ==
                        upstream::RenderMaterialKind::shader;
                    // Grid and shader-variant vertex stages own no
                    // deformation or instancing uniforms.
                    const bool mesh_uniform_draw =
                        !grid_draw && !shader_draw;
                    (void)draw_record;
                    (void)mesh_uniform_draw;
                    if (
                        draw_mesh.transform_version !=
                        draw_record.transform_version) {
                        const std::vector<GpuVertex> vertices =
                            transformed_vertices(
                                engine.geometries[draw.item.geometry],
                                draw_record);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            draw_mesh.vertices,
                            0,
                            vertices.data(),
                            vertices.size() * sizeof(GpuVertex));
                        draw_mesh.transform_version =
                            draw_record.transform_version;
                    }
#if BBLITE_GPU_DEFORMATION
                    if (mesh_uniform_draw) {
                        const DeformationUniforms deformation =
                            build_deformation_uniforms(
                                draw_record,
                                engine.geometries[draw.item.geometry]
                                    .flat_normals);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            draw_mesh.deformation_uniforms,
                            0,
                            &deformation,
                            sizeof(deformation));
                    }
#endif
#if BBLITE_GPU_INSTANCING
                    if (mesh_uniform_draw) {
                        wgpuQueueWriteBuffer(
                            state.queue,
                            draw_mesh.instance_uniform,
                            0,
                            draw_record.instance_parent_matrix.data(),
                            64);
                    }
#endif
#if BBLITE_GPU_MORPH_STORAGE
                    if (
                        draw_mesh.owns_morph_buffers &&
                        draw_mesh.morph_weights_version !=
                            draw_record.morph_weights_version) {
                        const std::size_t target_count =
                            engine.geometries[draw.item.geometry]
                                .morph_positions.size();
                        std::vector<float> weights(target_count, 0.0f);
                        for (
                            std::size_t target = 0;
                            target < target_count;
                            ++target) {
                            weights[target] =
                                target <
                                draw_record.morph_storage_weights.size()
                                    ? draw_record
                                          .morph_storage_weights[target]
                                    : 0.0f;
                        }
                        wgpuQueueWriteBuffer(
                            state.queue,
                            draw_mesh.morph_weights,
                            16,
                            weights.data(),
                            weights.size() * sizeof(float));
                        draw_mesh.morph_weights_version =
                            draw_record.morph_weights_version;
                    }
#endif
                    if (
                        draw.item.material_kind ==
                        upstream::RenderMaterialKind::standard) {
                        const upstream::StandardUniforms fragment =
                            upstream::build_standard_uniforms(
                                scene,
                                engine,
                                camera,
                                draw.item);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            state.meshes[draw.item_index]
                                .material_uniforms,
                            0,
                            &fragment,
                            sizeof(fragment));
                    } else if (grid_draw) {
                        const upstream::GridUniforms fragment =
                            upstream::build_grid_uniforms(
                                engine,
                                draw.item);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            state.meshes[draw.item_index]
                                .material_uniforms,
                            0,
                            &fragment,
                            sizeof(fragment));
                    } else if (shader_draw) {
                        if (
                            draw.item.shader_variant ==
                                ShaderMaterialVariant::alpha_card &&
                            draw.item.material.value <
                                engine.materials.size()) {
                            const MaterialRecord& material =
                                engine.materials[
                                    draw.item.material.value];
                            const std::array<float, 4> vertex_block{
                                material.shader_center.x,
                                material.shader_center.y,
                                material.shader_angle,
                                material.shader_depth,
                            };
                            const std::array<float, 4> fragment_block{
                                material.shader_color.r,
                                material.shader_color.g,
                                material.shader_color.b,
                                material.shader_opacity,
                            };
                            wgpuQueueWriteBuffer(
                                state.queue,
                                draw_mesh.shader_vertex_uniforms,
                                0,
                                vertex_block.data(),
                                sizeof(vertex_block));
                            wgpuQueueWriteBuffer(
                                state.queue,
                                draw_mesh.material_uniforms,
                                0,
                                fragment_block.data(),
                                sizeof(fragment_block));
                        }
                        // The circular cutout has no uniforms beyond
                        // the shared scene matrix.
                    } else {
                        const upstream::PbrUniforms fragment =
                            upstream::build_pbr_uniforms(
                                scene,
                                engine,
                                camera,
                                draw.item);
                        wgpuQueueWriteBuffer(
                            state.queue,
                            state.meshes[draw.item_index]
                                .material_uniforms,
                            0,
                            &fragment,
                            sizeof(fragment));
                    }
                }
            };
        write_material_uniforms(render_plan.draw_lists.opaque);
        write_material_uniforms(render_plan.draw_lists.transparent);
        if (state.skybox_enabled) {
            const std::array<float, 16> skybox_view_projection =
                upstream::build_skybox_view_projection(
                    camera,
                    static_cast<float>(width) / height);
            wgpuQueueWriteBuffer(
                state.queue,
                state.skybox_matrix,
                0,
                scene.environment.skybox_uses_environment
                    ? skybox_view_projection.data()
                    : matrix.data(),
                64);
            const upstream::SkyboxUniforms skybox =
                upstream::build_skybox_uniforms(scene.environment, false);
            wgpuQueueWriteBuffer(
                state.queue,
                state.skybox_uniforms,
                0,
                &skybox,
                sizeof(skybox));
        }
        if (state.ground_enabled) {
            const upstream::BackgroundUniforms background =
                upstream::build_background_uniforms(
                    scene.environment,
                    camera);
            wgpuQueueWriteBuffer(
                state.queue,
                state.ground_uniforms,
                0,
                &background,
                sizeof(background));
        }

        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        if (
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            dawn_error("wgpuSurfaceGetCurrentTexture failed.");
        }
        WGPUTextureView surface_view =
            wgpuTextureCreateView(surface_texture.texture, nullptr);

        WGPUCommandEncoder encoder =
            wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = state.msaa_color_view;
        color_attachment.resolveTarget = surface_view;
        color_attachment.loadOp = WGPULoadOp_Clear;
        color_attachment.storeOp = WGPUStoreOp_Discard;
        color_attachment.clearValue = WGPUColor{
            scene.clear_color.r,
            scene.clear_color.g,
            scene.clear_color.b,
            scene.clear_color.a,
        };
        WGPURenderPassDepthStencilAttachment depth_attachment{};
        depth_attachment.view = state.depth_view;
        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
        depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
        depth_attachment.depthClearValue = 1.0f;
        depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
        depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        pass_descriptor.depthStencilAttachment = &depth_attachment;
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        WGPURenderPipeline bound_pipeline = nullptr;
        const auto draw_render_list =
            [&](const upstream::RenderDrawList& list) {
                for (const upstream::RenderDrawCommand& draw :
                     list.commands) {
                    DawnMesh& mesh = state.meshes[draw.item_index];
                    DawnPipeline& pipeline =
                        pipeline_for(state, draw.pipeline);
                    DawnMeshBindings& bindings =
                        bindings_for(state, mesh, draw.pipeline);
                    if (pipeline.pipeline != bound_pipeline) {
                        wgpuRenderPassEncoderSetPipeline(
                            pass, pipeline.pipeline);
                        bound_pipeline = pipeline.pipeline;
                    }
                    wgpuRenderPassEncoderSetBindGroup(
                        pass, 1, bindings.scene, 0, nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        pass, 2, bindings.textures, 0, nullptr);
                    wgpuRenderPassEncoderSetBindGroup(
                        pass, 3, bindings.material, 0, nullptr);
#if BBLITE_GPU_MORPH_STORAGE
                    wgpuRenderPassEncoderSetBindGroup(
                        pass, 0, bindings.morph, 0, nullptr);
#endif
                    wgpuRenderPassEncoderSetVertexBuffer(
                        pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
#if BBLITE_GPU_INSTANCING
                    wgpuRenderPassEncoderSetVertexBuffer(
                        pass, 1, mesh.instances, 0, WGPU_WHOLE_SIZE);
#endif
                    wgpuRenderPassEncoderSetIndexBuffer(
                        pass,
                        mesh.indices,
                        WGPUIndexFormat_Uint32,
                        0,
                        WGPU_WHOLE_SIZE);
                    wgpuRenderPassEncoderDrawIndexed(
                        pass,
                        mesh.index_count,
#if BBLITE_GPU_INSTANCING
                        mesh.instance_count,
#else
                        1,
#endif
                        0,
                        0,
                        0);
                }
            };
        const auto draw_ground = [&] {
            if (!state.ground_enabled) return;
            wgpuRenderPassEncoderSetPipeline(pass, state.ground_pipeline);
            bound_pipeline = state.ground_pipeline;
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.ground_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.ground_texture_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.ground_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, state.ground_vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.ground_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderDrawIndexed(pass, 6, 1, 0, 0, 0);
        };
        const auto draw_skybox = [&] {
            if (!state.skybox_enabled) return;
            wgpuRenderPassEncoderSetPipeline(pass, state.skybox_pipeline);
            bound_pipeline = state.skybox_pipeline;
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, state.skybox_scene_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, state.skybox_texture_group, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, state.skybox_material_group, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, state.skybox_vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                state.skybox_indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderDrawIndexed(pass, 36, 1, 0, 0, 0);
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
                    draw_render_list(
                        render_plan.draw_lists.transparent);
                    break;
                case upstream::RenderStage::ground:
                    draw_ground();
                    break;
            }
        }
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);

        const bool capture_frame =
            frame >= screenshot_frame &&
            !screenshot_saved &&
            !screenshot_path.empty() &&
            !topology_updated;
        WGPUBuffer readback = nullptr;
        const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
        if (capture_frame) {
            WGPUBufferDescriptor readback_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            readback_descriptor.usage =
                WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
            readback_descriptor.size =
                static_cast<std::uint64_t>(bytes_per_row) * height;
            readback =
                wgpuDeviceCreateBuffer(state.device, &readback_descriptor);
            WGPUTexelCopyTextureInfo copy_source =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            copy_source.texture = surface_texture.texture;
            WGPUTexelCopyBufferInfo copy_destination =
                WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            copy_destination.layout.bytesPerRow = bytes_per_row;
            copy_destination.layout.rowsPerImage = height;
            copy_destination.buffer = readback;
            const WGPUExtent3D copy_size{width, height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(
                encoder,
                &copy_source,
                &copy_destination,
                &copy_size);
        }

        WGPUCommandBuffer command =
            wgpuCommandEncoderFinish(encoder, nullptr);
        wgpuQueueSubmit(state.queue, 1, &command);
        wgpuCommandBufferRelease(command);
        wgpuCommandEncoderRelease(encoder);

        if (capture_frame) {
            WGPUBufferMapCallbackInfo map_callback =
                WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            map_callback.callback = [](
                                        WGPUMapAsyncStatus status,
                                        WGPUStringView message,
                                        void* userdata1,
                                        void*) {
                if (status != WGPUMapAsyncStatus_Success) {
                    auto* error = static_cast<std::string*>(userdata1);
                    if (error->empty()) *error = view_text(message);
                }
            };
            map_callback.userdata1 = &state.uncaptured_error;
            wait_for(
                state.instance,
                wgpuBufferMapAsync(
                    readback,
                    WGPUMapMode_Read,
                    0,
                    static_cast<std::size_t>(bytes_per_row) * height,
                    map_callback));
            const void* mapped = wgpuBufferGetConstMappedRange(
                readback,
                0,
                static_cast<std::size_t>(bytes_per_row) * height);
            if (!mapped) dawn_error("buffer map returned no data.");
            std::vector<std::uint8_t> pixels(
                static_cast<const std::uint8_t*>(mapped),
                static_cast<const std::uint8_t*>(mapped) +
                    static_cast<std::size_t>(bytes_per_row) * height);
            wgpuBufferUnmap(readback);
            save_capture_png(
                pixels,
                width,
                height,
                bytes_per_row,
                state.surface_format == WGPUTextureFormat_BGRA8Unorm,
                screenshot_path);
            screenshot_saved = true;
        }
        if (readback) wgpuBufferRelease(readback);

        wgpuSurfacePresent(state.surface);
        wgpuTextureViewRelease(surface_view);
        wgpuTextureRelease(surface_texture.texture);
        wgpuInstanceProcessEvents(state.instance);
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
        ++frame;
    }
    SDL_DestroyWindow(state.window);
    state.window = nullptr;
    return true;
}

} // namespace bbl::pal

#endif
