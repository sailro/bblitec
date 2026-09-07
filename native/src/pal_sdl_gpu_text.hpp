#pragma once

#include "pal_sdl_gpu_text_resources.hpp"
#include "pal_text_pipeline.hpp"
#include "pal_text_scene.hpp"
#include <map>
#include <tuple>

namespace bbl::pal {

inline const char* sdl_text_format_name(SDL_GPUTextureFormat format) {
    switch (format) {
        case SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM: return "bgra8unorm";
        case SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM: return "rgba8unorm";
        case SDL_GPU_TEXTUREFORMAT_D24_UNORM: return "depth24plus";
        case SDL_GPU_TEXTUREFORMAT_D24_UNORM_S8_UINT: return "depth24plus-stencil8";
        case SDL_GPU_TEXTUREFORMAT_D32_FLOAT: return "depth32float";
        case SDL_GPU_TEXTUREFORMAT_D32_FLOAT_S8_UINT: return "depth32float-stencil8";
        default: throw std::runtime_error("Unmapped SDL text target format.");
    }
}

struct SdlTextRenderer {
    std::shared_ptr<SdlTextDevice> owner = std::make_shared<SdlTextDevice>();
    std::shared_ptr<SdlTextBuffer> quad;
    std::shared_ptr<SdlTextSamplerLease> sampler;
    std::shared_ptr<SdlTextLayout> layout = std::make_shared<SdlTextLayout>();
    TextScenePass scene;
    std::map<std::tuple<const upstream::TextPipelineInfo*, SDL_GPUTextureFormat, SDL_GPUTextureFormat>,
        std::shared_ptr<SdlTextPipeline>> pipelines;

    explicit SdlTextRenderer(SDL_GPUDevice* device, bool capture) {
        owner->device = device; owner->capture = TextGpuCapture(capture);
        for (const auto& row : upstream::text_binding_layout)
            layout->bindings.emplace_back(row.binding, text_binding_role(row.name));
    }
    ~SdlTextRenderer() { owner->retire(); }
    SdlTextRenderer(const SdlTextRenderer&) = delete;
    SdlTextRenderer& operator=(const SdlTextRenderer&) = delete;

    void ensure_quad() {
        if (quad) return;
        auto created = std::make_shared<SdlTextBuffer>();
        created->bytes = sizeof(upstream::text_quad_corners);
        created->lease = retain_sdl_text_resource<SdlTextBufferLease>(owner,
            upload_buffer(owner->device, SDL_GPU_BUFFERUSAGE_VERTEX,
                upstream::text_quad_corners.data(), created->bytes), "quad", created->bytes);
        owner->capture.write(created->lease->capture_id, 0u,
            {reinterpret_cast<const std::uint8_t*>(upstream::text_quad_corners.data()), sizeof(upstream::text_quad_corners)});
        // SDL binds a sampler beside every sampled texture. Slug only uses
        // textureLoad, so this nearest sampler is never evaluated by its shader.
        SDL_GPUSamplerCreateInfo descriptor{};
        descriptor.min_filter = descriptor.mag_filter = SDL_GPU_FILTER_NEAREST;
        descriptor.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        descriptor.address_mode_u = descriptor.address_mode_v = descriptor.address_mode_w = SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        auto created_sampler = retain_sdl_text_resource<SdlTextSamplerLease>(owner,
            SDL_CreateGPUSampler(owner->device, &descriptor));
        quad = std::move(created); sampler = std::move(created_sampler);
    }

