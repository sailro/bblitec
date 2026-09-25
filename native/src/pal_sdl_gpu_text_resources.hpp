#pragma once

#include "pal_gpu_frame.hpp"
#include <bblite/text.hpp>
#include "pal_sdl_gpu_shared.hpp"
#include "pal_text_resources.hpp"

#include <cstring>
#include <memory>
#include <span>
#include <utility>

namespace bbl::pal {

struct SdlTextDevice {
    SDL_GPUDevice* device = nullptr;
    TextResourceRetirement resources;
    TextGpuCapture capture;

    void retire() noexcept {
        resources.retire();
        device = nullptr;
    }
};

template <class Resource, auto Release> struct SdlTextLease {
    std::shared_ptr<SdlTextDevice> owner;
    Resource* handle = nullptr;
    std::uint64_t capture_id = 0;
    ~SdlTextLease() { retire(); }
    void retire() noexcept {
        if (handle) {
            Release(owner->device, std::exchange(handle, nullptr));
            if (capture_id)
                owner->capture.release(capture_id);
        }
    }
    Resource* get() const {
        if (!handle)
            throw std::runtime_error("Text GPU resource was destroyed.");
        return handle;
    }
};

using SdlTextBufferLease = SdlTextLease<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>;
using SdlTextTextureLease = SdlTextLease<SDL_GPUTexture, SDL_ReleaseGPUTexture>;
using SdlTextSamplerLease = SdlTextLease<SDL_GPUSampler, SDL_ReleaseGPUSampler>;
using SdlTextPipelineLease = SdlTextLease<SDL_GPUGraphicsPipeline, SDL_ReleaseGPUGraphicsPipeline>;

template <class Lease, class Resource>
std::shared_ptr<Lease> retain_sdl_gpu_text_resource(const std::shared_ptr<SdlTextDevice>& owner,
                                                    Resource* handle, std::string_view role = {},
                                                    std::size_t bytes = 0, std::size_t width = 0,
                                                    std::size_t rows = 0) {
    if (!handle)
        gpu_error("Text GPU resource creation failed");
    auto lease = std::make_shared<Lease>();
    lease->owner = owner;
    lease->handle = handle;
    if (owner->capture.enabled() && !role.empty())
        lease->capture_id = owner->capture.create_resource(role, bytes, width, rows);
    owner->resources.track(lease);
    return lease;
}

/** A uniform buffer: SDL pushes its bytes as stage uniform data per draw. */
struct SdlTextUniform {
    std::shared_ptr<SdlTextDevice> owner;
    std::uint64_t capture_id = 0;
    std::vector<std::uint8_t> bytes;
    bool destroyed = false;
    ~SdlTextUniform() { retire(); }
    void retire() noexcept {
        if (!destroyed && capture_id)
            owner->capture.release(capture_id);
        destroyed = true;
    }
    void check() const {
        if (destroyed)
            throw std::runtime_error("Text uniform resource was destroyed.");
    }
};

/** `GPUBuffer`: a device buffer, or a uniform buffer's pushed bytes. */
struct SdlTextGpuBuffer final : GpuObject {
    const void* device_identity() const override {
        return uniform ? uniform->owner->device : lease->owner->device;
    }
    std::shared_ptr<SdlTextBufferLease> lease;
    std::shared_ptr<SdlTextUniform> uniform;
    std::optional<std::size_t> buffer_capacity() const override { return gpu_size(size); }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> bytes) override {
        if (uniform) {
            uniform->check();
            if (!bytes.empty())
                std::memcpy(uniform->bytes.data() + offset, bytes.data(), bytes.size());
            uniform->owner->capture.write(uniform->capture_id, offset, bytes);
            return;
        }
        write_sdl_gpu_buffer(lease->owner->device, lease->get(), offset, bytes);
        lease->owner->capture.write(lease->capture_id, offset, bytes);
    }
    void destroy() override {
        if (lease)
            lease->retire();
        if (uniform)
            uniform->retire();
    }
};
/** A texture's default view: SDL binds the texture itself. */
struct SdlTextGpuView final : GpuObject {
    std::shared_ptr<SdlTextTextureLease> lease;
    /** A swapchain or capture target the frame owns. */
    SDL_GPUTexture* target = nullptr;
    SDL_GPUTexture* get() const { return lease ? lease->get() : target; }
};
/** `GPUTexture`. */
struct SdlTextGpuTexture final : GpuObject {
    const void* device_identity() const override { return lease->owner->device; }
    std::shared_ptr<SdlTextTextureLease> lease;
    void write_texture_bytes(std::span<const std::uint8_t> data,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        const auto row_bytes = layout.bytes_per_row.value_or(extent.width * 16u);
        if (row_bytes != static_cast<std::size_t>(extent.width) * 16u ||
            extent.depth_or_array_layers != 1)
            throw std::runtime_error("Text atlas upload requires contiguous RGBA32F rows.");
        const auto bytes = gpu_bytes(data, static_cast<double>(layout.offset),
                                     static_cast<double>(row_bytes) * extent.height);
        write_sdl_gpu_texture(lease->owner->device, lease->get(), bytes,
                              {0, row_bytes, extent.height}, extent);
        lease->owner->capture.write(lease->capture_id, 0u, bytes);
    }
    void destroy() override { lease->retire(); }
    GpuHandle create_view() override {
        auto view = std::make_shared<SdlTextGpuView>();
        view->lease = lease;
        return view;
    }
};
/** `GPUBindGroupLayout`: the composed shader's binding roles. */
struct SdlTextGpuLayout final : GpuObject {
    std::vector<std::pair<std::uint32_t, TextBindingRole>> bindings;
};
/** `GPUBindGroup`: the resources SDL binds by the shader's own names. */
struct SdlTextGpuGroup final : GpuObject {
    std::shared_ptr<SdlTextUniform> uniform;
    std::shared_ptr<SdlTextBufferLease> styles, metadata;
    std::shared_ptr<SdlTextTextureLease> curves, bands;
    std::uint64_t capture_id = 0;
    std::vector<TextGpuBindingCapture> bindings;
    std::shared_ptr<SdlTextDevice> owner;
    ~SdlTextGpuGroup() override { retire(); }
    void retire() noexcept {
        if (capture_id) {
            owner->capture.release(capture_id);
            capture_id = 0;
        }
    }
};
/** `GPURenderPipeline`. */
struct SdlTextGpuPipeline final : GpuObject {
    std::shared_ptr<SdlTextPipelineLease> pipeline;
    PinnedStageSlots vertex_slots, fragment_slots;
    TextGpuDrawCapture capture;
};

