#pragma once

// Direct SDL_GPU realization of the backend-neutral RmlUi recorder for the
// standalone SpriteRenderer frame driver. The scene renderer has its own
// multisampled transparent-layer compositor; sprite-only scenes render into
// a single-sample target, so this consumer blends the same premultiplied Rml
// geometry directly into that target.

#include <bblite/pal_ui.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

#include "RmlUi_SDL_GPU/ShadersCompiledSPV.h"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

struct SpriteUiSdlResources {
    SDL_GPUGraphicsPipeline* color_pipeline = nullptr;
    SDL_GPUGraphicsPipeline* texture_pipeline = nullptr;
    SDL_GPUSampler* sampler = nullptr;
    SDL_GPUSampler* nearest_sampler = nullptr;
    SDL_GPUBuffer* vertices = nullptr;
    SDL_GPUBuffer* indices = nullptr;
    std::unordered_map<std::uint64_t, SDL_GPUTexture*> textures;
    std::uint32_t vertex_capacity = 0;
    std::uint32_t index_capacity = 0;
};

enum class SpriteUiSdlShader {
    color_fragment,
    texture_fragment,
    vertex,
};

inline SDL_GPUShader* create_sprite_ui_sdl_shader(
    SDL_GPUDevice* device,
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
        gpu_error("No supported SDL_GPU sprite UI shader format");
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
    if (!shader) gpu_error("SDL_CreateGPUShader sprite UI");
    return shader;
}