    TextPipelineBinding pipeline(const upstream::TextPipelineInfo& info,
        SDL_GPUTextureFormat color_format, SDL_GPUTextureFormat depth_format) {
        ensure_quad();
        const auto key = std::tuple{&info, color_format, depth_format};
        if (const auto found = pipelines.find(key); found != pipelines.end())
            return {found->second, found->second, layout, quad};
        auto created = std::make_shared<SdlTextPipeline>();
        created->vertex_slots = read_pinned_stage_slots(info.vertex_shader);
        created->fragment_slots = read_pinned_stage_slots(info.fragment_shader);
        const auto load = [&](const char* name, SDL_GPUShaderStage stage, const PinnedStageSlots& slots) {
            return load_shader(owner->device, name, stage, static_cast<std::uint32_t>(slots.textures.size()),
                static_cast<std::uint32_t>(slots.uniforms.size()), nullptr,
                static_cast<std::uint32_t>(slots.storage.size()));
        };
        auto vertex = load(info.vertex_shader, SDL_GPU_SHADERSTAGE_VERTEX, created->vertex_slots);
        auto fragment = load(info.fragment_shader, SDL_GPU_SHADERSTAGE_FRAGMENT, created->fragment_slots);
        std::vector<SDL_GPUVertexBufferDescription> buffers;
        std::vector<SDL_GPUVertexAttribute> attributes;
        for (const auto& source : upstream::text_vertex_buffers) {
            SDL_GPUVertexBufferDescription target{};
            target.slot = static_cast<Uint32>(buffers.size()); target.pitch = source.stride;
            const std::string_view step(source.step_mode);
            if (step == "vertex") target.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
            else if (step == "instance") target.input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
            else throw std::runtime_error("Unmapped text vertex step mode.");
            for (const auto& attribute : source.attributes) {
                SDL_GPUVertexAttribute value{};
                value.location = attribute.location; value.offset = attribute.offset; value.buffer_slot = target.slot;
                const std::string_view format(attribute.format);
                if (format == "float32x2") value.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
                else if (format == "uint32") value.format = SDL_GPU_VERTEXELEMENTFORMAT_UINT;
                else throw std::runtime_error("Unmapped text vertex attribute format.");
                attributes.push_back(value);
            }
            buffers.push_back(target);
        }
        SDL_GPUColorTargetDescription target{};
        target.format = color_format;
        if (info.blend_enabled) target.blend_state = blend_state_from(info.blend);
        SDL_GPUGraphicsPipelineCreateInfo descriptor{};
        descriptor.vertex_shader = vertex.get(); descriptor.fragment_shader = fragment.get();
        descriptor.vertex_input_state.vertex_buffer_descriptions = buffers.data();
        descriptor.vertex_input_state.num_vertex_buffers = static_cast<Uint32>(buffers.size());
        descriptor.vertex_input_state.vertex_attributes = attributes.data();
        descriptor.vertex_input_state.num_vertex_attributes = static_cast<Uint32>(attributes.size());
        if (std::string_view(info.topology) != "triangle-list" || std::string_view(info.cull_mode) != "none" ||
            std::string_view(info.front_face) != "ccw") throw std::runtime_error("Unmapped text primitive state.");
        descriptor.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        descriptor.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        descriptor.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
        descriptor.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        descriptor.depth_stencil_state.compare_op = gpu_depth_compare(info.depth_compare);
        descriptor.depth_stencil_state.enable_depth_test = info.has_depth;
        descriptor.depth_stencil_state.enable_depth_write = info.depth_write;
        descriptor.multisample_state.sample_count = gpu_sample_count_from(info.sample_count);
        descriptor.multisample_state.enable_alpha_to_coverage = info.alpha_to_coverage;
        descriptor.target_info.color_target_descriptions = &target;
        descriptor.target_info.num_color_targets = 1;
        descriptor.target_info.depth_stencil_format = depth_format;
        descriptor.target_info.has_depth_stencil_target = info.has_depth;
        created->pipeline = retain_sdl_text_resource<SdlTextPipelineLease>(owner,
            SDL_CreateGPUGraphicsPipeline(owner->device, &descriptor), "pipeline");
        if (owner->capture.enabled()) created->capture = text_pipeline_capture(info,
            sdl_text_format_name(color_format), info.has_depth ? sdl_text_format_name(depth_format) : "");
        pipelines.emplace(key, created);
        return {created, created, layout, quad};
    }
};

} // namespace bbl::pal
