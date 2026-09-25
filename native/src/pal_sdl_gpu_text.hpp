#pragma once

#include <bblite/features/has_text_renderable.hpp>

#include "pal_sdl_gpu_text_resources.hpp"
#include "pal_text_pipeline.hpp"
#if BBLITE_HAS_TEXT_RENDERABLE
#include "pal_text_scene.hpp"
#endif
#include <map>
#include <tuple>

namespace bbl::pal {

inline const char* sdl_text_format_name(SDL_GPUTextureFormat format) {
    switch (format) {
    case SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM:
        return "bgra8unorm";
    case SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM:
        return "rgba8unorm";
    case SDL_GPU_TEXTUREFORMAT_D24_UNORM:
        return "depth24plus";
    case SDL_GPU_TEXTUREFORMAT_D24_UNORM_S8_UINT:
        return "depth24plus-stencil8";
    case SDL_GPU_TEXTUREFORMAT_D32_FLOAT:
        return "depth32float";
    case SDL_GPU_TEXTUREFORMAT_D32_FLOAT_S8_UINT:
        return "depth32float-stencil8";
    default:
        throw std::runtime_error("Unmapped SDL text target format.");
    }
}

/**
 * The pin's `GPUDevice` for text on SDL_GPU: WebGPU objects over SDL
 * resources, and the per-device pipeline cache `getOrCreateTextPipeline`
 * reads. A uniform buffer is the bytes SDL pushes per draw; a bind group is
 * the resources SDL binds by the composed shader's own names.
 */
struct SdlTextGpuDevice final : SdlTextGpuResources {
    std::shared_ptr<SdlTextSamplerLease> sampler;
    /** The target formats this device's passes draw into. */
    SDL_GPUTextureFormat color_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    SDL_GPUTextureFormat depth_format = SDL_GPU_TEXTUREFORMAT_INVALID;
    TextPipelineDeviceCacheHandle cache;
    std::map<
        std::tuple<const upstream::TextPipelineInfo*, SDL_GPUTextureFormat, SDL_GPUTextureFormat>,
        std::shared_ptr<SdlTextGpuPipeline>>
        pipelines;

    using SdlTextGpuResources::SdlTextGpuResources;

    TextPipelineDeviceCacheHandle text_pipeline_cache() override {
        if (cache)
            return cache;
        auto layout = std::make_shared<SdlTextGpuLayout>();
        for (const auto& row : upstream::text_binding_layout)
            layout->bindings.emplace_back(row.binding, text_binding_role(row.name));
        auto quad = std::make_shared<SdlTextGpuBuffer>();
        quad->size = sizeof(upstream::text_quad_corners);
        quad->lease = retain_sdl_gpu_text_resource<SdlTextBufferLease>(
            owner,
            upload_buffer(owner->device, SDL_GPU_BUFFERUSAGE_VERTEX,
                          upstream::text_quad_corners.data(), sizeof(upstream::text_quad_corners)),
            "quad", sizeof(upstream::text_quad_corners));
        owner->capture.write(
            quad->lease->capture_id, 0u,
            {reinterpret_cast<const std::uint8_t*>(upstream::text_quad_corners.data()),
             sizeof(upstream::text_quad_corners)});
        // SDL binds a sampler beside every sampled texture. Slug only uses
        // textureLoad, so this nearest sampler is never evaluated by its shader.
        SDL_GPUSamplerCreateInfo descriptor{};
        descriptor.min_filter = descriptor.mag_filter = SDL_GPU_FILTER_NEAREST;
        descriptor.mipmap_mode = SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        descriptor.address_mode_u = descriptor.address_mode_v = descriptor.address_mode_w =
            SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        sampler = retain_sdl_gpu_text_resource<SdlTextSamplerLease>(
            owner, SDL_CreateGPUSampler(owner->device, &descriptor));
        cache = std::make_shared<TextPipelineDeviceCache>();
        cache->bind_group_layout = std::move(layout);
        cache->quad_vertex_buffer = std::move(quad);
        return cache;
    }

    TextPipelineSet text_pipeline(const std::string& format, double sample_count,
                                  const std::optional<std::string>& depth_stencil_format,
                                  bool depth_write, const std::shared_ptr<const void>& owner_object,
                                  const std::string& depth_compare) override {
        if (format != sdl_text_format_name(color_format))
            throw std::runtime_error("Text pipeline format differs from the SDL target: " + format);
        const auto samples = text_gpu_u32(text_gpu_size(sample_count));
        const bool has_depth = depth_stencil_format.has_value();
        const bool alpha_to_coverage =
            text_pipeline_alpha_to_coverage(sample_count, depth_write, owner_object);
        const auto& base_info =
            text_pipeline_info(samples, has_depth, depth_write, alpha_to_coverage);
        if (has_depth && depth_compare != "greater-equal")
            throw std::runtime_error("Unmapped text depth compare: " + depth_compare);
        TextPipelineSet result;
        result.cache = text_pipeline_cache();
        result.pipeline = pipeline(base_info);
        result.variant_pipeline = text_weight_installed
                                      ? pipeline(text_pipeline_info(samples, has_depth, depth_write,
                                                                    alpha_to_coverage, true))
                                      : result.pipeline;
        return result;
    }

