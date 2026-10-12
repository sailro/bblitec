#pragma once

#include "pal_sdl_gpu_completion.hpp"
#include "pal_sdl_gpu_compute_pipeline.hpp"
#include "pal_sdl_gpu_shared.hpp"
#include "pal_webgpu_common.hpp"

#include <SDL3/SDL_gpu.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <variant>
#include <vector>

// The WebGPU subset (`gpu.hpp`) over an SDL_GPU device. SDL_GPU has no bind
// groups, layouts or uniform buffers: a bind group keeps its WebGPU entries and
// each dispatch or draw binds the resources its compiled stage reaches at the
// slots its `.slots` sidecar names, at the group's dynamic offsets. A uniform
// buffer is CPU bytes pushed when its command is encoded; command encoders
// record WebGPU commands and encode them, in order, when their command buffer is
// submitted or when a renderer encodes its frame encoder before its passes.
// WGSL reaches SDL as the stages compiled at generation, named by the module's
// text and entry point (`wgsl_stage_stem`).

namespace bbl::pal {

/** One SDL object; WebGPU's `destroy()` releases it (SDL defers past in-flight work). */
template <class Handle, auto Release> struct SdlWebGpuLease {
    SDL_GPUDevice* device = nullptr;
    Handle* handle = nullptr;
    SdlWebGpuLease() = default;
    SdlWebGpuLease(const SdlWebGpuLease&) = delete;
    SdlWebGpuLease& operator=(const SdlWebGpuLease&) = delete;
    ~SdlWebGpuLease() { retire(); }
    void retire() noexcept {
        if (handle)
            Release(device, std::exchange(handle, nullptr));
    }
    bool live() const noexcept { return handle != nullptr; }
    Handle* get() const {
        if (!handle)
            webgpu_refuse("a GPU object was destroyed or retired with its device.");
        return handle;
    }
};
using SdlWebGpuBufferLease = SdlWebGpuLease<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>;
using SdlWebGpuTransferLease = SdlWebGpuLease<SDL_GPUTransferBuffer, SDL_ReleaseGPUTransferBuffer>;
using SdlWebGpuTextureLease = SdlWebGpuLease<SDL_GPUTexture, SDL_ReleaseGPUTexture>;
using SdlWebGpuGraphicsLease =
    SdlWebGpuLease<SDL_GPUGraphicsPipeline, SDL_ReleaseGPUGraphicsPipeline>;
/** A compute pipeline with the slots its sidecar assigned. */
struct SdlWebGpuComputeLease {
    std::shared_ptr<SdlComputePipeline> pipeline;
    void retire() noexcept { pipeline.reset(); }
    const SdlComputePipeline& get() const {
        if (!pipeline)
            webgpu_refuse("a compute pipeline was retired with its device.");
        return *pipeline;
    }
};

/** The device a WebGPU object belongs to; it outlives no lease it created. */
struct SdlWebGpuOwner {
    SDL_GPUDevice* device = nullptr;
    GpuSupportedLimits limits;
    GpuLeaseRetirement leases;
    /** Zeroed upload bytes `clearBuffer` copies from. */
    std::shared_ptr<SdlWebGpuTransferLease> zeros;
    std::uint32_t zero_bytes = 0;
    /** Indirect dispatch arguments, copied apart from a buffer a dispatch also binds. */
    std::shared_ptr<SdlWebGpuBufferLease> dispatch_arguments;

