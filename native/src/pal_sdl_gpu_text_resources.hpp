#pragma once

#include <bblite/text.hpp>
#include "pal_sdl_gpu_shared.hpp"
#include "pal_text_resources.hpp"

#include <memory>
#include <span>
#include <utility>

namespace bbl::pal {

struct SdlTextDevice {
    SDL_GPUDevice* device = nullptr;
    TextResourceRetirement resources;

    void retire() noexcept {
        resources.retire();
        device = nullptr;
    }
};

template<class Resource, auto Release>
struct SdlTextLease {
    std::shared_ptr<SdlTextDevice> owner;
    Resource* handle = nullptr;
    ~SdlTextLease() { retire(); }
    void retire() noexcept {
        if (handle) Release(owner->device, std::exchange(handle, nullptr));
    }
    Resource* get() const {
        if (!handle) throw std::runtime_error("Text GPU resource was destroyed.");
        return handle;
    }
};

using SdlTextBufferLease = SdlTextLease<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>;
using SdlTextTextureLease = SdlTextLease<SDL_GPUTexture, SDL_ReleaseGPUTexture>;
using SdlTextSamplerLease = SdlTextLease<SDL_GPUSampler, SDL_ReleaseGPUSampler>;
using SdlTextPipelineLease = SdlTextLease<SDL_GPUGraphicsPipeline, SDL_ReleaseGPUGraphicsPipeline>;

template<class Lease, class Resource>
std::shared_ptr<Lease> retain_sdl_text_resource(const std::shared_ptr<SdlTextDevice>& owner, Resource* handle) {
    if (!handle) gpu_error("Text GPU resource creation failed");
    auto lease = std::make_shared<Lease>();
    lease->owner = owner;
    lease->handle = handle;
    owner->resources.track(lease);
    return lease;
}

struct SdlTextUniform {
    std::vector<std::uint8_t> bytes;
    bool destroyed = false;
    void retire() noexcept { destroyed = true; }
    void check() const {
        if (destroyed) throw std::runtime_error("Text uniform resource was destroyed.");
    }
};
struct SdlTextBuffer {
    std::shared_ptr<SdlTextBufferLease> lease;
    std::size_t bytes = 0;
};
struct SdlTextRenderableResources {
    std::shared_ptr<SdlTextUniform> uniform;
    SdlTextBuffer instances, styles;
};
struct SdlTextAtlasResources {
    std::shared_ptr<SdlTextTextureLease> curves, bands;
    SdlTextBuffer metadata;
};
struct SdlTextGroup {
    // SDL pushes the bytes retained by the data-owned group, not whichever
    // renderable is currently drawing with that group.
    std::shared_ptr<SdlTextUniform> uniform;
    SdlTextBuffer styles, metadata;
    std::shared_ptr<SdlTextTextureLease> curves, bands;
};
struct SdlTextPipeline {
    std::shared_ptr<SdlTextPipelineLease> pipeline;
    PinnedStageSlots vertex_slots, fragment_slots;
};

inline SdlTextBuffer& sdl_text_buffer(SdlTextRenderableResources& resources, TextBufferKind kind) {
    if (kind == TextBufferKind::instances) return resources.instances;
    if (kind == TextBufferKind::styles) return resources.styles;
    throw std::runtime_error("Text uniform is materialized as stage uniform data.");
}

/** Resource updates finish before the scene acquires its draw command buffer. */
struct SdlTextResourceOps {
    std::shared_ptr<SdlTextDevice> owner;
    std::shared_ptr<SdlTextSamplerLease> sampler;
    SDL_GPUCommandBuffer* command = nullptr;
    SDL_GPURenderPass* pass = nullptr;
    std::shared_ptr<SdlTextPipeline> current_pipeline;
    std::vector<SDL_GPUBuffer*> storage_scratch;

