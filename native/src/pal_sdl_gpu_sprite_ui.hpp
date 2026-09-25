#pragma once

// The SDL_GPU realization of the backend-neutral RmlUi recorder, shared by
// every consumer: the scene renderer, the standalone SpriteRenderer frame
// driver and the Window presenter. The recorder's geometry is premultiplied.
// A single-sample consumer blends each draw directly into its target; the
// scene renderer names a layer sample count, and each segment then renders
// into a transparent RGBA8 layer at that count, resolves, and composites once
// over the target.

#include <bblite/pal_ui.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <type_traits>
#include <unordered_map>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include "RmlUi_SDL_GPU/ShadersCompiledSPV.h"
// The backend-neutral scissor clamp all RmlUi consumers share.
#include "pal_gpu_common.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_gpu_ui.hpp"
#include "pal_sdl_gpu_shared.hpp"
#include "pal_sdl_gpu_ui_backdrop.hpp"
#include "pal_sdl_gpu_ui_filter.hpp"
#include "pal_ui_texture_cache.hpp"

namespace bbl::pal {

/** A layered consumer's transparent layer, recreated when the frame resizes. */
struct SpriteUiSdlLayer {
    SDL_GPUTexture* texture = nullptr;
    SDL_GPUTexture* multisample = nullptr;
    std::uint32_t width = 0;
    std::uint32_t height = 0;