    SDL_GPUDevice* live_device() const {
        if (!device)
            webgpu_refuse("the GPU device was retired.");
        return device;
    }
    template <class Lease, class Handle>
    std::shared_ptr<Lease> adopt(Handle* handle, const char* what) {
        if (!handle)
            gpu_error(what);
        auto lease = std::make_shared<Lease>();
        lease->device = live_device();
        lease->handle = handle;
        leases.track(lease);
        return lease;
    }
    void retire() noexcept {
        leases.retire();
        zeros.reset();
        dispatch_arguments.reset();
        device = nullptr;
    }
};

/** Loads a generation-compiled stage, refusing an entry point generation did not compile. */
template <class Load> auto load_sdl_webgpu_stage(const std::string& stem, Load load) {
    try {
        return load();
    } catch (const std::exception& error) {
        webgpu_refuse("the WGSL stage '" + stem + "' was not compiled at generation for SDL_GPU (" +
                      error.what() + ").");
    }
}

template <class Object>
std::shared_ptr<Object> sdl_webgpu_object(const GpuHandle& handle, const char* what) {
    auto object = std::dynamic_pointer_cast<Object>(handle);
    if (!object)
        webgpu_refuse(std::string("expected a ") + what + " this SDL_GPU device created.");
    return object;
}

/** How SDL_GPU holds a WebGPU buffer. */
enum class SdlWebGpuBufferKind {
    /** An SDL_GPUBuffer: storage, indirect and copy roles. */
    gpu,
    /** CPU bytes pushed as uniform data when a command using them is encoded. */
    uniform,
    /** A download transfer buffer: `COPY_DST | MAP_READ`. */
    readback,
};

/** `GPUBuffer`. */
struct SdlWebGpuBuffer final : GpuObject,
                               GpuBufferMapping,
                               std::enable_shared_from_this<SdlWebGpuBuffer> {
    std::shared_ptr<SdlWebGpuOwner> owner;
    SdlWebGpuBufferKind kind = SdlWebGpuBufferKind::gpu;
    std::uint32_t usage = 0;
    WebGpuBufferMapState mapping;
    std::shared_ptr<SdlWebGpuBufferLease> buffer;
    std::shared_ptr<SdlWebGpuTransferLease> transfer;
    std::vector<std::uint8_t> bytes;
    bool destroyed = false;

    std::size_t byte_size() const { return gpu_size(size); }
    const void* device_identity() const override { return owner->device; }
    std::optional<std::size_t> buffer_capacity() const override { return byte_size(); }
    SDL_GPUBuffer* gpu_buffer() const {
        if (kind != SdlWebGpuBufferKind::gpu)
            webgpu_refuse("SDL_GPU binds a uniform or readback buffer only as such.");
        return buffer->get();
    }
    const std::vector<std::uint8_t>& uniform_bytes() const {
        if (kind != SdlWebGpuBufferKind::uniform)
            webgpu_refuse("a uniform binding needs a buffer created with UNIFORM.");
        if (destroyed)
            webgpu_refuse("a GPU object was destroyed or retired with its device.");
        return bytes;
    }
    void write_buffer_bytes(std::size_t offset, std::span<const std::uint8_t> source) override {
        require_webgpu_buffer_write(usage, mapping, byte_size(), offset, source.size());
        if (kind == SdlWebGpuBufferKind::gpu)
            write_sdl_gpu_buffer(owner->live_device(), buffer->get(), offset, source);
        else if (kind == SdlWebGpuBufferKind::uniform)
            std::copy(source.begin(), source.end(),
                      uniform_bytes_mutable().begin() + static_cast<std::ptrdiff_t>(offset));
        else
            webgpu_refuse("SDL_GPU writes a MAP_READ buffer only by copying into it.");
    }
    void destroy() override {
        if (!mapping.unmapped())
            unmap();
        destroyed = true;
        bytes.clear();
        if (buffer)
            buffer->retire();
        if (transfer)
            transfer->retire();
    }
    js::ArrayBuffer get_mapped_range(bbl::js::Nullable<double> offset,
                                     bbl::js::Nullable<double> count) override {
        return mapping.get_mapped_range(
            offset, count, byte_size(), [this](std::size_t start, std::size_t length) {
                auto* device = owner->live_device();
                const auto* data = static_cast<const std::uint8_t*>(
                    SDL_MapGPUTransferBuffer(device, transfer->get(), false));
                if (!data)
                    gpu_error("SDL_MapGPUTransferBuffer readback");
                std::vector<std::uint8_t> result(data + start, data + start + length);
                SDL_UnmapGPUTransferBuffer(device, transfer->get());
                return result;
            });
    }
    void unmap() override {
        for (const auto& range : mapping.unmap()) {
            const std::span<const std::uint8_t> source{range.bytes.data(),
                                                       range.bytes.byte_length()};
            if (kind == SdlWebGpuBufferKind::gpu)
                write_sdl_gpu_buffer(owner->live_device(), buffer->get(), range.offset, source);
            else if (kind == SdlWebGpuBufferKind::uniform)
                std::copy(source.begin(), source.end(),
                          uniform_bytes_mutable().begin() +
                              static_cast<std::ptrdiff_t>(range.offset));
        }
    }
    js::Promise<js::PromiseVoid> map_async(double mode, bbl::js::Nullable<double> offset,
                                           bbl::js::Nullable<double> count) override {
        try {
            if (destroyed)
                webgpu_refuse("mapAsync on a destroyed buffer.");
            mapping.begin_read(mode, offset, count, byte_size(),
                               (usage & webgpu_buffer_usage::map_read) != 0);
        } catch (...) {
            return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
        }
        js::Promise<js::PromiseVoid> result;
        mapping.set_pending_promise(result);
        const auto generation = mapping.generation();
        // The copies into it precede this call on the device's one queue.
        return settle_webgpu_operation(
            [device = owner->live_device()](std::function<void(std::exception_ptr)> complete) {
                return std::make_unique<SdlSubmissionCompletion>(device, std::move(complete));
            },
            [weak = weak_from_this(), generation](std::exception_ptr error) {
                const auto self = weak.lock();
                if (self && !self->mapping.complete(generation, !error) && !error)
                    error = std::make_exception_ptr(
                        std::runtime_error("AbortError: the mapping ended before it completed."));
                return error;
            },
            result);
    }
    std::string map_state() const override { return mapping.map_state(); }

private:
    std::vector<std::uint8_t>& uniform_bytes_mutable() {
        static_cast<void>(uniform_bytes());
        return bytes;
    }
};

/** `GPUTextureView`: SDL_GPU binds whole textures. */
struct SdlWebGpuView final : GpuObject {
    std::shared_ptr<SdlWebGpuTextureLease> texture;
};
/** `GPUTexture`: rgba8unorm. */
struct SdlWebGpuTexture final : GpuObject {
    std::shared_ptr<SdlWebGpuOwner> owner;
    std::shared_ptr<SdlWebGpuTextureLease> lease;
    std::uint32_t usage = 0, width = 0, height = 0;
    const void* device_identity() const override { return owner->device; }
    void write_texture_bytes(std::span<const std::uint8_t> data,
                             const GpuTextureWriteLayout& layout,
                             const GpuWriteExtent& extent) override {
        if (!(usage & webgpu_texture_usage::copy_dst))
            webgpu_refuse("writeTexture requires a texture created with COPY_DST.");
        if (extent.depth_or_array_layers != 1 || extent.width > width || extent.height > height)
            webgpu_refuse("writeTexture covers one layer inside the texture.");
        const std::size_t row = std::size_t{extent.width} * 4u;
        if (layout.bytes_per_row.value_or(static_cast<std::uint32_t>(row)) != row)
            webgpu_refuse("SDL_GPU uploads tightly packed rgba8 rows.");
        if (layout.offset > data.size() || row * extent.height > data.size() - layout.offset)
            webgpu_refuse("writeTexture exceeds its source bytes.");
        write_sdl_gpu_texture(owner->live_device(), lease->get(),
                              data.subspan(layout.offset, row * extent.height),
                              {0, {}, extent.height}, extent);
    }
    void destroy() override { lease->retire(); }
    GpuHandle create_view() override {
        auto view = std::make_shared<SdlWebGpuView>();
        view->texture = lease;
        return view;
    }
};

struct SdlWebGpuBindGroupLayout final : GpuObject {
    std::vector<WebGpuLayoutEntry> entries;
    /** Bindings with dynamic offsets, in increasing binding order (WebGPU's offset order). */
    std::vector<std::uint32_t> dynamic_bindings;
};
struct SdlWebGpuShaderModule final : GpuObject {
    std::string code;
};
struct SdlWebGpuPipelineLayout final : GpuObject {
    std::vector<GpuHandle> groups;
};
struct SdlWebGpuComputePipeline final : GpuObject {
    std::shared_ptr<SdlWebGpuComputeLease> lease;
    GpuHandle layout;
};
/** A render stage's sidecar: its slots and the WGSL binding each resource name has. */
struct SdlWebGpuRenderStage {
    PinnedStageSlots slots;
    std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> bindings;
};
struct SdlWebGpuRenderPipeline final : GpuObject {
    std::shared_ptr<SdlWebGpuGraphicsLease> lease;
    GpuHandle layout;
    SdlWebGpuRenderStage vertex, fragment;
};
/** `GPUBindGroup`: its layout and entries; SDL_GPU binds them per command. */
struct SdlWebGpuBindGroup final : GpuObject {
    std::shared_ptr<SdlWebGpuBindGroupLayout> layout;
    std::vector<GpuBindGroupEntry> entries;
    /** A renderer's own group (the scene's group 0), whose resources it binds itself. */
    bool renderer_owned = false;
};

/** The resource at `binding` of a bound group, at its dynamic offset. */
struct SdlWebGpuResolved {
    std::shared_ptr<SdlWebGpuBuffer> buffer;
    std::size_t offset = 0;
    std::optional<std::size_t> size;
    std::shared_ptr<SdlWebGpuView> view;
};
struct SdlWebGpuBoundGroup {
    std::shared_ptr<SdlWebGpuBindGroup> group;
    std::vector<std::uint32_t> offsets;
};
inline SdlWebGpuResolved resolve_sdl_webgpu_binding(const std::vector<SdlWebGpuBoundGroup>& groups,
                                                    std::uint32_t index, std::uint32_t binding) {
    if (index >= groups.size() || !groups[index].group)
        webgpu_refuse("a stage reads bind group " + std::to_string(index) + ", which is unset.");
    const auto& bound = groups[index];
    if (bound.group->renderer_owned)
        webgpu_refuse("a stage reads the renderer's group; its resources are the renderer's.");
    const auto found =
        std::find_if(bound.group->entries.begin(), bound.group->entries.end(),
                     [&](const auto& entry) { return webgpu_flags(entry.binding) == binding; });
    if (found == bound.group->entries.end())
        webgpu_refuse("a stage reads binding " + std::to_string(binding) + ", which is unbound.");
    SdlWebGpuResolved result;
    if (const auto* buffer = std::get_if<GpuBufferBinding>(&found->resource)) {
        result.buffer = sdl_webgpu_object<SdlWebGpuBuffer>(buffer->buffer, "buffer");
        result.offset = gpu_size(buffer->offset.value_or(0));
        if (buffer->size)
            result.size = gpu_size(*buffer->size);
        const auto& dynamic = bound.group->layout->dynamic_bindings;
        if (const auto at = std::find(dynamic.begin(), dynamic.end(), binding); at != dynamic.end())
            result.offset += bound.offsets.at(static_cast<std::size_t>(at - dynamic.begin()));
    } else {
        result.view =
            sdl_webgpu_object<SdlWebGpuView>(std::get<GpuHandle>(found->resource), "texture view");
    }
    return result;
}
/** A whole storage buffer, as SDL_GPU binds them. */
inline SDL_GPUBuffer* sdl_webgpu_storage(const SdlWebGpuResolved& resolved) {
    if (!resolved.buffer)
        webgpu_refuse("a storage binding holds a texture.");
    const auto whole = resolved.buffer->byte_size();
    if (resolved.offset != 0 || resolved.size.value_or(whole) != whole)
        webgpu_refuse("SDL_GPU binds whole storage buffers; a subrange is not represented.");
    return resolved.buffer->gpu_buffer();
}
/** The uniform bytes a binding pushes. */
inline std::span<const std::uint8_t> sdl_webgpu_uniform(const SdlWebGpuResolved& resolved) {
    if (!resolved.buffer)
        webgpu_refuse("a uniform binding holds a texture.");
    const auto& bytes = resolved.buffer->uniform_bytes();
    const auto size =
        resolved.size.value_or(bytes.size() - std::min(resolved.offset, bytes.size()));
    if (resolved.offset > bytes.size() || size > bytes.size() - resolved.offset ||
        size > std::numeric_limits<Uint32>::max())
        webgpu_refuse("a uniform binding exceeds its buffer.");
    return {bytes.data() + resolved.offset, size};
}

/** One recorded command, encoded in order into an SDL command buffer. */
struct SdlWebGpuDispatch {
    std::shared_ptr<SdlWebGpuComputePipeline> pipeline;
    std::vector<SdlWebGpuBoundGroup> groups;
    std::array<std::uint32_t, 3> workgroups{1, 1, 1};
    std::shared_ptr<SdlWebGpuBuffer> indirect;
    std::uint32_t indirect_offset = 0;
};
struct SdlWebGpuCopy {
    std::shared_ptr<SdlWebGpuBuffer> source, destination;
    std::uint32_t source_offset = 0, destination_offset = 0, size = 0;
};
struct SdlWebGpuClear {
    std::shared_ptr<SdlWebGpuBuffer> buffer;
    std::uint32_t offset = 0, size = 0;
};
using SdlWebGpuCommand = std::variant<SdlWebGpuDispatch, SdlWebGpuCopy, SdlWebGpuClear>;

inline void encode_sdl_webgpu_copy(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                   const SdlWebGpuCopy& copy) {
    if (!copy.size)
        return;
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass buffer copy");
    if (copy.destination->kind == SdlWebGpuBufferKind::readback) {
        const SDL_GPUBufferRegion from{copy.source->gpu_buffer(), copy.source_offset, copy.size};
        const SDL_GPUTransferBufferLocation to{copy.destination->transfer->get(),
                                               copy.destination_offset};
        SDL_DownloadFromGPUBuffer(pass, &from, &to);
    } else {
        const SDL_GPUBufferLocation from{copy.source->gpu_buffer(), copy.source_offset};
        const SDL_GPUBufferLocation to{copy.destination->gpu_buffer(), copy.destination_offset};
        SDL_CopyGPUBufferToBuffer(pass, &from, &to, copy.size, false);
    }
    static_cast<void>(owner);
}

/** Zeroes `size` bytes from `offset`, uploading from the owner's zero bytes (at most 1 MiB). */
inline void encode_sdl_webgpu_zeros(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                    SDL_GPUBuffer* buffer, std::uint32_t offset,
                                    std::uint32_t size) {
    if (!size)
        return;
    auto* device = owner.live_device();
    const std::uint32_t capacity =
        std::min<std::uint32_t>(std::max<std::uint32_t>(size, 4096), 1u << 20);
    if (!owner.zeros || owner.zero_bytes < capacity) {
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        info.size = capacity;
        auto zeros = owner.adopt<SdlWebGpuTransferLease>(SDL_CreateGPUTransferBuffer(device, &info),
                                                         "SDL_CreateGPUTransferBuffer clear");
        auto* mapped = SDL_MapGPUTransferBuffer(device, zeros->get(), false);
        if (!mapped)
            gpu_error("SDL_MapGPUTransferBuffer clear");
        std::memset(mapped, 0, info.size);
        SDL_UnmapGPUTransferBuffer(device, zeros->get());
        owner.zeros = std::move(zeros);
        owner.zero_bytes = info.size;
    }
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass clear");
    const SDL_GPUTransferBufferLocation from{owner.zeros->get(), 0};
    for (std::uint32_t done = 0; done < size;) {
        const auto count = std::min(owner.zero_bytes, size - done);
        const SDL_GPUBufferRegion to{buffer, offset + done, count};
        SDL_UploadToGPUBuffer(pass, &from, &to, false);
        done += count;
    }
}
inline void encode_sdl_webgpu_clear(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                    const SdlWebGpuClear& clear) {
    encode_sdl_webgpu_zeros(owner, command, clear.buffer->gpu_buffer(), clear.offset, clear.size);
}

inline void encode_sdl_webgpu_dispatch(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                       const SdlWebGpuDispatch& dispatch,
                                       SdlComputeBindingScratch& scratch) {
    const auto& pipeline = dispatch.pipeline->lease->get();
    auto& [sampled, readonly_textures, readonly_buffers, writable_textures, writable_buffers] =
        scratch;
    sampled.assign(pipeline.counts[0], {nullptr, pipeline.fallback_sampler});
    readonly_textures.clear();
    readonly_buffers.assign(pipeline.counts[2], nullptr);
    writable_textures.clear();
    writable_buffers.assign(pipeline.counts[4], {});
    if (pipeline.counts[1] || pipeline.counts[3])
        webgpu_refuse("storage textures are not in the subset.");
    for (const auto& slot : pipeline.slots) {
        const auto resolved = resolve_sdl_webgpu_binding(dispatch.groups, slot.group, slot.binding);
        if (slot.kind == 'b') {
            const auto bytes = sdl_webgpu_uniform(resolved);
            SDL_PushGPUComputeUniformData(command, slot.index, bytes.data(),
                                          static_cast<Uint32>(bytes.size()));
        } else if (slot.kind == 'r') {
            readonly_buffers.at(slot.index) = sdl_webgpu_storage(resolved);
        } else if (slot.kind == 'w') {
            writable_buffers.at(slot.index) = {sdl_webgpu_storage(resolved), false, 0, 0, 0};
        } else if (slot.kind == 't') {
            if (!resolved.view)
                webgpu_refuse("a texture binding holds a buffer.");
            sampled.at(slot.index).texture = resolved.view->texture->get();
        } else {
            webgpu_refuse("samplers and storage textures are not in the subset.");
        }
    }
    SDL_GPUBuffer* arguments = nullptr;
    if (dispatch.indirect) {
        // A dispatch may bind its argument buffer as storage; SDL_GPU then holds it in a
        // shader-resource state, so the arguments are read from a copy of their own.
        auto* device = owner.live_device();
        if (!owner.dispatch_arguments) {
            SDL_GPUBufferCreateInfo info{};
            info.usage = SDL_GPU_BUFFERUSAGE_INDIRECT;
            info.size = 12;
            owner.dispatch_arguments = owner.adopt<SdlWebGpuBufferLease>(
                SDL_CreateGPUBuffer(device, &info), "SDL_CreateGPUBuffer dispatch arguments");
        }
        arguments = owner.dispatch_arguments->get();
        SdlCopyPass copy{SDL_BeginGPUCopyPass(command)};
        if (!copy)
            gpu_error("SDL_BeginGPUCopyPass dispatch arguments");
        const SDL_GPUBufferLocation from{dispatch.indirect->gpu_buffer(), dispatch.indirect_offset};
        const SDL_GPUBufferLocation to{arguments, 0};
        SDL_CopyGPUBufferToBuffer(copy, &from, &to, 12, false);
    }
    SdlComputePass pass{SDL_BeginGPUComputePass(command, nullptr, 0, writable_buffers.data(),
                                                static_cast<Uint32>(writable_buffers.size()))};
    if (!pass)
        gpu_error("SDL_BeginGPUComputePass");
    SDL_BindGPUComputePipeline(pass, pipeline.handle);
    if (!sampled.empty())
        SDL_BindGPUComputeSamplers(pass, 0, sampled.data(), static_cast<Uint32>(sampled.size()));
    if (!readonly_buffers.empty())
        SDL_BindGPUComputeStorageBuffers(pass, 0, readonly_buffers.data(),
                                         static_cast<Uint32>(readonly_buffers.size()));
    if (arguments)
        SDL_DispatchGPUComputeIndirect(pass, arguments, 0);
    else
        SDL_DispatchGPUCompute(pass, dispatch.workgroups[0], dispatch.workgroups[1],
                               dispatch.workgroups[2]);
}

/** Encodes recorded commands, in order, into `command`. */
inline void encode_sdl_webgpu_commands(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                       const std::vector<SdlWebGpuCommand>& commands) {
    SdlComputeBindingScratch scratch;
    for (const auto& recorded : commands) {
        if (const auto* dispatch = std::get_if<SdlWebGpuDispatch>(&recorded))
            encode_sdl_webgpu_dispatch(owner, command, *dispatch, scratch);
        else if (const auto* copy = std::get_if<SdlWebGpuCopy>(&recorded))
            encode_sdl_webgpu_copy(owner, command, *copy);
        else
            encode_sdl_webgpu_clear(owner, command, std::get<SdlWebGpuClear>(recorded));
    }
}

inline std::vector<std::uint32_t> sdl_webgpu_offsets(const js::Array<double>& offsets) {
    std::vector<std::uint32_t> result;
    result.reserve(offsets.size());
    for (const double offset : offsets)
        result.push_back(webgpu_flags(offset));
    return result;
}
inline void bind_sdl_webgpu_group(std::vector<SdlWebGpuBoundGroup>& groups, double index,
                                  const GpuHandle& handle, std::vector<std::uint32_t> offsets) {
    auto group = sdl_webgpu_object<SdlWebGpuBindGroup>(handle, "bind group");
    if (offsets.size() != (group->layout ? group->layout->dynamic_bindings.size() : 0))
        webgpu_refuse("setBindGroup passes one offset per dynamic binding.");
    const auto at = webgpu_flags(index);
    if (groups.size() <= at)
        groups.resize(at + 1);
    groups[at] = {std::move(group), std::move(offsets)};
}

/** `GPUComputePassEncoder`: a recorded dispatch keeps the pass state it was issued with. */
struct SdlWebGpuComputePass final : GpuComputePassEncoder {
    std::vector<SdlWebGpuCommand>* commands = nullptr;
    std::shared_ptr<SdlWebGpuComputePipeline> pipeline;
    std::vector<SdlWebGpuBoundGroup> groups;
    std::vector<SdlWebGpuCommand>& live() const {
        if (!commands)
            webgpu_refuse("the compute pass has ended.");
        return *commands;
    }
    void set_pipeline(const GpuHandle& handle) override {
        static_cast<void>(live());
        pipeline = sdl_webgpu_object<SdlWebGpuComputePipeline>(handle, "compute pipeline");
    }
    void set_bind_group(double index, const GpuHandle& group,
                        const js::Array<double>& dynamic_offsets) override {
        static_cast<void>(live());
        bind_sdl_webgpu_group(groups, index, group, sdl_webgpu_offsets(dynamic_offsets));
    }
    SdlWebGpuDispatch dispatch() const {
        if (!pipeline)
            webgpu_refuse("a dispatch needs a pipeline.");
        return {pipeline, groups, {1, 1, 1}, nullptr, 0};
    }
    void dispatch_workgroups(double x, double y, double z) override {
        auto recorded = dispatch();
        recorded.workgroups = {webgpu_flags(x), webgpu_flags(y), webgpu_flags(z)};
        live().push_back(std::move(recorded));
    }
    void dispatch_workgroups_indirect(const GpuHandle& buffer, double offset) override {
        auto recorded = dispatch();
        recorded.indirect = sdl_webgpu_object<SdlWebGpuBuffer>(buffer, "buffer");
        if (!(recorded.indirect->usage & webgpu_buffer_usage::indirect))
            webgpu_refuse("an indirect dispatch needs a buffer created with INDIRECT.");
        recorded.indirect_offset = webgpu_flags(offset);
        require_webgpu_copy_range(recorded.indirect->byte_size(), recorded.indirect_offset, 12);
        live().push_back(std::move(recorded));
    }
    void end() override {
        static_cast<void>(live());
        commands = nullptr;
    }
};

struct SdlWebGpuCommandBuffer final : GpuObject {
    std::vector<SdlWebGpuCommand> commands;
    bool submitted = false;
};

/**
 * `GPUCommandEncoder`: it records commands; `finish()` moves them into a
 * command buffer, and a renderer encodes a borrowed frame encoder's commands
 * into its own command buffer (`encode`).
 */
struct SdlWebGpuCommandEncoder final : GpuCommandEncoder {
    std::shared_ptr<SdlWebGpuOwner> owner;
    std::vector<SdlWebGpuCommand> commands;
    std::shared_ptr<SdlWebGpuComputePass> open_pass;
    bool finished = false;
    void require_recording() const {
        if (finished)
            webgpu_refuse("the command encoder has finished.");
        if (open_pass && open_pass->commands)
            webgpu_refuse("the command encoder is locked by an open pass.");
    }
    GpuEncoderHandle begin_render_pass(const GpuRenderPassDescriptor&) override {
        webgpu_refuse("render passes belong to the renderer; the subset records compute passes.");
    }
    GpuComputePassEncoderHandle begin_compute_pass(const GpuComputePassDescriptor&) override {
        require_recording();
        open_pass = std::make_shared<SdlWebGpuComputePass>();
        open_pass->commands = &commands;
        return open_pass;
    }
    void copy_buffer_to_buffer(const GpuHandle& source, double source_offset,
                               const GpuHandle& destination, double destination_offset,
                               double size) override {
        require_recording();
        SdlWebGpuCopy copy{sdl_webgpu_object<SdlWebGpuBuffer>(source, "buffer"),
                           sdl_webgpu_object<SdlWebGpuBuffer>(destination, "buffer"),
                           webgpu_flags(source_offset), webgpu_flags(destination_offset),
                           webgpu_flags(size)};
        if (!(copy.source->usage & webgpu_buffer_usage::copy_src) ||
            !(copy.destination->usage & webgpu_buffer_usage::copy_dst))
            webgpu_refuse("copyBufferToBuffer needs COPY_SRC and COPY_DST buffers.");
        if (copy.source == copy.destination)
            webgpu_refuse("copyBufferToBuffer copies between two buffers.");
        require_webgpu_copy_range(copy.source->byte_size(), copy.source_offset, copy.size);
        require_webgpu_copy_range(copy.destination->byte_size(), copy.destination_offset,
                                  copy.size);
        commands.push_back(std::move(copy));
    }
    void clear_buffer(const GpuHandle& buffer, bbl::js::Nullable<double> offset,
                      bbl::js::Nullable<double> size) override {
        require_recording();
        SdlWebGpuClear clear{sdl_webgpu_object<SdlWebGpuBuffer>(buffer, "buffer"), 0, 0};
        if (!(clear.buffer->usage & webgpu_buffer_usage::copy_dst))
            webgpu_refuse("clearBuffer needs a COPY_DST buffer.");
        clear.offset = webgpu_flags(offset.value_or(0));
        const auto whole = clear.buffer->byte_size();
        if (clear.offset > whole)
            webgpu_refuse("clearBuffer starts past its buffer.");
        clear.size = size ? webgpu_flags(*size) : gpu_u32(whole - clear.offset);
        require_webgpu_copy_range(whole, clear.offset, clear.size);
        commands.push_back(std::move(clear));
    }
    GpuHandle finish() override {
        require_recording();
        finished = true;
        auto result = std::make_shared<SdlWebGpuCommandBuffer>();
        result->commands = std::move(commands);
        return result;
    }
    /** A borrowed frame encoder's commands, encoded before the renderer's passes. */
    void encode(SDL_GPUCommandBuffer* command) {
        require_recording();
        encode_sdl_webgpu_commands(*owner, command, commands);
        commands.clear();
    }
};

/** WebGPU format names the subset's render targets use. */
inline constexpr std::pair<std::string_view, SDL_GPUTextureFormat> sdl_webgpu_formats[] = {
    {"rgba8unorm", SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM},
    {"rgba8unorm-srgb", SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM_SRGB},
    {"bgra8unorm", SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM},
    {"bgra8unorm-srgb", SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM_SRGB},
    {"rgba16float", SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT},
    {"depth16unorm", SDL_GPU_TEXTUREFORMAT_D16_UNORM},
    {"depth24plus", SDL_GPU_TEXTUREFORMAT_D24_UNORM},
    {"depth24plus-stencil8", SDL_GPU_TEXTUREFORMAT_D24_UNORM_S8_UINT},
    {"depth32float", SDL_GPU_TEXTUREFORMAT_D32_FLOAT},
    {"depth32float-stencil8", SDL_GPU_TEXTUREFORMAT_D32_FLOAT_S8_UINT}};
inline SDL_GPUTextureFormat sdl_webgpu_format(const std::string& name) {
    for (const auto& [text, format] : sdl_webgpu_formats)
        if (text == name)
            return format;
    webgpu_refuse("texture format '" + name + "' is not admitted.");
}
/** A renderer attachment's WebGPU format name, for a target signature. */
inline std::string sdl_webgpu_format_name(SDL_GPUTextureFormat format) {
    for (const auto& [text, value] : sdl_webgpu_formats)
        if (value == format)
            return std::string(text);
    webgpu_refuse("a renderer attachment format has no admitted WebGPU name.");
}
inline SDL_GPUCompareOp sdl_webgpu_compare(const std::string& name) {
    static constexpr std::pair<std::string_view, SDL_GPUCompareOp> operations[] = {
        {"never", SDL_GPU_COMPAREOP_NEVER},
        {"less", SDL_GPU_COMPAREOP_LESS},
        {"equal", SDL_GPU_COMPAREOP_EQUAL},
        {"less-equal", SDL_GPU_COMPAREOP_LESS_OR_EQUAL},
        {"greater", SDL_GPU_COMPAREOP_GREATER},
        {"not-equal", SDL_GPU_COMPAREOP_NOT_EQUAL},
        {"greater-equal", SDL_GPU_COMPAREOP_GREATER_OR_EQUAL},
        {"always", SDL_GPU_COMPAREOP_ALWAYS}};
    for (const auto& [text, operation] : operations)
        if (text == name)
            return operation;
    webgpu_refuse("compare function '" + name + "' is not admitted.");
}
inline SDL_GPUBlendFactor sdl_webgpu_blend_factor(const std::string& name) {
    if (name == "zero")
        return SDL_GPU_BLENDFACTOR_ZERO;
    if (name == "one")
        return SDL_GPU_BLENDFACTOR_ONE;
    if (name == "src-alpha")
        return SDL_GPU_BLENDFACTOR_SRC_ALPHA;
    if (name == "one-minus-src-alpha")
        return SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    webgpu_refuse("blend factor '" + name + "' is not admitted.");
}
inline SDL_GPUCullMode sdl_webgpu_cull(const std::string& name) {
    if (name == "none")
        return SDL_GPU_CULLMODE_NONE;
    if (name == "front")
        return SDL_GPU_CULLMODE_FRONT;
    if (name == "back")
        return SDL_GPU_CULLMODE_BACK;
    webgpu_refuse("cull mode '" + name + "' is not admitted.");
}

/** A render stage's `@binding <group> <binding> <name> ...` sidecar lines, by name. */
inline std::map<std::string, std::pair<std::uint32_t, std::uint32_t>>
sdl_webgpu_stage_bindings(const std::string& stem) {
    const std::string override = environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string root =
        override.empty() ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR) : override;
    const auto bytes = read_binary_file(join_path(root, stem + ".slots"));
    std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> result;
    for_each_sidecar_line(
        std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()),
        [&](std::string_view line) {
            if (!line.starts_with("@binding "))
                return;
            std::vector<std::string_view> words;
            for (std::size_t start = 0; start < line.size();) {
                const std::size_t end = std::min(line.find(' ', start), line.size());
                if (end > start)
                    words.push_back(line.substr(start, end - start));
                start = end + 1;
            }
            const auto group = words.size() > 3 ? parse_sidecar_index(words[1]) : std::nullopt;
            const auto binding = words.size() > 3 ? parse_sidecar_index(words[2]) : std::nullopt;
            if (!group || !binding)
                webgpu_refuse(stem + ".slots has a malformed binding line.");
            result[std::string(words[3])] = {*group, *binding};
        });
    return result;
}