    SdlTextBuffer create_buffer(SDL_GPUBufferUsageFlags usage, std::size_t bytes) {
        SDL_GPUBufferCreateInfo descriptor{};
        descriptor.size = text_gpu_u32(bytes);
        descriptor.usage = usage;
        return {retain_sdl_text_resource<SdlTextBufferLease>(owner,
            SDL_CreateGPUBuffer(owner->device, &descriptor)), bytes};
    }

    void create_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t bytes) {
        if (!gpu.backend) gpu.backend = std::make_shared<SdlTextRenderableResources>();
        auto resources = std::static_pointer_cast<SdlTextRenderableResources>(gpu.backend);
        if (kind == TextBufferKind::uniform) {
            resources->uniform = std::make_shared<SdlTextUniform>();
            resources->uniform->bytes.resize(bytes);
            owner->resources.track(resources->uniform);
            gpu.destroy_uniform = [uniform = resources->uniform] { uniform->retire(); };
            return;
        }
        auto& buffer = sdl_text_buffer(*resources, kind);
        buffer = create_buffer(kind == TextBufferKind::instances
            ? SDL_GPU_BUFFERUSAGE_VERTEX : SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, bytes);
        auto destroy = [lease = buffer.lease] { lease->retire(); };
        if (kind == TextBufferKind::instances) gpu.destroy_instances = destroy;
        else gpu.destroy_styles = destroy;
    }

    void create_atlas_texture(TextAtlasGpuState& atlas, TextAtlasTextureKind kind, std::size_t width, std::size_t rows) {
        if (!atlas.backend) atlas.backend = std::make_shared<SdlTextAtlasResources>();
        auto resources = std::static_pointer_cast<SdlTextAtlasResources>(atlas.backend);
        auto& texture = kind == TextAtlasTextureKind::curves ? resources->curves : resources->bands;
        texture = retain_sdl_text_resource<SdlTextTextureLease>(owner,
            create_frame_texture(owner->device, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT,
                SDL_GPU_SAMPLECOUNT_1, text_gpu_u32(width), text_gpu_u32(rows),
                SDL_GPU_TEXTUREUSAGE_SAMPLER));
        auto destroy = [lease = texture] { lease->retire(); };
        if (kind == TextAtlasTextureKind::curves) atlas.destroy_curves = destroy;
        else atlas.destroy_bands = destroy;
    }

    void create_atlas_metadata(TextAtlasGpuState& atlas, std::size_t bytes) {
        if (!atlas.backend) atlas.backend = std::make_shared<SdlTextAtlasResources>();
        auto resources = std::static_pointer_cast<SdlTextAtlasResources>(atlas.backend);
        resources->metadata = create_buffer(SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ, bytes);
        atlas.destroy_metadata = [lease = resources->metadata.lease] { lease->retire(); };
    }