inline SDL_GPUGraphicsPipeline* create_sprite_ui_sdl_pipeline(
    SDL_GPUDevice* device,
    SDL_GPUShader* vertex,
    SDL_GPUShader* fragment,
    SDL_GPUTextureFormat format) {
    SDL_GPUColorTargetDescription target{};
    target.format = format;
    target.blend_state.enable_blend = true;
    target.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    target.blend_state.src_color_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    target.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    target.blend_state.dst_color_blendfactor =
        SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    target.blend_state.dst_alpha_blendfactor =
        SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;

    const std::array<SDL_GPUVertexAttribute, 3> attributes{
        SDL_GPUVertexAttribute{
            0,
            0,
            SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2,
            static_cast<Uint32>(offsetof(UiRenderVertex, x))},
        SDL_GPUVertexAttribute{
            1,
            0,
            SDL_GPU_VERTEXELEMENTFORMAT_UBYTE4_NORM,
            static_cast<Uint32>(offsetof(UiRenderVertex, red))},
        SDL_GPUVertexAttribute{
            2,
            0,
            SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2,
            static_cast<Uint32>(offsetof(UiRenderVertex, u))},
    };
    const SDL_GPUVertexBufferDescription vertex_buffer{
        0,
        sizeof(UiRenderVertex),
        SDL_GPU_VERTEXINPUTRATE_VERTEX,
        0};
    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertex;
    info.fragment_shader = fragment;
    info.vertex_input_state = SDL_GPUVertexInputState{
        &vertex_buffer,
        1,
        attributes.data(),
        static_cast<Uint32>(attributes.size())};
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.target_info.color_target_descriptions = &target;
    info.target_info.num_color_targets = 1;
    SDL_GPUGraphicsPipeline* pipeline =
        SDL_CreateGPUGraphicsPipeline(device, &info);
    if (!pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline sprite UI");
    return pipeline;
}

inline void create_sprite_ui_sdl_resources(
    SDL_GPUDevice* device,
    SDL_GPUTextureFormat format,
    SpriteUiSdlResources& ui) {
    if (ui.color_pipeline) return;
    SDL_GPUShader* vertex = create_sprite_ui_sdl_shader(
        device, SpriteUiSdlShader::vertex);
    SDL_GPUShader* color = create_sprite_ui_sdl_shader(
        device, SpriteUiSdlShader::color_fragment);
    SDL_GPUShader* texture = create_sprite_ui_sdl_shader(
        device, SpriteUiSdlShader::texture_fragment);
    ui.color_pipeline = create_sprite_ui_sdl_pipeline(
        device, vertex, color, format);
    ui.texture_pipeline = create_sprite_ui_sdl_pipeline(
        device, vertex, texture, format);
    SDL_ReleaseGPUShader(device, vertex);
    SDL_ReleaseGPUShader(device, color);
    SDL_ReleaseGPUShader(device, texture);

    SDL_GPUSamplerCreateInfo sampler{};
    sampler.min_filter = SDL_GPU_FILTER_LINEAR;
    sampler.mag_filter = SDL_GPU_FILTER_LINEAR;
    sampler.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
    sampler.address_mode_u = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_v = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    sampler.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
    ui.sampler = SDL_CreateGPUSampler(device, &sampler);
    if (!ui.sampler) gpu_error("SDL_CreateGPUSampler sprite UI");
    sampler.min_filter = SDL_GPU_FILTER_NEAREST;
    sampler.mag_filter = SDL_GPU_FILTER_NEAREST;
    ui.nearest_sampler = SDL_CreateGPUSampler(device, &sampler);
    if (!ui.nearest_sampler) {
        gpu_error("SDL_CreateGPUSampler sprite UI nearest");
    }
}

inline void ensure_sprite_ui_sdl_buffer(
    SDL_GPUDevice* device,
    SDL_GPUBuffer*& buffer,
    std::uint32_t& capacity,
    std::uint32_t required,
    SDL_GPUBufferUsageFlags usage) {
    if (buffer && capacity >= required) return;
    if (buffer) SDL_ReleaseGPUBuffer(device, buffer);
    capacity = std::max<std::uint32_t>(4096, capacity);
    while (capacity < required) capacity *= 2;
    const SDL_GPUBufferCreateInfo info{usage, capacity, {}};
    buffer = SDL_CreateGPUBuffer(device, &info);
    if (!buffer) gpu_error("SDL_CreateGPUBuffer sprite UI");
}

inline SDL_GPUTransferBuffer* upload_sprite_ui_sdl_buffer(
    SDL_GPUDevice* device,
    SDL_GPUCopyPass* copy,
    SDL_GPUBuffer* destination,
    const void* data,
    std::uint32_t size) {
    SDL_GPUTransferBufferCreateInfo transfer_info{};
    transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transfer_info.size = size;
    SDL_GPUTransferBuffer* transfer =
        SDL_CreateGPUTransferBuffer(device, &transfer_info);
    if (!transfer) gpu_error("SDL_CreateGPUTransferBuffer sprite UI");
    void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
    if (!mapped) gpu_error("SDL_MapGPUTransferBuffer sprite UI");
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(device, transfer);
    const SDL_GPUTransferBufferLocation source{transfer, 0};
    const SDL_GPUBufferRegion target{destination, 0, size};
    SDL_UploadToGPUBuffer(copy, &source, &target, true);
    return transfer;
}

inline void render_sprite_ui_sdl_frame(
    SDL_GPUDevice* device,
    SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* target,
    SDL_GPUTextureFormat target_format,
    SpriteUiSdlResources& ui,
    const UiRenderFrame& frame) {
    if (frame.draws.empty() || frame.width == 0 || frame.height == 0) return;
    create_sprite_ui_sdl_resources(device, target_format, ui);

    const std::uint32_t vertex_bytes = static_cast<std::uint32_t>(
        frame.vertices.size() * sizeof(UiRenderVertex));
    const std::uint32_t index_bytes = static_cast<std::uint32_t>(
        frame.indices.size() * sizeof(std::uint32_t));
    ensure_sprite_ui_sdl_buffer(
        device,
        ui.vertices,
        ui.vertex_capacity,
        vertex_bytes,
        SDL_GPU_BUFFERUSAGE_VERTEX);
    ensure_sprite_ui_sdl_buffer(
        device,
        ui.indices,
        ui.index_capacity,
        index_bytes,
        SDL_GPU_BUFFERUSAGE_INDEX);

    for (auto texture = ui.textures.begin(); texture != ui.textures.end();) {
        if (ui_frame_uses_texture(frame, texture->first)) {
            ++texture;
            continue;
        }
        SDL_ReleaseGPUTexture(device, texture->second);
        texture = ui.textures.erase(texture);
    }
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    if (!copy) gpu_error("SDL_BeginGPUCopyPass sprite UI");
    std::vector<SDL_GPUTransferBuffer*> transfers;
    transfers.push_back(upload_sprite_ui_sdl_buffer(
        device,
        copy,
        ui.vertices,
        frame.vertices.data(),
        vertex_bytes));
    transfers.push_back(upload_sprite_ui_sdl_buffer(
        device,
        copy,
        ui.indices,
        frame.indices.data(),
        index_bytes));
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
        SDL_GPUTexture* texture = SDL_CreateGPUTexture(device, &texture_info);
        if (!texture) gpu_error("SDL_CreateGPUTexture sprite UI source");
        SDL_GPUTransferBufferCreateInfo transfer_info{};
        transfer_info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        transfer_info.size = static_cast<Uint32>(source_texture.rgba->size());
        SDL_GPUTransferBuffer* transfer =
            SDL_CreateGPUTransferBuffer(device, &transfer_info);
        if (!transfer) {
            gpu_error("SDL_CreateGPUTransferBuffer sprite UI texture");
        }
        void* mapped = SDL_MapGPUTransferBuffer(device, transfer, false);
        if (!mapped) gpu_error("SDL_MapGPUTransferBuffer sprite UI texture");
        std::memcpy(
            mapped,
            source_texture.rgba->data(),
            source_texture.rgba->size());
        SDL_UnmapGPUTransferBuffer(device, transfer);
        const SDL_GPUTextureTransferInfo source{
            transfer,
            0,
            source_texture.width,
            source_texture.height};
        const SDL_GPUTextureRegion destination{
            texture,
            0,
            0,
            0,
            0,
            0,
            source_texture.width,
            source_texture.height,
            1};
        SDL_UploadToGPUTexture(copy, &source, &destination, false);
        transfers.push_back(transfer);
        ui.textures.emplace(source_texture.id, texture);
    }
    SDL_EndGPUCopyPass(copy);
    for (SDL_GPUTransferBuffer* transfer : transfers) {
        SDL_ReleaseGPUTransferBuffer(device, transfer);
    }

    SDL_GPUColorTargetInfo color_target{};
    color_target.texture = target;
    color_target.load_op = SDL_GPU_LOADOP_LOAD;
    color_target.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPURenderPass* pass =
        SDL_BeginGPURenderPass(command, &color_target, 1, nullptr);
    if (!pass) gpu_error("SDL_BeginGPURenderPass sprite UI");
    const SDL_GPUBufferBinding vertex_binding{ui.vertices, 0};
    const SDL_GPUBufferBinding index_binding{ui.indices, 0};
    SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
    SDL_BindGPUIndexBuffer(
        pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    const std::array<float, 16> projection{
        2.0f / frame.width, 0, 0, 0,
        0, -2.0f / frame.height, 0, 0,
        0, 0, 0.0001f, 0,
        -1, 1, 0, 1};
    const std::array<float, 2> translation{0, 0};
    SDL_PushGPUVertexUniformData(
        command, 0, projection.data(), sizeof(projection));
    SDL_PushGPUVertexUniformData(
        command, 1, translation.data(), sizeof(translation));
    for (const UiRenderDraw& draw : frame.draws) {
        const int left = std::clamp(
            draw.scissor_x, 0, static_cast<int>(frame.width));
        const int top = std::clamp(
            draw.scissor_y, 0, static_cast<int>(frame.height));
        const int right = std::clamp(
            draw.scissor_x + static_cast<int>(draw.scissor_width),
            0,
            static_cast<int>(frame.width));
        const int bottom = std::clamp(
            draw.scissor_y + static_cast<int>(draw.scissor_height),
            0,
            static_cast<int>(frame.height));
        if (right <= left || bottom <= top || draw.index_count == 0) continue;
        const SDL_Rect clip{left, top, right - left, bottom - top};
        SDL_SetGPUScissor(pass, &clip);
        if (draw.texture_id) {
            const auto texture = ui.textures.find(draw.texture_id);
            if (texture == ui.textures.end()) continue;
            SDL_BindGPUGraphicsPipeline(pass, ui.texture_pipeline);
            const SDL_GPUTextureSamplerBinding texture_binding{
                texture->second,
                draw.nearest_sampling ? ui.nearest_sampler : ui.sampler};
            SDL_BindGPUFragmentSamplers(pass, 0, &texture_binding, 1);
        } else {
            SDL_BindGPUGraphicsPipeline(pass, ui.color_pipeline);
        }
        SDL_DrawGPUIndexedPrimitives(
            pass, draw.index_count, 1, draw.first_index, 0, 0);
    }
    SDL_EndGPURenderPass(pass);
}

inline void release_sprite_ui_sdl_resources(
    SDL_GPUDevice* device,
    SpriteUiSdlResources& ui) {
    for (const auto& [id, texture] : ui.textures) {
        static_cast<void>(id);
        SDL_ReleaseGPUTexture(device, texture);
    }
    if (ui.vertices) SDL_ReleaseGPUBuffer(device, ui.vertices);
    if (ui.indices) SDL_ReleaseGPUBuffer(device, ui.indices);
    if (ui.sampler) SDL_ReleaseGPUSampler(device, ui.sampler);
    if (ui.nearest_sampler) {
        SDL_ReleaseGPUSampler(device, ui.nearest_sampler);
    }
    if (ui.color_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, ui.color_pipeline);
    }
    if (ui.texture_pipeline) {
        SDL_ReleaseGPUGraphicsPipeline(device, ui.texture_pipeline);
    }
    ui = {};
}

} // namespace bbl::pal