/** A renderer's open pass, for a renderable's `draw`. */
struct SdlWebGpuRenderPass final : GpuEncoder {
    SDL_GPUCommandBuffer* command = nullptr;
    SDL_GPURenderPass* pass = nullptr;
    std::shared_ptr<SdlWebGpuRenderPipeline> pipeline;
    std::vector<SdlWebGpuBoundGroup> groups;
    std::vector<SDL_GPUBuffer*> storage_scratch;

    void set_pipeline(const GpuHandle& handle) override {
        pipeline = sdl_webgpu_object<SdlWebGpuRenderPipeline>(handle, "render pipeline");
        SDL_BindGPUGraphicsPipeline(pass, pipeline->lease->get());
    }
    void set_vertex_buffer(double, const GpuHandle&) override {
        webgpu_refuse("the subset's render pipelines take no vertex buffers.");
    }
    void set_bind_group(double index, const GpuHandle& group) override {
        bind_sdl_webgpu_group(groups, index, group, {});
    }
    void bind_stage(const SdlWebGpuRenderStage& stage, bool fragment) {
        const auto point = [&](const std::string& name) {
            const auto found = stage.bindings.find(name);
            if (found == stage.bindings.end())
                webgpu_refuse("a stage slot '" + name + "' has no WGSL binding.");
            return resolve_sdl_webgpu_binding(groups, found->second.first, found->second.second);
        };
        if (!stage.slots.textures.empty() || !stage.slots.storage_textures.empty())
            webgpu_refuse("render stages read storage buffers and uniforms only.");
        push_stage_uniforms(command, stage.slots, fragment, "WebGPU subset stage",
                            [&](const std::string& name, std::size_t) {
                                const auto bytes = sdl_webgpu_uniform(point(name));
                                return PinnedStageBlock{bytes.data(), bytes.size()};
                            });
        bind_stage_storage(
            pass, stage.slots, fragment, "WebGPU subset stage", storage_scratch,
            [&](const std::string& name, std::size_t) { return sdl_webgpu_storage(point(name)); });
    }
    void bind() {
        if (!pipeline)
            webgpu_refuse("a draw needs a pipeline.");
        bind_stage(pipeline->vertex, false);
        bind_stage(pipeline->fragment, true);
    }
    void draw(double vertices, double instances, double first_vertex,
              double first_instance) override {
        bind();
        SDL_DrawGPUPrimitives(pass, webgpu_flags(vertices), webgpu_flags(instances),
                              webgpu_flags(first_vertex), webgpu_flags(first_instance));
    }
    void draw_indirect(const GpuHandle& buffer, double offset) override {
        const auto arguments = sdl_webgpu_object<SdlWebGpuBuffer>(buffer, "buffer");
        if (!(arguments->usage & webgpu_buffer_usage::indirect))
            webgpu_refuse("drawIndirect needs a buffer created with INDIRECT.");
        require_webgpu_copy_range(arguments->byte_size(), gpu_size(offset), 16);
        bind();
        SDL_DrawGPUPrimitivesIndirect(pass, arguments->gpu_buffer(), webgpu_flags(offset), 1);
    }
    void end() override { webgpu_refuse("a renderer's pass is ended by its renderer."); }
};