    void write_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t offset,
        std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<SdlTextRenderableResources>(gpu.backend);
        if (kind == TextBufferKind::uniform) {
            resources->uniform->check();
            auto& data = resources->uniform->bytes;
            if (offset > data.size() || bytes.size() > data.size() - offset)
                throw std::runtime_error("Text uniform upload exceeds its allocation.");
            std::memcpy(data.data() + offset, bytes.data(), bytes.size());
            return;
        }
        const auto& buffer = sdl_text_buffer(*resources, kind);
        text_gpu_u32(offset);
        text_gpu_u32(bytes.size());
        GpuBufferUploadBatch uploads(owner->device);
        uploads.update(buffer.lease->get(), offset, bytes.data(), bytes.size());
        uploads.submit();
    }

    void write_atlas_texture(TextAtlasGpuState& atlas, TextAtlasTextureKind kind, std::span<const std::uint8_t> bytes,
        std::size_t bytes_per_row, std::size_t width, std::size_t rows) {
        if (bytes_per_row != width * 4u * sizeof(float))
            throw std::runtime_error("Text atlas upload requires contiguous RGBA32F rows.");
        const auto resources = std::static_pointer_cast<SdlTextAtlasResources>(atlas.backend);
        const auto& texture = kind == TextAtlasTextureKind::curves ? resources->curves : resources->bands;
        upload_2d_texture_into(owner->device, texture->get(), bytes.data(), bytes.size(),
            text_gpu_u32(width), text_gpu_u32(rows), "Text atlas upload");
    }

    void write_atlas_metadata(TextAtlasGpuState& atlas, std::span<const std::uint8_t> bytes) {
        const auto resources = std::static_pointer_cast<SdlTextAtlasResources>(atlas.backend);
        GpuBufferUploadBatch uploads(owner->device);
        uploads.update(resources->metadata.lease->get(), 0u, bytes.data(), bytes.size());
        uploads.submit();
    }

    std::shared_ptr<void> create_bind_group(const TextGpuState& gpu, const TextAtlasGpuState& atlas, const std::shared_ptr<void>&) {
        const auto resources = std::static_pointer_cast<SdlTextRenderableResources>(gpu.backend);
        const auto textures = std::static_pointer_cast<SdlTextAtlasResources>(atlas.backend);
        auto result = std::make_shared<SdlTextGroup>();
        result->uniform = resources->uniform;
        result->styles = resources->styles;
        result->metadata = textures->metadata;
        result->curves = textures->curves;
        result->bands = textures->bands;
        return result;
    }

    void set_quad_vertex_buffer(const std::shared_ptr<void>& quad) {
        const auto buffer = std::static_pointer_cast<SdlTextBuffer>(quad);
        const SDL_GPUBufferBinding binding{buffer->lease->get(), 0};
        SDL_BindGPUVertexBuffers(pass, 0u, &binding, 1u);
    }
    void set_instance_vertex_buffer(const TextGpuState& gpu) {
        const auto resources = std::static_pointer_cast<SdlTextRenderableResources>(gpu.backend);
        const SDL_GPUBufferBinding binding{resources->instances.lease->get(), 0};
        SDL_BindGPUVertexBuffers(pass, 1u, &binding, 1u);
    }
    void set_pipeline(const std::shared_ptr<void>& pipeline) {
        current_pipeline = std::static_pointer_cast<SdlTextPipeline>(pipeline);
        SDL_BindGPUGraphicsPipeline(pass, current_pipeline->pipeline->get());
    }
    void set_bind_group(const std::shared_ptr<void>& opaque_group) {
        const auto group = std::static_pointer_cast<SdlTextGroup>(opaque_group);
        group->uniform->check();
        for (const bool fragment : {false, true}) {
            const auto& slots = fragment ? current_pipeline->fragment_slots : current_pipeline->vertex_slots;
            push_stage_uniforms(command, slots, fragment, "Text", [&](const std::string& name, std::size_t) {
                return text_binding_role(name) == TextBindingRole::uniform
                    ? PinnedStageBlock{group->uniform->bytes.data(), group->uniform->bytes.size()} : PinnedStageBlock{};
            });
            bind_stage_storage(pass, slots, fragment, "Text", storage_scratch,
                [&](const std::string& name, std::size_t) -> SDL_GPUBuffer* {
                    const auto role = text_binding_role(name);
                    if (role == TextBindingRole::metadata) return group->metadata.lease->get();
                    if (role == TextBindingRole::styles) return group->styles.lease->get();
                    return nullptr;
                });
            bind_stage_textures(pass, slots, fragment, "Text", [&](const std::string& name, std::size_t) {
                const auto role = text_binding_role(name);
                SDL_GPUTexture* texture = role == TextBindingRole::curves ? group->curves->get()
                    : role == TextBindingRole::bands ? group->bands->get() : nullptr;
                return SDL_GPUTextureSamplerBinding{texture, sampler->get()};
            });
        }
    }
    void draw(std::size_t vertices, std::size_t instances, std::size_t first_vertex, std::size_t first_instance) {
        SDL_DrawGPUPrimitives(pass, text_gpu_u32(vertices), text_gpu_u32(instances), text_gpu_u32(first_vertex), text_gpu_u32(first_instance));
    }
};

} // namespace bbl::pal