    std::shared_ptr<SdlTextGpuPipeline> pipeline(const upstream::TextPipelineInfo& info) {
        const auto depth = info.has_depth ? depth_format : SDL_GPU_TEXTUREFORMAT_INVALID;
        const auto key = std::tuple{&info, color_format, depth};
        if (const auto found = pipelines.find(key); found != pipelines.end())
            return found->second;
        auto created = std::make_shared<SdlTextGpuPipeline>();
        created->vertex_slots = read_pinned_stage_slots(info.vertex_shader);
        created->fragment_slots = read_pinned_stage_slots(info.fragment_shader);
        auto vertex = load_shader(owner->device, info.vertex_shader, SDL_GPU_SHADERSTAGE_VERTEX,
                                  created->vertex_slots);
        auto fragment = load_shader(owner->device, info.fragment_shader,
                                    SDL_GPU_SHADERSTAGE_FRAGMENT, created->fragment_slots);
        std::vector<SDL_GPUVertexBufferDescription> buffers;
        std::vector<SDL_GPUVertexAttribute> attributes;
        for (const auto& source : upstream::text_vertex_buffers) {
            SDL_GPUVertexBufferDescription target{};
            target.slot = static_cast<Uint32>(buffers.size());
            target.pitch = source.stride;
            const std::string_view step(source.step_mode);
            if (step == "vertex")
                target.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
            else if (step == "instance")
                target.input_rate = SDL_GPU_VERTEXINPUTRATE_INSTANCE;
            else
                throw std::runtime_error("Unmapped text vertex step mode.");
            for (const auto& attribute : source.attributes) {
                SDL_GPUVertexAttribute value{};
                value.location = attribute.location;
                value.offset = attribute.offset;
                value.buffer_slot = target.slot;
                const std::string_view format(attribute.format);
                if (format == "float32x2")
                    value.format = SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
                else if (format == "uint32")
                    value.format = SDL_GPU_VERTEXELEMENTFORMAT_UINT;
                else
                    throw std::runtime_error("Unmapped text vertex attribute format.");
                attributes.push_back(value);
            }
            buffers.push_back(target);
        }
        SDL_GPUColorTargetDescription target{};
        target.format = color_format;
        if (info.blend_enabled)
            target.blend_state = blend_state_from(info.blend);
        SDL_GPUGraphicsPipelineCreateInfo descriptor{};
        descriptor.vertex_shader = vertex.get();
        descriptor.fragment_shader = fragment.get();
        descriptor.vertex_input_state.vertex_buffer_descriptions = buffers.data();
        descriptor.vertex_input_state.num_vertex_buffers = static_cast<Uint32>(buffers.size());
        descriptor.vertex_input_state.vertex_attributes = attributes.data();
        descriptor.vertex_input_state.num_vertex_attributes =
            static_cast<Uint32>(attributes.size());
        if (std::string_view(info.topology) != "triangle-list" ||
            std::string_view(info.cull_mode) != "none" ||
            std::string_view(info.front_face) != "ccw")
            throw std::runtime_error("Unmapped text primitive state.");
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
        descriptor.target_info.depth_stencil_format = depth;
        descriptor.target_info.has_depth_stencil_target = info.has_depth;
        created->pipeline = retain_sdl_gpu_text_resource<SdlTextPipelineLease>(
            owner, create_sdl_gpu_graphics_pipeline(owner->device, &descriptor), "pipeline");
        if (owner->capture.enabled())
            created->capture =
                text_pipeline_capture(info, sdl_text_format_name(color_format),
                                      info.has_depth ? sdl_text_format_name(depth) : "");
        pipelines.emplace(key, created);
        return created;
    }
};

/** The SDL text device, and the scene pass that draws the scene's text through it. */
struct SdlTextRenderer {
    std::shared_ptr<SdlTextGpuDevice> device;
#if BBLITE_HAS_TEXT_RENDERABLE
    TextScenePass scene;
#endif
    SdlTextRenderer(SDL_GPUDevice* gpu, bool capture)
        : device(std::make_shared<SdlTextGpuDevice>(gpu, capture)) {}
    // Its resources retire with the SDL device they belong to, even while
    // the engine surface or a text record still names the device.
    ~SdlTextRenderer() { device->owner->retire(); }
    SdlTextRenderer(const SdlTextRenderer&) = delete;
    SdlTextRenderer& operator=(const SdlTextRenderer&) = delete;
    /** A pass encoder over a render pass the frame opened. */
    std::shared_ptr<SdlTextPassEncoder> borrow_pass(SDL_GPUCommandBuffer* command,
                                                    SDL_GPURenderPass* pass) {
        static_cast<void>(device->text_pipeline_cache());
        auto encoder = std::make_shared<SdlTextPassEncoder>();
        encoder->owner = device->owner;
        encoder->sampler = device->sampler;
        encoder->command = command;
        encoder->pass = pass;
        return encoder;
    }
    /** The frame's command encoder for passes the pin begins itself. */
    std::shared_ptr<SdlTextCommandEncoder> command_encoder(SDL_GPUCommandBuffer* command) {
        static_cast<void>(device->text_pipeline_cache());
        auto encoder = std::make_shared<SdlTextCommandEncoder>();
        encoder->owner = device->owner;
        encoder->sampler = device->sampler;
        encoder->command = command;
        encoder->format = device->color_format;
        return encoder;
    }
};

} // namespace bbl::pal