/** The WebGPU subset over an SDL_GPU device; it retires every lease it created when it ends. */
struct SdlWebGpuDevice : GpuDevice {
    std::shared_ptr<SdlWebGpuOwner> owner = std::make_shared<SdlWebGpuOwner>();

    /**
     * `limits` are the engine's `requiredLimits` over WebGPU's defaults
     * (`gpu_required_limits`); SDL_GPU sizes are 32-bit and its dispatch
     * dimensions those D3D12, Vulkan and Metal all admit.
     */
    SdlWebGpuDevice(SDL_GPUDevice* device, const GpuSupportedLimits& limits) {
        if (!device)
            webgpu_refuse("an SDL_GPU WebGPU device needs its device.");
        constexpr double sizes = std::numeric_limits<Uint32>::max();
        if (limits.max_buffer_size > sizes || limits.max_storage_buffer_binding_size > sizes ||
            limits.max_compute_workgroups_per_dimension > 65535)
            webgpu_refuse("requestDevice: a required limit exceeds what SDL_GPU represents.");
        owner->device = device;
        owner->limits = limits;
    }
    ~SdlWebGpuDevice() override { owner->retire(); }
    const void* device_identity() const override { return owner->device; }
    GpuSupportedLimits limits() const override { return owner->limits; }

    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        const auto usage = webgpu_flags(descriptor.usage);
        const auto bytes = gpu_size(descriptor.size);
        if (bytes > owner->limits.max_buffer_size)
            webgpu_refuse("createBuffer exceeds maxBufferSize.");
        auto buffer = std::make_shared<SdlWebGpuBuffer>();
        buffer->owner = owner;
        buffer->size = descriptor.size;
        buffer->usage = usage;
        using namespace webgpu_buffer_usage;
        if (usage & (map_write | index | vertex | query_resolve))
            webgpu_refuse("buffer usages outside the subset.");
        if (usage & map_read) {
            if (usage != (map_read | copy_dst) || descriptor.mapped_at_creation)
                webgpu_refuse("SDL_GPU reads back COPY_DST | MAP_READ buffers mapped by mapAsync.");
            buffer->kind = SdlWebGpuBufferKind::readback;
            SDL_GPUTransferBufferCreateInfo info{};
            info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_DOWNLOAD;
            info.size = gpu_u32(bytes);
            buffer->transfer = owner->adopt<SdlWebGpuTransferLease>(
                SDL_CreateGPUTransferBuffer(owner->live_device(), &info),
                "SDL_CreateGPUTransferBuffer readback");
        } else if (usage & uniform) {
            if (usage & (storage | indirect | copy_src))
                webgpu_refuse("SDL_GPU pushes uniform buffers from CPU bytes; a uniform buffer "
                              "the GPU reads or writes otherwise is not represented.");
            buffer->kind = SdlWebGpuBufferKind::uniform;
            buffer->bytes.assign(bytes, 0);
        } else {
            SDL_GPUBufferCreateInfo info{};
            info.size = gpu_u32(bytes);
            if (usage & storage)
                info.usage |= SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ |
                              SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ |
                              SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
            if (usage & indirect)
                info.usage |= SDL_GPU_BUFFERUSAGE_INDIRECT;
            // A copy-only buffer still needs an SDL usage.
            if (!info.usage)
                info.usage = SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ;
            auto* device = owner->live_device();
            buffer->buffer = owner->adopt<SdlWebGpuBufferLease>(SDL_CreateGPUBuffer(device, &info),
                                                                "SDL_CreateGPUBuffer");
            if (descriptor.label)
                SDL_SetGPUBufferName(device, buffer->buffer->get(), descriptor.label->c_str());
            // WebGPU buffers start zeroed, mapped ones included: unmap writes only the
            // ranges getMappedRange returned.
            SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
            if (!command)
                gpu_error("SDL_AcquireGPUCommandBuffer buffer zeroes");
            encode_sdl_webgpu_zeros(*owner, command, buffer->buffer->get(), 0, info.size);
            if (!command.submit())
                gpu_error("SDL_SubmitGPUCommandBuffer buffer zeroes");
        }
        if (descriptor.mapped_at_creation)
            buffer->mapping.map_at_creation(bytes);
        return buffer;
    }

    GpuHandle create_texture(const GpuTextureDescriptor& descriptor) override {
        if (descriptor.format != "rgba8unorm")
            webgpu_refuse("the subset creates rgba8unorm textures only.");
        const auto usage = webgpu_flags(descriptor.usage);
        if (usage & webgpu_texture_usage::storage_binding)
            webgpu_refuse("storage textures are not in the subset.");
        SDL_GPUTextureCreateInfo info{};
        info.type = SDL_GPU_TEXTURETYPE_2D;
        info.format = SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        info.width = gpu_u32(gpu_size(descriptor.size.width));
        info.height = gpu_u32(gpu_size(descriptor.size.height));
        info.layer_count_or_depth = gpu_u32(gpu_size(descriptor.size.depth_or_array_layers));
        info.num_levels = 1;
        info.sample_count = SDL_GPU_SAMPLECOUNT_1;
        if (usage & webgpu_texture_usage::texture_binding)
            info.usage |= SDL_GPU_TEXTUREUSAGE_SAMPLER;
        if (usage & webgpu_texture_usage::render_attachment)
            info.usage |= SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
        if (info.layer_count_or_depth != 1)
            webgpu_refuse("the subset creates single-layer textures.");
        auto texture = std::make_shared<SdlWebGpuTexture>();
        texture->owner = owner;
        texture->usage = usage;
        texture->width = info.width;
        texture->height = info.height;
        texture->lease = owner->adopt<SdlWebGpuTextureLease>(
            SDL_CreateGPUTexture(owner->live_device(), &info), "SDL_CreateGPUTexture");
        return texture;
    }

    GpuHandle create_bind_group_layout(const GpuBindGroupLayoutDescriptor& descriptor) override {
        auto layout = std::make_shared<SdlWebGpuBindGroupLayout>();
        layout->entries = webgpu_layout_entries(descriptor);
        for (const auto& entry : layout->entries)
            if (entry.dynamic_offset)
                layout->dynamic_bindings.push_back(entry.binding);
        std::sort(layout->dynamic_bindings.begin(), layout->dynamic_bindings.end());
        return layout;
    }

    GpuHandle create_shader_module(const GpuShaderModuleDescriptor& descriptor) override {
        auto module = std::make_shared<SdlWebGpuShaderModule>();
        module->code = descriptor.code;
        return module;
    }

    GpuHandle create_pipeline_layout(const GpuPipelineLayoutDescriptor& descriptor) override {
        auto layout = std::make_shared<SdlWebGpuPipelineLayout>();
        for (const auto& group : descriptor.bind_group_layouts) {
            static_cast<void>(
                sdl_webgpu_object<SdlWebGpuBindGroupLayout>(group, "bind group layout"));
            layout->groups.push_back(group);
        }
        return layout;
    }

    GpuHandle create_compute_pipeline(const GpuComputePipelineDescriptor& descriptor) override {
        static_cast<void>(
            sdl_webgpu_object<SdlWebGpuPipelineLayout>(descriptor.layout, "pipeline layout"));
        const auto module =
            sdl_webgpu_object<SdlWebGpuShaderModule>(descriptor.compute.module, "shader module");
        if (!descriptor.compute.entry_point)
            webgpu_refuse("SDL_GPU compute stages are found by their named entry point.");
        const auto& entry = *descriptor.compute.entry_point;
        const auto stem = wgsl_stage_stem(module->code, entry, "comp");
        auto pipeline = std::make_shared<SdlWebGpuComputePipeline>();
        pipeline->layout = descriptor.layout;
        pipeline->lease = std::make_shared<SdlWebGpuComputeLease>();
        pipeline->lease->pipeline = load_sdl_webgpu_stage(
            stem, [&] { return load_sdl_gpu_compute_pipeline(owner->live_device(), stem, entry); });
        owner->leases.track(pipeline->lease);
        return pipeline;
    }

    GpuHandle create_render_pipeline(const GpuRenderPipelineDescriptor& descriptor) override {
        static_cast<void>(
            sdl_webgpu_object<SdlWebGpuPipelineLayout>(descriptor.layout, "pipeline layout"));
        if (!descriptor.fragment || descriptor.fragment->targets.size() != 1)
            webgpu_refuse("render pipelines have a fragment stage with one target.");
        if (!descriptor.vertex.entry_point || !descriptor.fragment->entry_point)
            webgpu_refuse("SDL_GPU render stages are found by their named entry points.");
        const auto vertex_stem = wgsl_stage_stem(
            sdl_webgpu_object<SdlWebGpuShaderModule>(descriptor.vertex.module, "shader module")
                ->code,
            *descriptor.vertex.entry_point, "vert");
        const auto fragment_stem = wgsl_stage_stem(
            sdl_webgpu_object<SdlWebGpuShaderModule>(descriptor.fragment->module, "shader module")
                ->code,
            *descriptor.fragment->entry_point, "frag");
        auto* device = owner->live_device();
        PinnedStage vertex = load_sdl_webgpu_stage(vertex_stem, [&] {
            return load_pinned_stage(device, vertex_stem, SDL_GPU_SHADERSTAGE_VERTEX);
        });
        PinnedStage fragment = load_sdl_webgpu_stage(fragment_stem, [&] {
            return load_pinned_stage(device, fragment_stem, SDL_GPU_SHADERSTAGE_FRAGMENT);
        });
        const auto& target = descriptor.fragment->targets[0];
        SDL_GPUColorTargetDescription color{};
        color.format = sdl_webgpu_format(target.format);
        const auto mask = webgpu_flags(target.write_mask.value_or(0xF));
        color.blend_state.enable_color_write_mask = true;
        color.blend_state.color_write_mask = static_cast<SDL_GPUColorComponentFlags>(mask);
        if (target.blend) {
            const auto component = [](const GpuBlendComponent& source, SDL_GPUBlendFactor& src,
                                      SDL_GPUBlendFactor& dst, SDL_GPUBlendOp& operation) {
                if (source.operation.value_or(std::string("add")) != "add")
                    webgpu_refuse("blend operations other than 'add' are not admitted.");
                operation = SDL_GPU_BLENDOP_ADD;
                src = sdl_webgpu_blend_factor(source.src_factor.value_or(std::string("one")));
                dst = sdl_webgpu_blend_factor(source.dst_factor.value_or(std::string("zero")));
            };
            color.blend_state.enable_blend = true;
            component(target.blend->color, color.blend_state.src_color_blendfactor,
                      color.blend_state.dst_color_blendfactor, color.blend_state.color_blend_op);
            component(target.blend->alpha, color.blend_state.src_alpha_blendfactor,
                      color.blend_state.dst_alpha_blendfactor, color.blend_state.alpha_blend_op);
        }
        SDL_GPUGraphicsPipelineCreateInfo info{};
        info.fragment_shader = fragment.shader.get();
        info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
        info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
        info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
        if (descriptor.primitive) {
            if (descriptor.primitive->topology.value_or(std::string("triangle-list")) !=
                "triangle-list")
                webgpu_refuse("render pipelines draw triangle lists.");
            info.rasterizer_state.cull_mode =
                sdl_webgpu_cull(descriptor.primitive->cull_mode.value_or(std::string("none")));
        }
        info.multisample_state.sample_count = gpu_sample_count_from(
            descriptor.multisample ? webgpu_flags(descriptor.multisample->count.value_or(1)) : 1u);
        info.target_info.color_target_descriptions = &color;
        info.target_info.num_color_targets = 1;
        if (descriptor.depth_stencil) {
            info.target_info.has_depth_stencil_target = true;
            info.target_info.depth_stencil_format =
                sdl_webgpu_format(descriptor.depth_stencil->format);
            info.depth_stencil_state.enable_depth_test = true;
            info.depth_stencil_state.enable_depth_write =
                descriptor.depth_stencil->depth_write_enabled.value_or(false);
            info.depth_stencil_state.compare_op = sdl_webgpu_compare(
                descriptor.depth_stencil->depth_compare.value_or(std::string("always")));
        }
        auto pipeline = std::make_shared<SdlWebGpuRenderPipeline>();
        pipeline->layout = descriptor.layout;
        pipeline->lease = owner->adopt<SdlWebGpuGraphicsLease>(
            create_sdl_gpu_graphics_pipeline(device, vertex.shader, &info),
            "SDL_CreateGPUGraphicsPipeline");
        pipeline->vertex = {std::move(vertex.slots), sdl_webgpu_stage_bindings(vertex_stem)};
        pipeline->fragment = {std::move(fragment.slots), sdl_webgpu_stage_bindings(fragment_stem)};
        return pipeline;
    }

    GpuHandle create_bind_group(const GpuBindGroupDescriptor& descriptor) override {
        auto group = std::make_shared<SdlWebGpuBindGroup>();
        group->layout =
            sdl_webgpu_object<SdlWebGpuBindGroupLayout>(descriptor.layout, "bind group layout");
        for (const auto& entry : descriptor.entries) {
            const auto binding = webgpu_flags(entry.binding);
            const auto layout_entry =
                std::find_if(group->layout->entries.begin(), group->layout->entries.end(),
                             [&](const WebGpuLayoutEntry& row) { return row.binding == binding; });
            if (layout_entry == group->layout->entries.end())
                webgpu_refuse("bind group entry " + std::to_string(binding) +
                              " is absent from its layout.");
            if (const auto* buffer = std::get_if<GpuBufferBinding>(&entry.resource)) {
                const auto native = sdl_webgpu_object<SdlWebGpuBuffer>(buffer->buffer, "buffer");
                const bool uniform = layout_entry->buffer == WebGpuBufferBinding::uniform;
                if (layout_entry->texture || (uniform ? native->kind != SdlWebGpuBufferKind::uniform
                                                      : native->kind != SdlWebGpuBufferKind::gpu))
                    webgpu_refuse("bind group entry " + std::to_string(binding) +
                                  " does not match its layout's resource.");
            } else if (!layout_entry->texture) {
                webgpu_refuse("bind group entry " + std::to_string(binding) +
                              " binds a view where its layout declares a buffer.");
            } else {
                static_cast<void>(
                    sdl_webgpu_object<SdlWebGpuView>(std::get<GpuHandle>(entry.resource), "view"));
            }
            group->entries.push_back(entry);
        }
        return group;
    }

    GpuCommandEncoderHandle create_command_encoder(const GpuCommandEncoderDescriptor&) override {
        auto encoder = std::make_shared<SdlWebGpuCommandEncoder>();
        encoder->owner = owner;
        return encoder;
    }

    void submit(const js::Array<GpuHandle>& command_buffers) override {
        auto* device = owner->live_device();
        for (const auto& handle : command_buffers) {
            const auto commands =
                sdl_webgpu_object<SdlWebGpuCommandBuffer>(handle, "command buffer");
            if (commands->submitted)
                webgpu_refuse("a command buffer is submitted once.");
            commands->submitted = true;
            SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
            if (!command)
                gpu_error("SDL_AcquireGPUCommandBuffer submit");
            encode_sdl_webgpu_commands(*owner, command, commands->commands);
            if (!command.submit())
                gpu_error("SDL_SubmitGPUCommandBuffer submit");
            commands->commands.clear();
        }
    }

    js::Promise<js::PromiseVoid> on_submitted_work_done() override {
        if (!owner->device)
            return js::Promise<js::PromiseVoid>::rejected(std::make_exception_ptr(
                std::runtime_error("WebGPU subset: the GPU device was retired.")));
        return settle_webgpu_operation(
            [device = owner->device](std::function<void(std::exception_ptr)> complete) {
                return std::make_unique<SdlSubmissionCompletion>(device, std::move(complete));
            });
    }

    /** A frame encoder whose commands the renderer encodes before its passes (`encode`). */
    std::shared_ptr<SdlWebGpuCommandEncoder> frame_command_encoder() const {
        auto encoder = std::make_shared<SdlWebGpuCommandEncoder>();
        encoder->owner = owner;
        return encoder;
    }
    /** A renderer's open pass on `command`, for a renderable's `draw`. */
    static GpuEncoderHandle borrow_render_pass(SDL_GPUCommandBuffer* command,
                                               SDL_GPURenderPass* pass) {
        if (!command || !pass)
            webgpu_refuse("a renderer pass needs its command buffer and pass.");
        auto result = std::make_shared<SdlWebGpuRenderPass>();
        result->command = command;
        result->pass = pass;
        return result;
    }
    /** The renderer's group 0 layout and group: SDL_GPU binds their resources per pass. */
    static GpuHandle renderer_bind_group_layout() {
        return std::make_shared<SdlWebGpuBindGroupLayout>();
    }
    static GpuHandle renderer_bind_group(const GpuHandle& layout) {
        auto group = std::make_shared<SdlWebGpuBindGroup>();
        group->layout = sdl_webgpu_object<SdlWebGpuBindGroupLayout>(layout, "bind group layout");
        group->renderer_owned = true;
        return group;
    }
};

/** `Engine::webgpu_device` over the engine's SDL_GPU device, created on first use. */
inline SdlWebGpuDevice& sdl_engine_webgpu_device(Engine& engine, SDL_GPUDevice* device) {
    if (!engine.webgpu_device)
        engine.webgpu_device = std::make_shared<SdlWebGpuDevice>(
            device, gpu_required_limits(engine.options.required_limits));
    auto* result = dynamic_cast<SdlWebGpuDevice*>(engine.webgpu_device.get());
    if (!result || result->device_identity() != device)
        webgpu_refuse("the engine's WebGPU device belongs to another GPU device.");
    return *result;
}

} // namespace bbl::pal