    void release(SDL_GPUDevice* device) noexcept {
        if (multisample)
            SDL_ReleaseGPUTexture(device, multisample);
        if (texture)
            SDL_ReleaseGPUTexture(device, texture);
        *this = {};
    }
};

struct SpriteUiSdlResources {
    UiBackdropSdlResources backdrop;
    UiFilterSdlResources filters;
    // The draws' pipelines, in the target's format or the layer's.
    SDL_GPUGraphicsPipeline* color_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* texture_pipeline = nullptr;
    // A layered consumer's single-sample texture pipeline in the target's
    // format; a direct consumer's `texture_pipeline` already is that one.
    SDL_GPUGraphicsPipeline* composite_pipeline = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* nearest_sampler = nullptr;
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    SpriteUiSdlLayer layer;
    std::unordered_map<std::uint64_t, UiCachedTexture<SDL_GPUTexture*>> textures;
    std::uint32_t vertex_capacity = 0;
    std::uint32_t index_capacity = 0;
};

/** The single-sample texture pipeline in the target's format. */
inline SDL_GPUGraphicsPipeline* sprite_ui_sdl_gpu_target_pipeline(const SpriteUiSdlResources& ui) {
    return ui.composite_pipeline ? ui.composite_pipeline : ui.texture_pipeline;
}

struct SpriteUiSdlCpuSample {
    double resources_ms = 0, geometry_upload_ms = 0, texture_upload_ms = 0;
    double upload_cleanup_ms = 0, record_ms = 0;
    std::size_t geometry_buffers_created = 0, pipelines_created = 0;
    std::size_t textures_created = 0, textures_released = 0, texture_bytes = 0;
    std::size_t vertex_bytes = 0, index_bytes = 0, draws = 0, segments = 0;
};

enum class SpriteUiSdlShader {
    color_fragment,
    texture_fragment,
    vertex,
};

inline OwnedSdlShader create_sprite_ui_sdl_gpu_shader(SDL_GPUDevice* device,
                                                      SpriteUiSdlShader shader_kind) {
    const unsigned char* spirv = nullptr;
    std::size_t spirv_size = 0;
    const unsigned char* dxil = nullptr;
    std::size_t dxil_size = 0;
    const unsigned char* msl = nullptr;
    std::size_t msl_size = 0;
    SDL_GPUShaderStage stage = SDL_GPU_SHADERSTAGE_FRAGMENT;
    Uint32 samplers = 0;
    Uint32 uniforms = 0;
    switch (shader_kind) {
    case SpriteUiSdlShader::color_fragment:
        spirv = shader_frag_color_spirv;
        spirv_size = sizeof(shader_frag_color_spirv);
        dxil = shader_frag_color_dxil;
        dxil_size = sizeof(shader_frag_color_dxil);
        msl = shader_frag_color_msl;
        msl_size = sizeof(shader_frag_color_msl);
        break;
    case SpriteUiSdlShader::texture_fragment:
        spirv = shader_frag_texture_spirv;
        spirv_size = sizeof(shader_frag_texture_spirv);
        dxil = shader_frag_texture_dxil;
        dxil_size = sizeof(shader_frag_texture_dxil);
        msl = shader_frag_texture_msl;
        msl_size = sizeof(shader_frag_texture_msl);
        samplers = 1;
        break;
    case SpriteUiSdlShader::vertex:
        spirv = shader_vert_spirv;
        spirv_size = sizeof(shader_vert_spirv);
        dxil = shader_vert_dxil;
        dxil_size = sizeof(shader_vert_dxil);
        msl = shader_vert_msl;
        msl_size = sizeof(shader_vert_msl);
        stage = SDL_GPU_SHADERSTAGE_VERTEX;
        uniforms = 2;
        break;
    }

    SDL_GPUShaderFormat format = SDL_GPU_SHADERFORMAT_INVALID;
    const void* data = nullptr;
    std::size_t size = 0;
    const char* entrypoint = nullptr;
    const SDL_GPUShaderFormat supported = SDL_GetGPUShaderFormats(device);
    if (supported & SDL_GPU_SHADERFORMAT_SPIRV) {
        format = SDL_GPU_SHADERFORMAT_SPIRV;
        data = spirv;
        size = spirv_size;
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_DXIL) {
        format = SDL_GPU_SHADERFORMAT_DXIL;
        data = dxil;
        size = dxil_size;
        entrypoint = "main";
    } else if (supported & SDL_GPU_SHADERFORMAT_MSL) {
        format = SDL_GPU_SHADERFORMAT_MSL;
        data = msl;
        size = msl_size;
        entrypoint = "main0";
    } else {
        gpu_error("No supported SDL_GPU UI shader format");
    }
    SDL_GPUShaderCreateInfo info{};
    info.code = static_cast<const Uint8*>(data);
    info.code_size = size;
    info.entrypoint = entrypoint;
    info.format = format;
    info.stage = stage;
    info.num_samplers = samplers;
    info.num_uniform_buffers = uniforms;
    SDL_GPUShader* shader = SDL_CreateGPUShader(device, &info);
    if (!shader)
        gpu_error("SDL_CreateGPUShader UI");
    return {shader, {device}};
}

inline SDL_GPUGraphicsPipeline*
create_sprite_ui_sdl_gpu_pipeline(SDL_GPUDevice* device, const OwnedSdlShader& vertex,
                                  SDL_GPUShader* fragment, SDL_GPUTextureFormat format,
                                  SDL_GPUSampleCount samples, bool additive = false) {
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    target.blend_state.enable_blend = true;
    target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    target.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    target.blend_state.dst_color_blendfactor =
        additive ? SDL_GPU_BLENDFACTOR_ONE : SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    target.blend_state.dst_alpha_blendfactor =
        additive ? SDL_GPU_BLENDFACTOR_ONE : SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;

    const std::array<SDL_GPUVertexAttribute, 3> attributes{
        SDL_GPUVertexAttribute{0, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2,
                               static_cast<Uint32>(offsetof(UiRenderVertex, x))},
        SDL_GPUVertexAttribute{1, 0, SDL_GPU_VERTEXELEMENTFORMAT_UBYTE4_NORM,
                               static_cast<Uint32>(offsetof(UiRenderVertex, red))},
        SDL_GPUVertexAttribute{2, 0, SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2,
                               static_cast<Uint32>(offsetof(UiRenderVertex, u))},
    };
    const SDL_GPUVertexBufferDescription vertex_buffer{0, sizeof(UiRenderVertex),
                                                       SDL_GPU_VERTEXINPUTRATE_VERTEX, 0};
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex.get();
    info.fragment_shader = fragment;
    info.vertex_input_state = SDL_GPUVertexInputState{&vertex_buffer, 1, attributes.data(),
                                                      static_cast<Uint32>(attributes.size())};
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = samples;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline* pipeline = create_sdl_gpu_graphics_pipeline(device, vertex, &info);
    if (!pipeline)
        gpu_error("SDL_CreateGPUGraphicsPipeline UI");
    return pipeline;
}

inline void create_sprite_ui_sdl_gpu_resources(SDL_GPUDevice* device, SDL_GPUTextureFormat format,
                                               SpriteUiSdlResources& ui,
                                               std::optional<SDL_GPUSampleCount> layer_samples) {
    if (ui.color_pipeline)
        return;
    const OwnedSdlShader vertex =
        create_sprite_ui_sdl_gpu_shader(device, SpriteUiSdlShader::vertex);
    const OwnedSdlShader color =
        create_sprite_ui_sdl_gpu_shader(device, SpriteUiSdlShader::color_fragment);
    const OwnedSdlShader texture =
        create_sprite_ui_sdl_gpu_shader(device, SpriteUiSdlShader::texture_fragment);
    const SDL_GPUTextureFormat draw_format =
        layer_samples ? SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM : format;
    const SDL_GPUSampleCount draw_samples = layer_samples.value_or(SDL_GPU_SAMPLECOUNT_1);
    ui.color_pipeline =
        create_sprite_ui_sdl_gpu_pipeline(device, vertex, color.get(), draw_format, draw_samples);
    ui.texture_pipeline =
        create_sprite_ui_sdl_gpu_pipeline(device, vertex, texture.get(), draw_format, draw_samples);
    if (layer_samples) {
        ui.composite_pipeline = create_sprite_ui_sdl_gpu_pipeline(device, vertex, texture.get(),
                                                                  format, SDL_GPU_SAMPLECOUNT_1);
    }

    SDL_GPUSamplerCreateInfo sampler{};
    sampler.min_filter = SDL_GPU_FILTER_LINEAR;
    sampler.mag_filter = SDL_GPU_FILTER_LINEAR;
    sampler.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    ui.sampler = SDL_CreateGPUSampler(device, &sampler);
    if (!ui.sampler)
        gpu_error("SDL_CreateGPUSampler UI");
    sampler.min_filter = SDL_GPU_FILTER_NEAREST;
    sampler.mag_filter = SDL_GPU_FILTER_NEAREST;
    ui.nearest_sampler = SDL_CreateGPUSampler(device, &sampler);
    if (!ui.nearest_sampler)
        gpu_error("SDL_CreateGPUSampler UI nearest");
}

inline void ensure_sprite_ui_sdl_gpu_backdrop_pipeline(SDL_GPUDevice* device,
                                                       SpriteUiSdlResources& ui) {
    if (ui.backdrop.pipeline)
        return;
    const OwnedSdlShader vertex =
        create_sprite_ui_sdl_gpu_shader(device, SpriteUiSdlShader::vertex);
    const OwnedSdlShader texture =
        create_sprite_ui_sdl_gpu_shader(device, SpriteUiSdlShader::texture_fragment);
    ui.backdrop.pipeline = create_sprite_ui_sdl_gpu_pipeline(
        device, vertex, texture.get(), SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT,
        SDL_GPU_SAMPLECOUNT_1, true);
}

inline void ensure_sprite_ui_sdl_gpu_layer(SDL_GPUDevice* device, SpriteUiSdlResources& ui,
                                           SDL_GPUSampleCount samples, std::uint32_t width,
                                           std::uint32_t height) {
    SpriteUiSdlLayer& layer = ui.layer;
    if (layer.texture && layer.width == width && layer.height == height)
        return;
    layer.release(device);
    const auto make_texture = [&](SDL_GPUSampleCount texture_samples) {
        SDL_GPUTextureCreateInfo info{};
        info.type = SDL_GPU_TEXTURETYPE_2D;
        info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        info.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET |
                     (texture_samples == SDL_GPU_SAMPLECOUNT_1 ? SDL_GPU_TEXTUREUSAGE_SAMPLER : 0);
        info.width = width;
        info.height = height;
        info.layer_count_or_depth = 1;
        info.num_levels = 1;
        info.sample_count = texture_samples;
        SDL_GPUTexture* result = SDL_CreateGPUTexture(device, &info);
        if (!result)
            gpu_error("SDL_CreateGPUTexture UI layer");
        return result;
    };
    layer.texture = make_texture(SDL_GPU_SAMPLECOUNT_1);
    layer.multisample = samples == SDL_GPU_SAMPLECOUNT_1 ? nullptr : make_texture(samples);
    layer.width = width;
    layer.height = height;
}

inline void ensure_sprite_ui_sdl_gpu_buffer(SDL_GPUDevice* device, SDL_GPUBuffer*& buffer,
                                            std::uint32_t& capacity, std::uint32_t required,
                                            SDL_GPUBufferUsageFlags usage) {
    if (buffer && capacity >= required)
        return;
    if (buffer)
        SDL_ReleaseGPUBuffer(device, buffer);
    capacity = std::max<std::uint32_t>(4096, capacity);
    while (capacity < required)
        capacity *= 2;
    const SDL_GPUBufferCreateInfo info{usage, capacity, {}};
    buffer = SDL_CreateGPUBuffer(device, &info);
    if (!buffer)
        gpu_error("SDL_CreateGPUBuffer UI");
}

inline OwnedSdlTransfer upload_sprite_ui_sdl_gpu_buffer(SDL_GPUDevice* device,
                                                        SDL_GPUCopyPass* copy,
                                                        SDL_GPUBuffer* destination,
                                                        const void* data, std::uint32_t size) {
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = size;
    OwnedSdlTransfer transfer{SDL_CreateGPUTransferBuffer(device, &transfer_info), {device}};
    if (!transfer.get())
        gpu_error("SDL_CreateGPUTransferBuffer UI");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer.get(), false);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer UI");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer.get());
    const SDL_GPUTransferBufferLocation source{transfer.get(), 0};
    const SDL_GPUBufferRegion target{destination, 0, size};
    SDL_UploadToGPUBuffer(copy, &source, &target, true);
    return transfer;
}

