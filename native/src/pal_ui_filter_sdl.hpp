#pragma once
#include "pal_ui_filter.hpp"
#include "pal_sdl_gpu_shared.hpp"

namespace bbl::pal {

struct UiFilterSdlResources {
    struct Texture {
        SDL_GPUTexture* value = nullptr;
        std::uint32_t width = 0, height = 0;
        SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;
        void release(SDL_GPUDevice* device) { if (value) SDL_ReleaseGPUTexture(device, value); *this = {}; }
        SDL_GPUTexture* ensure(SDL_GPUDevice* device, std::uint32_t w, std::uint32_t h, SDL_GPUTextureFormat f) {
            if (!value || width != w || height != h || format != f) {
                release(device);
                value = create_frame_texture(device, f, SDL_GPU_SAMPLECOUNT_1, w, h,
                    SDL_GPU_TEXTUREUSAGE_SAMPLER | SDL_GPU_TEXTUREUSAGE_COLOR_TARGET);
                width = w; height = h; format = f;
            }
            return value;
        }
    };
    struct Layer { Texture texture; bool used = false; };
    using Workspace = UiFilterTargets<Texture>;
    SDL_GPUGraphicsPipeline* pipeline = nullptr;
    std::vector<Layer> layers;
    std::vector<Workspace> workspaces;