template <class Object> std::shared_ptr<Object> sdl_text_object(const GpuHandle& handle) {
    auto object = std::dynamic_pointer_cast<Object>(handle);
    if (!object)
        throw std::runtime_error("Text GPU object belongs to another kind or device.");
    return object;
}

/** `GPURenderPassEncoder` over an SDL render pass. */
struct SdlTextPassEncoder final : GpuEncoder {
    std::shared_ptr<SdlTextDevice> owner;
    std::shared_ptr<SdlTextSamplerLease> sampler;
    SDL_GPUCommandBuffer* command = nullptr;
    SDL_GPURenderPass* pass = nullptr;
    /** A pass `beginRenderPass` opened; a scene pass borrows the frame's. */
    SdlRenderPass owned_pass;
    std::shared_ptr<SdlTextGpuPipeline> current_pipeline;
    std::shared_ptr<SdlTextGpuGroup> current_group;
    std::shared_ptr<SdlTextBufferLease> current_quad, current_instances;
    std::vector<SDL_GPUBuffer*> storage_scratch;
    std::vector<std::uint8_t> pushed_uniform_bytes;

    void set_pipeline(const GpuHandle& handle) override {
        current_pipeline = sdl_text_object<SdlTextGpuPipeline>(handle);
        SDL_BindGPUGraphicsPipeline(pass, current_pipeline->pipeline->get());
    }
    void set_vertex_buffer(double slot, const GpuHandle& handle) override {
        const auto buffer = sdl_text_object<SdlTextGpuBuffer>(handle);
        if (!buffer->lease)
            throw std::runtime_error("Text vertex buffer is a uniform buffer.");
        const SDL_GPUBufferBinding binding{buffer->lease->get(), 0};
        const auto index = gpu_u32(gpu_size(slot));
        SDL_BindGPUVertexBuffers(pass, index, &binding, 1u);
        if (owner->capture.enabled())
            (index == 0 ? current_quad : current_instances) = buffer->lease;
    }
    void set_bind_group(double index, const GpuHandle& handle) override {
        if (gpu_size(index) != 0)
            throw std::runtime_error("Text bind groups bind at group 0.");
        const auto group = sdl_text_object<SdlTextGpuGroup>(handle);
        group->uniform->check();
        for (const bool fragment : {false, true}) {
            const auto& slots =
                fragment ? current_pipeline->fragment_slots : current_pipeline->vertex_slots;
            push_stage_uniforms(command, slots, fragment, "Text",
                                [&](const std::string& name, std::size_t) {
                                    return text_binding_role(name) == TextBindingRole::uniform
                                               ? PinnedStageBlock{group->uniform->bytes.data(),
                                                                  group->uniform->bytes.size()}
                                               : PinnedStageBlock{};
                                });
            if (owner->capture.enabled() && !slots.uniforms.empty())
                pushed_uniform_bytes = group->uniform->bytes;
            bind_stage_storage(pass, slots, fragment, "Text", storage_scratch,
                               [&](const std::string& name, std::size_t) -> SDL_GPUBuffer* {
                                   const auto role = text_binding_role(name);
                                   if (role == TextBindingRole::metadata)
                                       return group->metadata->get();
                                   if (role == TextBindingRole::styles)
                                       return group->styles->get();
                                   return nullptr;
                               });
            bind_stage_textures(
                pass, slots, fragment, "Text", [&](const std::string& name, std::size_t) {
                    const auto role = text_binding_role(name);
                    SDL_GPUTexture* texture = role == TextBindingRole::curves ? group->curves->get()
                                              : role == TextBindingRole::bands ? group->bands->get()
                                                                               : nullptr;
                    return SDL_GPUTextureSamplerBinding{texture, sampler->get()};
                });
        }
        if (owner->capture.enabled())
            current_group = group;
    }
    void draw(double vertices, double instances, double first_vertex,
              double first_instance) override {
        const auto count = gpu_u32(gpu_size(vertices)),
                   instance_count = gpu_u32(gpu_size(instances)),
                   first = gpu_u32(gpu_size(first_vertex)),
                   first_instance_index = gpu_u32(gpu_size(first_instance));
        SDL_DrawGPUPrimitives(pass, count, instance_count, first, first_instance_index);
        if (owner->capture.enabled()) {
            auto receipt = current_pipeline->capture;
            receipt.pipeline = current_pipeline->pipeline->capture_id;
            receipt.group = current_group->capture_id;
            receipt.quad = current_quad->capture_id;
            receipt.instances = current_instances->capture_id;
            receipt.bindings = current_group->bindings;
            receipt.pushed_uniform_bytes = pushed_uniform_bytes;
            receipt.vertices = count;
            receipt.instance_count = instance_count;
            receipt.first_vertex = first;
            receipt.first_instance = first_instance_index;
            owner->capture.draw(std::move(receipt));
        }
    }
    void execute_bundles(const js::Array<GpuHandle>& bundles) override {
        replay_text_bundles(*this, bundles);
    }
    void end() override {
        if (!owned_pass.get())
            throw std::runtime_error("Text pass encoder does not own its pass.");
        owned_pass.end();
        pass = nullptr;
    }
};