/**
 * Records one UI frame over `target`.
 *
 * `layer_samples` selects the composition: absent, each draw blends directly
 * into the target; present, each segment renders into the transparent layer
 * at that sample count and the resolved layer composites over the target. An
 * owner passes the same value every frame, because the pipelines keep it.
 */
template <typename ExternalTexture = std::nullptr_t>
inline void render_sprite_ui_sdl_gpu_frame(
    SDL_GPUDevice* device, SDL_GPUCommandBuffer* command, SDL_GPUTexture* target,
    SDL_GPUTextureFormat target_format, SpriteUiSdlResources& ui, const UiRenderFrame& frame,
    ExternalTexture external_texture = nullptr, SpriteUiSdlCpuSample* cpu_sample = nullptr,
    std::optional<SDL_GPUSampleCount> layer_samples = std::nullopt) {
    const double started = cpu_sample ? monotonic_milliseconds() : 0;
    const auto released = prune_ui_texture_cache(
        ui.textures, [device](SDL_GPUTexture* texture) { SDL_ReleaseGPUTexture(device, texture); });
    if (cpu_sample)
        cpu_sample->textures_released += released;
    if ((frame.draws.empty() && frame.operations.empty()) || frame.width == 0 ||
        frame.height == 0) {
        if (cpu_sample)
            cpu_sample->resources_ms = monotonic_milliseconds() - started;
        return;
    }
    if (cpu_sample) {
        cpu_sample->pipelines_created += ui.color_pipeline ? 0 : (layer_samples ? 3 : 2);
        cpu_sample->pipelines_created += !frame.backdrops.empty() && !ui.backdrop.pipeline ? 1 : 0;
    }
    create_sprite_ui_sdl_gpu_resources(device, target_format, ui, layer_samples);
    if (!frame.backdrops.empty())
        ensure_sprite_ui_sdl_gpu_backdrop_pipeline(device, ui);
    if (layer_samples)
        ensure_sprite_ui_sdl_gpu_layer(device, ui, *layer_samples, frame.width, frame.height);

    // The recorder appended the full-frame composite quad after the RmlUi
    // draws (`frame.composite_first_index` names it), so the aggregate
    // geometry uploads verbatim -- no per-frame copy on this side.
    const std::uint32_t vertex_bytes =
        static_cast<std::uint32_t>(frame.vertices.size() * sizeof(UiRenderVertex));
    const std::uint32_t index_bytes =
        static_cast<std::uint32_t>(frame.indices.size() * sizeof(std::uint32_t));
    if (cpu_sample) {
        cpu_sample->vertex_bytes = vertex_bytes;
        cpu_sample->index_bytes = index_bytes;
        cpu_sample->geometry_buffers_created += !ui.vertices || ui.vertex_capacity < vertex_bytes;
        cpu_sample->geometry_buffers_created += !ui.indices || ui.index_capacity < index_bytes;
    }
    ensure_sprite_ui_sdl_gpu_buffer(device, ui.vertices, ui.vertex_capacity, vertex_bytes,
                                    SDL_GPU_BUFFERUSAGE_VERTEX);
    ensure_sprite_ui_sdl_gpu_buffer(device, ui.indices, ui.index_capacity, index_bytes,
                                    SDL_GPU_BUFFERUSAGE_INDEX);

    const double resources_finished = cpu_sample ? monotonic_milliseconds() : 0;
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    if (!copy)
        gpu_error("SDL_BeginGPUCopyPass UI");
    std::vector<OwnedSdlTransfer> transfers;
    transfers.push_back(upload_sprite_ui_sdl_gpu_buffer(device, copy, ui.vertices,
                                                        frame.vertices.data(), vertex_bytes));
    transfers.push_back(upload_sprite_ui_sdl_gpu_buffer(device, copy, ui.indices,
                                                        frame.indices.data(), index_bytes));
    const double geometry_uploaded = cpu_sample ? monotonic_milliseconds() : 0;
    for (const UiRenderTexture& source_texture : frame.textures) {
        if (ui.textures.contains(source_texture.id) || !source_texture.rgba) {
            continue;
        }
        SDL_GPUTextureCreateInfo texture_info{};
        texture_info.type = SDL_GPU_TEXTURETYPE_2D;
        texture_info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        texture_info.usage = SDL_GPU_TEXTUREUSAGE_SAMPLER;
        texture_info.width = source_texture.width;
        texture_info.height = source_texture.height;
        texture_info.layer_count_or_depth = 1;
        texture_info.num_levels = 1;
        texture_info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        OwnedSdlTexture texture_owner{SDL_CreateGPUTexture(device, &texture_info), {device}};
        auto* texture = texture_owner.get();
        if (!texture)
            gpu_error("SDL_CreateGPUTexture UI source");
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(source_texture.rgba->size());
        OwnedSdlTransfer transfer_owner{SDL_CreateGPUTransferBuffer(device, &transfer_info),
                                        {device}};
        auto* transfer = transfer_owner.get();
        if (!transfer)
            gpu_error("SDL_CreateGPUTransferBuffer UI texture");
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer UI texture");
        std::memcpy(mapped, source_texture.rgba->data(), source_texture.rgba->size());
        SDL_UnmapGPUTransferBuffer(device, transfer);
        const SDL_GPUTextureTransferInfo source{transfer, 0, source_texture.width,
                                                source_texture.height};
        const SDL_GPUTextureRegion destination{
            texture, 0, 0, 0, 0, 0, source_texture.width, source_texture.height, 1};
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
        transfers.push_back(std::move(transfer_owner));
        ui.textures.emplace(source_texture.id,
                            UiCachedTexture<SDL_GPUTexture*>{texture, source_texture.rgba});
        static_cast<void>(texture_owner.release());
        if (cpu_sample) {
            ++cpu_sample->textures_created;
            cpu_sample->texture_bytes += source_texture.rgba->size();
        }
    }
    const double textures_uploaded = cpu_sample ? monotonic_milliseconds() : 0;
    copy.end();
    transfers.clear();
    const double upload_finished = cpu_sample ? monotonic_milliseconds() : 0;

    SDL_GPUGraphicsPipeline* const target_pipeline = sprite_ui_sdl_gpu_target_pipeline(ui);
    const SDL_GPUBufferBinding vertex_binding{ui.vertices, 0};
    const SDL_GPUBufferBinding index_binding{ui.indices, 0};
    const std::array<float, 16> projection{
        2.0f / frame.width, 0, 0, 0, 0, -2.0f / frame.height, 0, 0, 0, 0, 0.0001f, 0, -1, 1, 0, 1};
    const std::array<float, 2> translation{0, 0};
    ui.filters.begin_frame();
    for_each_ui_segment(
        frame,
        [&](std::size_t draw_begin, std::size_t draw_end, std::uint32_t layer) {
            if (cpu_sample)
                ++cpu_sample->segments;
            auto* draw_target =
                ui.filters.target(device, command, target, target_format, frame, layer);
            SDL_GPUColorTargetInfo color_target{};
            if (layer_samples) {
                // The layer starts transparent for every segment; a
                // multisampled layer resolves into the sampled one.
                color_target.texture =
                    ui.layer.multisample ? ui.layer.multisample : ui.layer.texture;
                color_target.load_op = SDL_GPU_LOADOP_CLEAR;
                color_target.clear_color = SDL_FColor{0, 0, 0, 0};
                if (ui.layer.multisample) {
                    color_target.store_op = SDL_GPU_STOREOP_RESOLVE;
                    color_target.resolve_texture = ui.layer.texture;
                } else {
                    color_target.store_op = SDL_GPU_STOREOP_STORE;
                }
            } else {
                color_target.texture = draw_target;
                color_target.load_op = SDL_GPU_LOADOP_LOAD;
                color_target.store_op = SDL_GPU_STOREOP_STORE;
            }
            SdlRenderPass pass{SDL_BeginGPURenderPass(command, &color_target, 1, nullptr)};
            if (!pass)
                gpu_error("SDL_BeginGPURenderPass UI");
            SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
            SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
            SDL_PushGPUVertexUniformData(command, 0, projection.data(), sizeof(projection));
            SDL_PushGPUVertexUniformData(command, 1, translation.data(), sizeof(translation));
            for (std::size_t draw_index = draw_begin; draw_index < draw_end; ++draw_index) {
                const UiRenderDraw& draw = frame.draws[draw_index];
                const std::optional<UiScissorRect> scissor =
                    clamped_ui_scissor(draw, frame.width, frame.height);
                if (!scissor)
                    continue;
                const SDL_Rect clip{scissor->left, scissor->top, scissor->width, scissor->height};
                SDL_SetGPUScissor(pass, &clip);
                if (draw.texture_id) {
                    const auto owned = ui.textures.find(draw.texture_id);
                    SDL_GPUTexture* texture =
                        owned == ui.textures.end() ? nullptr : owned->second.resource;
                    if constexpr (!std::is_same_v<ExternalTexture, std::nullptr_t>) {
                        if (!texture)
                            texture = external_texture(draw.texture_id);
                    }
                    if (!texture)
                        continue;
                    SDL_BindGPUGraphicsPipeline(pass, ui.texture_pipeline);
                    const SDL_GPUTextureSamplerBinding texture_binding{
                        texture, draw.nearest_sampling ? ui.nearest_sampler : ui.sampler};
                    SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
                } else {
                    SDL_BindGPUGraphicsPipeline(pass, ui.color_pipeline);
                }
                count_gpu_draw(SDL_DrawGPUIndexedPrimitives, pass, draw.index_count, 1,
                               draw.first_index, 0, 0);
                if (cpu_sample)
                    ++cpu_sample->draws;
            }
            pass.end();
            if (!layer_samples)
                return;

            SDL_GPUColorTargetInfo composite_target{};
            composite_target.texture = draw_target;
            composite_target.load_op = SDL_GPU_LOADOP_LOAD;
            composite_target.store_op = SDL_GPU_STOREOP_STORE;
            SdlRenderPass composite_pass{
                SDL_BeginGPURenderPass(command, &composite_target, 1, nullptr)};
            if (!composite_pass)
                gpu_error("SDL_BeginGPURenderPass UI composite");
            SDL_BindGPUGraphicsPipeline(composite_pass, target_pipeline);
            SDL_BindGPUVertexBuffers(composite_pass, 0, &vertex_binding, 1);
            SDL_BindGPUIndexBuffer(composite_pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
            const SDL_Rect full_clip{0, 0, static_cast<int>(frame.width),
                                     static_cast<int>(frame.height)};
            SDL_SetGPUScissor(composite_pass, &full_clip);
            const SDL_GPUTextureSamplerBinding layer_binding{ui.layer.texture, ui.sampler};
            SDL_BindGPUFragmentSamplers(composite_pass, 0, &layer_binding, 1);
            SDL_PushGPUVertexUniformData(command, 0, projection.data(), sizeof(projection));
            SDL_PushGPUVertexUniformData(command, 1, translation.data(), sizeof(translation));
            count_gpu_draw(SDL_DrawGPUIndexedPrimitives, composite_pass, 6, 1,
                           frame.composite_first_index, 0, 0);
            composite_pass.end();
        },
        [&](const UiRenderOperation& operation) {
            if (operation.kind == UiRenderOperation::Kind::ResetLayer) {
                ui.filters.reset_layer(operation.index);
            } else if (operation.kind == UiRenderOperation::Kind::Backdrop) {
                render_ui_backdrop_sdl_gpu(device, command, target, target_format, ui.vertices,
                                           ui.indices, ui.sampler, target_pipeline, ui.backdrop,
                                           frame, operation.index);
            } else {
                render_ui_composite_sdl_gpu(device, command, target, target_format, ui.vertices,
                                            ui.indices, ui.sampler, target_pipeline, ui.filters,
                                            frame, operation.index);
            }
        });
    ui.filters.finish_frame(device, frame.composites.size());
    if (cpu_sample) {
        cpu_sample->resources_ms = resources_finished - started;
        cpu_sample->geometry_upload_ms = geometry_uploaded - resources_finished;
        cpu_sample->texture_upload_ms = textures_uploaded - geometry_uploaded;
        cpu_sample->upload_cleanup_ms = upload_finished - textures_uploaded;
        cpu_sample->record_ms = monotonic_milliseconds() - upload_finished;
    }
}

inline void release_sprite_ui_sdl_gpu_resources(SDL_GPUDevice* device, SpriteUiSdlResources& ui) {
    ui.backdrop.release(device);
    ui.filters.release(device);
    for (const auto& [id, texture] : ui.textures) {
        static_cast<void>(id);
        SDL_ReleaseGPUTexture(device, texture.resource);
    }
    ui.layer.release(device);
    if (ui.vertices)
        SDL_ReleaseGPUBuffer(device, ui.vertices);
    if (ui.indices)
        SDL_ReleaseGPUBuffer(device, ui.indices);
    if (ui.sampler)
        SDL_ReleaseGPUSampler(device, ui.sampler);
    if (ui.nearest_sampler)
        SDL_ReleaseGPUSampler(device, ui.nearest_sampler);
    if (ui.color_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(device, ui.color_pipeline);
    if (ui.texture_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(device, ui.texture_pipeline);
    if (ui.composite_pipeline)
        SDL_ReleaseGPUGraphicsPipeline(device, ui.composite_pipeline);
    ui = {};
}

} // namespace bbl::pal