    void begin_frame() { for (auto& layer : layers) layer.used = false; }
    void reset_layer(std::uint32_t id) { if (id > 0 && id <= layers.size()) layers[id - 1].used = false; }
    void finish_frame(SDL_GPUDevice* device, std::size_t count) {
        for (auto& layer : layers) if (!layer.used) layer.texture.release(device);
        for (std::size_t i = count; i < workspaces.size(); ++i) workspaces[i].release([&](Texture& texture) { texture.release(device); });
        if (workspaces.size() > count) workspaces.resize(count);
    }
    void release(SDL_GPUDevice* device) {
        for (auto& layer : layers) layer.texture.release(device);
        for (auto& workspace : workspaces) workspace.release([&](Texture& texture) { texture.release(device); });
        if (pipeline) SDL_ReleaseGPUGraphicsPipeline(device, pipeline);
        *this = {};
    }
    SDL_GPUTexture* target(SDL_GPUDevice* device, SDL_GPUCommandBuffer* command, SDL_GPUTexture* root,
                           SDL_GPUTextureFormat format, const UiRenderFrame& frame, std::uint32_t id) {
        if (id == 0) return root;
        if (id > frame.layer_count) throw std::runtime_error("Invalid retained UI layer.");
        if (layers.size() < id) layers.resize(id);
        auto& layer = layers[id - 1];
        auto* result = layer.texture.ensure(device, frame.width, frame.height, format);
        if (!layer.used) {
            SDL_GPUColorTargetInfo attachment{};
            attachment.texture = result; attachment.load_op = SDL_GPU_LOADOP_CLEAR; attachment.store_op = SDL_GPU_STOREOP_STORE;
            SdlRenderPass pass{SDL_BeginGPURenderPass(command, &attachment, 1, nullptr)};
            if (!pass) gpu_error("SDL_BeginGPURenderPass UI filter clear");
            pass.end(); layer.used = true;
        }
        return result;
    }
    void ensure_pipeline(SDL_GPUDevice* device) {
        if (pipeline) return;
        auto vertex = load_shader(device, "ui-filter.vert", SDL_GPU_SHADERSTAGE_VERTEX, 0, 0, "mainVertex");
        auto fragment = load_shader(device, "ui-filter.frag", SDL_GPU_SHADERSTAGE_FRAGMENT, 2, 1, "mainFragment");
        SDL_GPUColorTargetDescription target{}; target.format = SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
        SDL_GPUGraphicsPipelineCreateInfo info{};
        info.vertex_shader = vertex.get(); info.fragment_shader = fragment.get();
        info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL; info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
        info.target_info.color_target_descriptions = &target; info.target_info.num_color_targets = 1;
        pipeline = SDL_CreateGPUGraphicsPipeline(device, &info);
        if (!pipeline) gpu_error("SDL_CreateGPUGraphicsPipeline UI filter");
    }
};

inline void render_ui_composite_sdl(SDL_GPUDevice* device, SDL_GPUCommandBuffer* command,
    SDL_GPUTexture* root, SDL_GPUTextureFormat format, SDL_GPUBuffer* vertices, SDL_GPUBuffer* indices,
    SDL_GPUSampler* sampler, SDL_GPUGraphicsPipeline* composite_pipeline, UiFilterSdlResources& resources,
    const UiRenderFrame& frame, std::size_t index) {
    const auto& composite = frame.composites[index];
    if (!composite.index_count) return;
    auto* source = resources.target(device, command, root, format, frame, composite.source);
    auto* destination = resources.target(device, command, root, format, frame, composite.destination);
    if (resources.workspaces.size() <= index) resources.workspaces.resize(index + 1);
    auto& textures = resources.workspaces[index];
    textures.begin();
    auto* snapshot = textures.get(UiFilterSurface::Snapshot).ensure(device, composite.width, composite.height, format);
    SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
    const SDL_GPUTextureLocation from{source, 0, 0, static_cast<Uint32>(composite.left), static_cast<Uint32>(composite.top), 0};
    const SDL_GPUTextureLocation to{snapshot, 0, 0, 0, 0, 0};
    SDL_CopyGPUTextureToTexture(copy, &from, &to, composite.width, composite.height, 1, false);
    copy.end();
    const auto plan = ui_filter_plan(composite);
    if (!plan.draws.empty()) resources.ensure_pipeline(device);
    for (const auto& draw : plan.draws) {
        auto* output = textures.output(draw).ensure(device, draw.width, draw.height,
            SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT);
        SDL_GPUColorTargetInfo attachment{};
        attachment.texture = output; attachment.load_op = SDL_GPU_LOADOP_CLEAR; attachment.store_op = SDL_GPU_STOREOP_STORE;
        SdlRenderPass pass{SDL_BeginGPURenderPass(command, &attachment, 1, nullptr)};
        if (!pass) gpu_error("SDL_BeginGPURenderPass UI filter");
        SDL_BindGPUGraphicsPipeline(pass, resources.pipeline);
        const std::array<SDL_GPUTextureSamplerBinding, 2> bindings{{
            {textures.get(draw.input).value, sampler},
            {textures.get(draw.secondary).value, sampler}}};
        SDL_BindGPUFragmentSamplers(pass, 0, bindings.data(), static_cast<Uint32>(bindings.size()));
        SDL_PushGPUFragmentUniformData(command, 0, &draw.uniforms, sizeof(draw.uniforms));
        SDL_DrawGPUPrimitives(pass, 3, 1, 0, 0);
        pass.end();
    }
    SDL_GPUColorTargetInfo attachment{};
    attachment.texture = destination; attachment.load_op = SDL_GPU_LOADOP_LOAD; attachment.store_op = SDL_GPU_STOREOP_STORE;
    SdlRenderPass pass{SDL_BeginGPURenderPass(command, &attachment, 1, nullptr)};
    if (!pass) gpu_error("SDL_BeginGPURenderPass UI filter composite");
    SDL_BindGPUGraphicsPipeline(pass, composite_pipeline);
    const SDL_GPUBufferBinding vertex_binding{vertices, 0}, index_binding{indices, 0};
    SDL_BindGPUVertexBuffers(pass, 0, &vertex_binding, 1);
    SDL_BindGPUIndexBuffer(pass, &index_binding, SDL_GPU_INDEXELEMENTSIZE_32BIT);
    const SDL_GPUTextureSamplerBinding texture{textures.get(plan.result).value, sampler};
    SDL_BindGPUFragmentSamplers(pass, 0, &texture, 1);
    const std::array<float, 16> projection{2.0f/frame.width,0,0,0,0,-2.0f/frame.height,0,0,0,0,.0001f,0,-1,1,0,1};
    const std::array<float, 2> translation{0,0};
    SDL_PushGPUVertexUniformData(command, 0, projection.data(), sizeof(projection));
    SDL_PushGPUVertexUniformData(command, 1, translation.data(), sizeof(translation));
    SDL_DrawGPUIndexedPrimitives(pass, composite.index_count, 1, composite.first_index, 0, 0);
    pass.end();
    textures.finish([&](auto& target) { target.release(device); });
}

} // namespace bbl::pal