/** `GPUCommandEncoder` over the frame's SDL command buffer. */
struct SdlTextCommandEncoder final : GpuCommandEncoder {
    std::shared_ptr<SdlTextDevice> owner;
    std::shared_ptr<SdlTextSamplerLease> sampler;
    SDL_GPUCommandBuffer* command = nullptr;
    /** The format of the views this frame's passes target. */
    SDL_GPUTextureFormat format = SDL_GPU_TEXTUREFORMAT_INVALID;

    GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor& descriptor) override {
        if (descriptor.color_attachments.size() != 1)
            throw std::runtime_error("Text render passes have one color attachment.");
        const auto& color = descriptor.color_attachments[0];
        SDL_GPUColorTargetInfo attachment{};
        attachment.texture = sdl_text_object<SdlTextGpuView>(color.view)->get();
        if (color.clear_value) {
            const auto& value = *color.clear_value;
            attachment.clear_color =
                gpu_clear_color(owner->device, format,
                                {static_cast<float>(value.r), static_cast<float>(value.g),
                                 static_cast<float>(value.b), static_cast<float>(value.a)});
        }
        if (color.load_op == "clear")
            attachment.load_op = SDL_GPU_LOADOP_CLEAR;
        else if (color.load_op == "load")
            attachment.load_op = SDL_GPU_LOADOP_LOAD;
        else
            throw std::runtime_error("Unmapped text pass load op: " + color.load_op);
        if (color.store_op != "store")
            throw std::runtime_error("Unmapped text pass store op: " + color.store_op);
        attachment.store_op = SDL_GPU_STOREOP_STORE;
        auto encoder = std::make_shared<SdlTextPassEncoder>();
        encoder->owner = owner;
        encoder->sampler = sampler;
        encoder->command = command;
        encoder->owned_pass = SDL_BeginGPURenderPass(command, &attachment, 1, nullptr);
        encoder->pass = encoder->owned_pass.get();
        if (!encoder->pass)
            gpu_error("SDL_BeginGPURenderPass text");
        return encoder;
    }
};

/**
 * The WebGPU half of the SDL text device: objects over SDL resources, their
 * writes and bind groups. A uniform buffer is the bytes SDL pushes per draw;
 * a bind group is the resources SDL binds by the composed shader's names.
 */
struct SdlTextGpuResources : GpuDevice {
    std::shared_ptr<SdlTextDevice> owner = std::make_shared<SdlTextDevice>();

    SdlTextGpuResources(SDL_GPUDevice* device, bool capture) {
        owner->device = device;
        owner->capture = TextGpuCapture(capture);
    }
    const void* device_identity() const override { return owner->device; }
    ~SdlTextGpuResources() override { owner->retire(); }

    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        const auto bytes = gpu_size(descriptor.size);
        auto buffer = std::make_shared<SdlTextGpuBuffer>();
        buffer->size = descriptor.size;
        if (text_usage_has(descriptor.usage, text_buffer_usage_uniform)) {
            auto uniform = std::make_shared<SdlTextUniform>();
            uniform->owner = owner;
            uniform->bytes.resize(bytes);
            uniform->capture_id = owner->capture.create_resource("uniform-shadow", bytes);
            owner->resources.track(uniform);
            buffer->uniform = std::move(uniform);
            return buffer;
        }
        SDL_GPUBufferCreateInfo info{};
        info.size = gpu_u32(bytes);
        if (text_usage_has(descriptor.usage, text_buffer_usage_vertex))
            info.usage |= SDL_GPU_BUFFERUSAGE_VERTEX;
        if (text_usage_has(descriptor.usage, text_buffer_usage_storage))
            info.usage |= SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ;
        buffer->lease = retain_sdl_gpu_text_resource<SdlTextBufferLease>(
            owner, SDL_CreateGPUBuffer(owner->device, &info), text_resource_role(descriptor.label),
            bytes);
        return buffer;
    }

    GpuHandle create_texture(const GpuTextureDescriptor& descriptor) override {
        if (descriptor.format != "rgba32float" ||
            !text_usage_has(descriptor.usage, text_texture_usage_binding) ||
            gpu_size(descriptor.size.depth_or_array_layers) != 1)
            throw std::runtime_error("Unmapped text texture descriptor.");
        const auto width = gpu_size(descriptor.size.width), rows = gpu_size(descriptor.size.height);
        auto texture = std::make_shared<SdlTextGpuTexture>();
        texture->lease = retain_sdl_gpu_text_resource<SdlTextTextureLease>(
            owner,
            create_frame_texture(owner->device, SDL_GPU_TEXTUREFORMAT_R32G32B32A32_FLOAT,
                                 SDL_GPU_SAMPLECOUNT_1, gpu_u32(width), gpu_u32(rows),
                                 SDL_GPU_TEXTUREUSAGE_SAMPLER),
            text_resource_role(descriptor.label), width * rows * 4u * sizeof(float), width, rows);
        return texture;
    }

    GpuHandle create_bind_group(const GpuBindGroupDescriptor& descriptor) override {
        const auto layout = sdl_text_object<SdlTextGpuLayout>(descriptor.layout);
        auto group = std::make_shared<SdlTextGpuGroup>();
        const auto resource = [&](std::uint32_t binding) -> const GpuBindingResource& {
            for (const auto& entry : descriptor.entries)
                if (gpu_size(entry.binding) == binding)
                    return entry.resource;
            throw std::runtime_error("Text bind group lacks a layout binding.");
        };
        const auto buffer = [&](const GpuBindingResource& value) {
            const auto* binding = std::get_if<GpuBufferBinding>(&value);
            if (!binding || binding->offset || binding->size)
                throw std::runtime_error("Text buffer bindings bind whole buffers.");
            return sdl_text_object<SdlTextGpuBuffer>(binding->buffer);
        };
        const auto view = [&](const GpuBindingResource& value) {
            const auto* handle = std::get_if<GpuHandle>(&value);
            if (!handle)
                throw std::runtime_error("Text texture binding is not a view.");
            return sdl_text_object<SdlTextGpuView>(*handle)->lease;
        };
        if (descriptor.entries.size() != layout->bindings.size())
            throw std::runtime_error("Text bind group entries differ from its layout.");
        for (const auto& [binding, role] : layout->bindings) {
            const auto& value = resource(binding);
            std::uint64_t id = 0;
            switch (role) {
            case TextBindingRole::uniform:
                group->uniform = buffer(value)->uniform;
                if (!group->uniform)
                    throw std::runtime_error("Text uniform binding is not a uniform buffer.");
                id = group->uniform->capture_id;
                break;
            case TextBindingRole::metadata:
                group->metadata = buffer(value)->lease;
                id = group->metadata->capture_id;
                break;
            case TextBindingRole::styles:
                group->styles = buffer(value)->lease;
                id = group->styles->capture_id;
                break;
            case TextBindingRole::curves:
                group->curves = view(value);
                id = group->curves->capture_id;
                break;
            case TextBindingRole::bands:
                group->bands = view(value);
                id = group->bands->capture_id;
                break;
            }
            if (owner->capture.enabled())
                group->bindings.push_back({binding, text_binding_role_name(role), id, 0});
        }
        if (owner->capture.enabled()) {
            group->owner = owner;
            group->capture_id = owner->capture.create_resource("binding-set", 0);
            owner->resources.track(group);
        }
        return group;
    }

    GpuEncoderHandle
    create_render_bundle_encoder(const GpuRenderBundleEncoderDescriptor&) override {
        return std::make_shared<TextBundleRecorder>();
    }
};

} // namespace bbl::pal
