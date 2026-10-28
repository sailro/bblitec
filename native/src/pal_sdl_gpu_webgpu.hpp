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

struct SdlWebGpuOwner;
/** One SDL object (`SdlGpuLease`); WebGPU's `destroy()` releases it. */
template <class Resource, auto Release>
using SdlWebGpuLease = SdlGpuLease<SdlWebGpuOwner, Resource, Release>;
using SdlWebGpuBufferLease = SdlWebGpuLease<SDL_GPUBuffer, SDL_ReleaseGPUBuffer>;
using SdlWebGpuTransferLease = SdlWebGpuLease<SDL_GPUTransferBuffer, SDL_ReleaseGPUTransferBuffer>;
using SdlWebGpuTextureLease = SdlWebGpuLease<SDL_GPUTexture, SDL_ReleaseGPUTexture>;
using SdlWebGpuSamplerLease = SdlWebGpuLease<SDL_GPUSampler, SDL_ReleaseGPUSampler>;
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

/** A staged queue write (`SdlWebGpuOwner::uploads`): ring bytes, or zeroes. */
struct SdlWebGpuUpload {
    std::shared_ptr<SdlWebGpuBufferLease> buffer;
    std::shared_ptr<SdlWebGpuTextureLease> texture;
    /** The bytes' offset in the upload ring; unused for zeroes. */
    std::uint32_t source = 0;
    /** The buffer range, or the texture extent. */
    std::uint32_t offset = 0, size = 0, width = 0, height = 0;
    bool zeros = false;
};

/** The device a WebGPU object belongs to; it outlives no lease it created. */
struct SdlWebGpuOwner : std::enable_shared_from_this<SdlWebGpuOwner> {
    SDL_GPUDevice* device = nullptr;
    GpuSupportedLimits limits;
    GpuLeaseRetirement leases;
    /** Zeroed upload bytes `clearBuffer` and new buffers copy from. */
    std::shared_ptr<SdlWebGpuTransferLease> zeros;
    std::uint32_t zero_bytes = 0;
    /**
     * Queue writes and new buffers' zeroes, staged in one growing transfer
     * ring and recorded, in order, into one copy pass ahead of the next
     * commands the device encodes or submits (`record_sdl_webgpu_uploads`).
     */
    std::shared_ptr<SdlWebGpuTransferLease> upload_ring;
    std::uint32_t upload_capacity = 0, upload_used = 0;
    /** The ring was submitted: the next staging maps a fresh backing. */
    bool upload_cycle = false;
    std::vector<SdlWebGpuUpload> uploads;
    /** Indirect dispatch arguments, copied apart from buffers dispatches bind: 16-byte slots. */
    std::shared_ptr<SdlWebGpuBufferLease> dispatch_arguments;
    std::uint32_t dispatch_argument_slots = 0;

    SDL_GPUDevice* live_device() const {
        if (!device)
            webgpu_refuse("the GPU device was retired.");
        return device;
    }
    template <class Lease, class Handle>
    std::shared_ptr<Lease> adopt(Handle* handle, const char* what) {
        if (!handle)
            gpu_error(what);
        static_cast<void>(live_device());
        auto lease = std::make_shared<Lease>();
        lease->owner = shared_from_this();
        lease->handle = handle;
        leases.track(lease);
        return lease;
    }
    void retire() noexcept {
        uploads.clear();
        leases.retire();
        zeros.reset();
        upload_ring.reset();
        upload_capacity = upload_used = 0;
        dispatch_arguments.reset();
        dispatch_argument_slots = 0;
        device = nullptr;
    }
};

/** The owner's zero bytes, at least `size` of them up to 1 MiB, which zero fills repeat. */
inline void ensure_sdl_webgpu_zeros(SdlWebGpuOwner& owner, std::uint32_t size) {
    const std::uint32_t capacity =
        std::min<std::uint32_t>(std::max<std::uint32_t>(size, 4096), 1u << 20);
    if (owner.zeros && owner.zero_bytes >= capacity)
        return;
    auto* device = owner.live_device();
    SDL_GPUTransferBufferCreateInfo info{};
    info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    info.size = capacity;
    auto zeros = owner.adopt<SdlWebGpuTransferLease>(SDL_CreateGPUTransferBuffer(device, &info),
                                                     "SDL_CreateGPUTransferBuffer zeroes");
    auto* mapped = SDL_MapGPUTransferBuffer(device, zeros->get(), false);
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer zeroes");
    std::memset(mapped, 0, info.size);
    SDL_UnmapGPUTransferBuffer(device, zeros->get());
    owner.zeros = std::move(zeros);
    owner.zero_bytes = info.size;
}
/** Zeroes `size` bytes from `offset` in an open copy pass (`ensure_sdl_webgpu_zeros` first). */
inline void record_sdl_webgpu_zeros(SdlWebGpuOwner& owner, SDL_GPUCopyPass* pass,
                                    SDL_GPUBuffer* buffer, std::uint32_t offset,
                                    std::uint32_t size) {
    const SDL_GPUTransferBufferLocation from{owner.zeros->get(), 0};
    for (std::uint32_t done = 0; done < size;) {
        const auto count = std::min(owner.zero_bytes, size - done);
        const SDL_GPUBufferRegion to{buffer, offset + done, count};
        SDL_UploadToGPUBuffer(pass, &from, &to, false);
        done += count;
    }
}

/**
 * Records the staged uploads, in order, into one copy pass on `command`,
 * ahead of the commands encoded after it. An upload whose destination was
 * destroyed since is dropped, as WebGPU's write to it would be moot.
 */
inline void record_sdl_webgpu_uploads(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command) {
    if (owner.uploads.empty())
        return;
    std::uint32_t zeros = 0;
    for (const auto& upload : owner.uploads)
        if (upload.zeros)
            zeros = std::max(zeros, upload.size);
    if (zeros)
        ensure_sdl_webgpu_zeros(owner, zeros);
    {
        SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
        if (!pass)
            gpu_error("SDL_BeginGPUCopyPass uploads");
        for (const auto& upload : owner.uploads) {
            if (upload.texture) {
                if (!upload.texture->live())
                    continue;
                const SDL_GPUTextureTransferInfo source{owner.upload_ring->get(), upload.source,
                                                        upload.width, upload.height};
                const SDL_GPUTextureRegion destination{
                    upload.texture->get(), 0, 0, 0, 0, 0, upload.width, upload.height, 1};
                SDL_UploadToGPUTexture(pass, &source, &destination, false);
            } else if (upload.buffer->live()) {
                if (upload.zeros) {
                    record_sdl_webgpu_zeros(owner, pass, upload.buffer->get(), upload.offset,
                                            upload.size);
                } else {
                    const SDL_GPUTransferBufferLocation source{owner.upload_ring->get(),
                                                               upload.source};
                    const SDL_GPUBufferRegion destination{upload.buffer->get(), upload.offset,
                                                          upload.size};
                    SDL_UploadToGPUBuffer(pass, &source, &destination, false);
                }
            }
        }
    }
    owner.uploads.clear();
    owner.upload_used = 0;
    owner.upload_cycle = true;
}
/** Submits the staged uploads on a command buffer of their own. */
inline void submit_sdl_webgpu_uploads(SdlWebGpuOwner& owner) {
    if (owner.uploads.empty())
        return;
    SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(owner.live_device())};
    if (!command)
        gpu_error("SDL_AcquireGPUCommandBuffer uploads");
    record_sdl_webgpu_uploads(owner, command);
    if (!command.submit())
        gpu_error("SDL_SubmitGPUCommandBuffer uploads");
}
/**
 * Copies `bytes` into the upload ring at an `alignment`-aligned offset and
 * returns it. A full ring submits what it holds first; a write larger than
 * the ring grows it.
 */
inline std::uint32_t stage_sdl_webgpu_upload(SdlWebGpuOwner& owner,
                                             std::span<const std::uint8_t> bytes,
                                             std::uint32_t alignment) {
    auto* device = owner.live_device();
    const std::uint64_t count = bytes.size();
    const auto aligned = [&] {
        return (std::uint64_t{owner.upload_used} + alignment - 1) / alignment * alignment;
    };
    if (owner.upload_ring && aligned() + count > owner.upload_capacity && !owner.uploads.empty())
        submit_sdl_webgpu_uploads(owner);
    if (!owner.upload_ring || aligned() + count > owner.upload_capacity) {
        const std::uint64_t capacity = std::max<std::uint64_t>(
            {std::uint64_t{4} << 20, std::uint64_t{owner.upload_capacity} * 2, count});
        SDL_GPUTransferBufferCreateInfo info{};
        info.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
        info.size = gpu_u32(static_cast<std::size_t>(capacity));
        owner.upload_ring = owner.adopt<SdlWebGpuTransferLease>(
            SDL_CreateGPUTransferBuffer(device, &info), "SDL_CreateGPUTransferBuffer uploads");
        owner.upload_capacity = info.size;
        owner.upload_used = 0;
        owner.upload_cycle = false;
    }
    const auto start = static_cast<std::uint32_t>(aligned());
    auto* mapped = static_cast<std::uint8_t*>(
        SDL_MapGPUTransferBuffer(device, owner.upload_ring->get(), owner.upload_cycle));
    if (!mapped)
        gpu_error("SDL_MapGPUTransferBuffer uploads");
    owner.upload_cycle = false;
    std::memcpy(mapped + start, bytes.data(), bytes.size());
    SDL_UnmapGPUTransferBuffer(device, owner.upload_ring->get());
    owner.upload_used = start + static_cast<std::uint32_t>(count);
    return start;
}
/** `queue.writeBuffer` into an SDL buffer, staged until the next encoded commands. */
inline void stage_sdl_webgpu_buffer_write(SdlWebGpuOwner& owner,
                                          const std::shared_ptr<SdlWebGpuBufferLease>& buffer,
                                          std::size_t offset, std::span<const std::uint8_t> bytes) {
    if (bytes.empty())
        return;
    static_cast<void>(buffer->get());
    const auto source = stage_sdl_webgpu_upload(owner, bytes, 16);
    owner.uploads.push_back(
        {buffer, {}, source, gpu_u32(offset), gpu_u32(bytes.size()), 0, 0, false});
}

/** Loads a generation-compiled stage, refusing an entry point generation did not compile. */
template <class Load> auto load_sdl_webgpu_stage(const std::string& stem, Load load) {
    try {
        return load();
    } catch (const std::exception& error) {
        webgpu_refuse("the WGSL stage '" + stem + "' was not compiled at generation for SDL_GPU (" +
                      error.what() + ").");
    }
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
    bool resource_alive() const noexcept override {
        if (destroyed || !owner || !owner->device)
            return false;
        if (kind == SdlWebGpuBufferKind::gpu)
            return buffer && buffer->live();
        if (kind == SdlWebGpuBufferKind::readback)
            return transfer && transfer->live();
        return true;
    }
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
            stage_sdl_webgpu_buffer_write(*owner, buffer, offset, source);
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
                stage_sdl_webgpu_buffer_write(*owner, buffer, range.offset, source);
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
/** `GPUSampler`. */
struct SdlWebGpuSampler final : GpuObject {
    std::shared_ptr<SdlWebGpuSamplerLease> lease;
};
/** `GPUTexture`: rgba8unorm. */
struct SdlWebGpuTexture final : GpuObject {
    std::shared_ptr<SdlWebGpuOwner> owner;
    std::shared_ptr<SdlWebGpuTextureLease> lease;
    std::uint32_t usage = 0;
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
        if (!extent.width || !extent.height)
            return;
        static_cast<void>(lease->get());
        // Texture copies read 512-byte aligned placements on D3D12.
        const auto source =
            stage_sdl_webgpu_upload(*owner, data.subspan(layout.offset, row * extent.height), 512);
        owner->uploads.push_back({{}, lease, source, 0, 0, extent.width, extent.height, false});
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
    GpuHandle get_bind_group_layout(double index) override;
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
    GpuHandle get_bind_group_layout(double index) override;
};
/** `getBindGroupLayout(index)` of a pipeline's layout. */
inline GpuHandle sdl_webgpu_group_layout(const GpuHandle& layout, double index) {
    const auto& groups = webgpu_object<SdlWebGpuPipelineLayout>(layout, "pipeline layout")->groups;
    const auto group = webgpu_flags(index);
    if (group >= groups.size())
        webgpu_refuse("getBindGroupLayout names a group the pipeline has none of.");
    return groups[group];
}
inline GpuHandle SdlWebGpuComputePipeline::get_bind_group_layout(double index) {
    return sdl_webgpu_group_layout(layout, index);
}
inline GpuHandle SdlWebGpuRenderPipeline::get_bind_group_layout(double index) {
    return sdl_webgpu_group_layout(layout, index);
}
/**
 * `layout: "auto"`: the bind group layouts a compiled compute stage's
 * slots declare, group by group (the dispatch's own workgroup counts bind
 * outside them).
 */
inline GpuHandle sdl_webgpu_derived_layout(const std::vector<SdlComputeSlot>& slots) {
    auto layout = std::make_shared<SdlWebGpuPipelineLayout>();
    std::vector<std::shared_ptr<SdlWebGpuBindGroupLayout>> groups;
    for (const auto& slot : slots) {
        if (slot.workgroup_counts)
            continue;
        while (groups.size() <= slot.group)
            groups.push_back(std::make_shared<SdlWebGpuBindGroupLayout>());
        WebGpuLayoutEntry entry;
        entry.binding = slot.binding;
        entry.visibility = webgpu_shader_stage::compute;
        if (slot.kind == 'b')
            entry.buffer = WebGpuBufferBinding::uniform;
        else if (slot.kind == 'r')
            entry.buffer = WebGpuBufferBinding::read_only_storage;
        else if (slot.kind == 'w')
            entry.buffer = WebGpuBufferBinding::storage;
        else if (slot.kind == 't')
            entry.texture = true;
        else if (slot.kind == 's')
            entry.sampler = true;
        else
            webgpu_refuse("a derived layout binds no storage textures.");
        groups[slot.group]->entries.push_back(entry);
    }
    for (auto& group : groups) {
        std::sort(group->entries.begin(), group->entries.end(),
                  [](const auto& left, const auto& right) { return left.binding < right.binding; });
        layout->groups.push_back(group);
    }
    return layout;
}
/** A bind group entry, resolved to its SDL object when the group is created. */
struct SdlWebGpuGroupEntry {
    std::uint32_t binding = 0;
    std::shared_ptr<SdlWebGpuBuffer> buffer;
    std::size_t offset = 0;
    std::optional<std::size_t> size;
    std::shared_ptr<SdlWebGpuView> view;
    std::shared_ptr<SdlWebGpuSampler> sampler;
    /** Its place among the layout's dynamic offsets, for a dynamic binding. */
    std::optional<std::size_t> dynamic;
};
/** `GPUBindGroup`: its layout and entries; SDL_GPU binds them per command. */
struct SdlWebGpuBindGroup final : GpuObject {
    std::shared_ptr<SdlWebGpuBindGroupLayout> layout;
    std::vector<SdlWebGpuGroupEntry> entries;
};

/** The resource at `binding` of a bound group, at its dynamic offset, while the group is bound. */
struct SdlWebGpuResolved {
    const SdlWebGpuBuffer* buffer = nullptr;
    std::size_t offset = 0;
    std::optional<std::size_t> size;
    const SdlWebGpuView* view = nullptr;
    const SdlWebGpuSampler* sampler = nullptr;
};
struct SdlWebGpuBoundGroup {
    std::shared_ptr<SdlWebGpuBindGroup> group;
    std::vector<std::uint32_t> offsets;
};
/** A pass's bound groups, shared by the commands recorded until a group changes. */
using SdlWebGpuBoundGroups = std::shared_ptr<const std::vector<SdlWebGpuBoundGroup>>;
inline SdlWebGpuResolved resolve_sdl_webgpu_binding(const std::vector<SdlWebGpuBoundGroup>& groups,
                                                    std::uint32_t index, std::uint32_t binding) {
    if (index >= groups.size() || !groups[index].group)
        webgpu_refuse("a stage reads bind group " + std::to_string(index) + ", which is unset.");
    const auto& bound = groups[index];
    for (const auto& entry : bound.group->entries)
        if (entry.binding == binding)
            return {entry.buffer.get(),
                    entry.offset + (entry.dynamic ? bound.offsets[*entry.dynamic] : 0), entry.size,
                    entry.view.get(), entry.sampler.get()};
    webgpu_refuse("a stage reads binding " + std::to_string(binding) + ", which is unbound.");
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
    SdlWebGpuBoundGroups groups;
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

inline void encode_sdl_webgpu_clear(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                    const SdlWebGpuClear& clear) {
    if (!clear.size)
        return;
    ensure_sdl_webgpu_zeros(owner, clear.size);
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass clear");
    record_sdl_webgpu_zeros(owner, pass, clear.buffer->gpu_buffer(), clear.offset, clear.size);
}

/**
 * Indirect dispatch arguments copied while one command buffer encodes: a
 * dispatch may bind its argument buffer as storage, and SDL_GPU then holds it
 * in a shader-resource state, so the arguments are read from a copy in a slot
 * of the owner's argument buffer. Each (buffer, offset) is copied once and
 * reused until a later command writes that buffer.
 */
struct SdlWebGpuArgumentCopies {
    struct Copy {
        SDL_GPUBuffer* source = nullptr;
        std::uint32_t offset = 0;
        SDL_GPUBuffer* arguments = nullptr;
        /** The byte offset of its slot in `arguments`. */
        std::uint32_t slot = 0;
    };
    std::vector<Copy> copies;
    std::uint32_t next = 0;
    /** Argument buffers outgrown while this command buffer encodes. */
    std::vector<std::shared_ptr<SdlWebGpuBufferLease>> outgrown;
    void written(SDL_GPUBuffer* buffer) {
        std::erase_if(copies, [&](const Copy& copy) { return copy.source == buffer; });
    }
};
inline constexpr std::uint32_t sdl_webgpu_argument_stride = 16;
/** The copy of the arguments at `offset` in `source`, made once per write of `source`. */
inline const SdlWebGpuArgumentCopies::Copy&
copy_sdl_webgpu_arguments(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                          SdlWebGpuArgumentCopies& copies, SDL_GPUBuffer* source,
                          std::uint32_t offset) {
    for (const auto& copy : copies.copies)
        if (copy.source == source && copy.offset == offset)
            return copy;
    if (copies.next >= owner.dispatch_argument_slots) {
        const auto slots = std::max<std::uint32_t>(8, owner.dispatch_argument_slots * 2);
        SDL_GPUBufferCreateInfo info{};
        info.usage = SDL_GPU_BUFFERUSAGE_INDIRECT;
        info.size = slots * sdl_webgpu_argument_stride;
        auto grown =
            owner.adopt<SdlWebGpuBufferLease>(SDL_CreateGPUBuffer(owner.live_device(), &info),
                                              "SDL_CreateGPUBuffer dispatch arguments");
        if (owner.dispatch_arguments)
            copies.outgrown.push_back(std::move(owner.dispatch_arguments));
        owner.dispatch_arguments = std::move(grown);
        owner.dispatch_argument_slots = slots;
        copies.next = 0;
    }
    SdlWebGpuArgumentCopies::Copy copy{source, offset, owner.dispatch_arguments->get(),
                                       copies.next++ * sdl_webgpu_argument_stride};
    SdlCopyPass pass{SDL_BeginGPUCopyPass(command)};
    if (!pass)
        gpu_error("SDL_BeginGPUCopyPass dispatch arguments");
    const SDL_GPUBufferLocation from{source, offset};
    const SDL_GPUBufferLocation to{copy.arguments, copy.slot};
    SDL_CopyGPUBufferToBuffer(pass, &from, &to, 12, false);
    copies.copies.push_back(copy);
    return copies.copies.back();
}

inline void encode_sdl_webgpu_dispatch(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                       const SdlWebGpuDispatch& dispatch,
                                       SdlComputeBindingScratch& scratch,
                                       SdlWebGpuArgumentCopies& copies) {
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
    std::vector<OwnedSdlBuffer> workgroup_counts;
    for (const auto& slot : pipeline.slots) {
        if (slot.workgroup_counts) {
            workgroup_counts.push_back(encode_sdl_workgroup_counts(
                owner.live_device(), command, dispatch.workgroups,
                dispatch.indirect ? dispatch.indirect->gpu_buffer() : nullptr,
                dispatch.indirect_offset));
            readonly_buffers.at(slot.index) = workgroup_counts.back().get();
            continue;
        }
        const auto resolved =
            resolve_sdl_webgpu_binding(*dispatch.groups, slot.group, slot.binding);
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
    const SdlWebGpuArgumentCopies::Copy* arguments =
        dispatch.indirect
            ? &copy_sdl_webgpu_arguments(owner, command, copies, dispatch.indirect->gpu_buffer(),
                                         dispatch.indirect_offset)
            : nullptr;
    {
        SdlComputePass pass{SDL_BeginGPUComputePass(command, nullptr, 0, writable_buffers.data(),
                                                    static_cast<Uint32>(writable_buffers.size()))};
        if (!pass)
            gpu_error("SDL_BeginGPUComputePass");
        SDL_BindGPUComputePipeline(pass, pipeline.handle);
        if (!sampled.empty())
            SDL_BindGPUComputeSamplers(pass, 0, sampled.data(),
                                       static_cast<Uint32>(sampled.size()));
        if (!readonly_buffers.empty())
            SDL_BindGPUComputeStorageBuffers(pass, 0, readonly_buffers.data(),
                                             static_cast<Uint32>(readonly_buffers.size()));
        if (arguments)
            SDL_DispatchGPUComputeIndirect(pass, arguments->arguments, arguments->slot);
        else
            SDL_DispatchGPUCompute(pass, dispatch.workgroups[0], dispatch.workgroups[1],
                                   dispatch.workgroups[2]);
    }
    for (const auto& writable : writable_buffers)
        copies.written(writable.buffer);
}

/** Encodes recorded commands, in order, into `command`. */
inline void encode_sdl_webgpu_commands(SdlWebGpuOwner& owner, SDL_GPUCommandBuffer* command,
                                       const std::vector<SdlWebGpuCommand>& commands) {
    SdlComputeBindingScratch scratch;
    SdlWebGpuArgumentCopies copies;
    for (const auto& recorded : commands) {
        if (const auto* dispatch = std::get_if<SdlWebGpuDispatch>(&recorded)) {
            encode_sdl_webgpu_dispatch(owner, command, *dispatch, scratch, copies);
        } else if (const auto* copy = std::get_if<SdlWebGpuCopy>(&recorded)) {
            encode_sdl_webgpu_copy(owner, command, *copy);
            if (copy->destination->kind == SdlWebGpuBufferKind::gpu)
                copies.written(copy->destination->gpu_buffer());
        } else {
            const auto& clear = std::get<SdlWebGpuClear>(recorded);
            encode_sdl_webgpu_clear(owner, command, clear);
            copies.written(clear.buffer->gpu_buffer());
        }
    }
}

inline void bind_sdl_webgpu_group(std::vector<SdlWebGpuBoundGroup>& groups, double index,
                                  const GpuHandle& handle, std::vector<std::uint32_t> offsets) {
    auto group = webgpu_object<SdlWebGpuBindGroup>(handle, "bind group");
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
    SdlWebGpuBoundGroups groups = std::make_shared<const std::vector<SdlWebGpuBoundGroup>>();
    std::vector<SdlWebGpuCommand>& live() const {
        if (!commands)
            webgpu_refuse("the compute pass has ended.");
        return *commands;
    }
    void set_pipeline(const GpuHandle& handle) override {
        static_cast<void>(live());
        pipeline = webgpu_object<SdlWebGpuComputePipeline>(handle, "compute pipeline");
    }
    void set_bind_group(double index, const GpuHandle& group,
                        const js::Array<double>& dynamic_offsets) override {
        static_cast<void>(live());
        auto next = std::make_shared<std::vector<SdlWebGpuBoundGroup>>(*groups);
        bind_sdl_webgpu_group(*next, index, group, webgpu_offsets(dynamic_offsets));
        groups = std::move(next);
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
        recorded.indirect = webgpu_object<SdlWebGpuBuffer>(buffer, "buffer");
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
        SdlWebGpuCopy copy{webgpu_object<SdlWebGpuBuffer>(source, "buffer"),
                           webgpu_object<SdlWebGpuBuffer>(destination, "buffer"),
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
        SdlWebGpuClear clear{webgpu_object<SdlWebGpuBuffer>(buffer, "buffer"), 0, 0};
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
        record_sdl_webgpu_uploads(*owner, command);
        encode_sdl_webgpu_commands(*owner, command, commands);
        commands.clear();
    }
};

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

/** A render stage's resource names to their WGSL group and binding (its sidecar rows). */
inline std::map<std::string, std::pair<std::uint32_t, std::uint32_t>>
sdl_webgpu_stage_bindings(const PinnedStageSlots& slots) {
    std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> result;
    for (const auto& row : slots.bindings)
        result[row.name] = {row.group, row.binding};
    return result;
}

/** A renderer's open pass, for a renderable's `draw`. */
struct SdlWebGpuRenderPass final : WebGpuLentPass<SDL_GPURenderPass*> {
    SDL_GPUCommandBuffer* command = nullptr;
    std::shared_ptr<SdlWebGpuRenderPipeline> pipeline;
    std::vector<SdlWebGpuBoundGroup> groups;
    std::vector<SDL_GPUBuffer*> storage_scratch;
    StageTextureBindingScratch texture_scratch;

    void set_pipeline(const GpuHandle& handle) override {
        pipeline = webgpu_object<SdlWebGpuRenderPipeline>(handle, "render pipeline");
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
        if (!stage.slots.storage_textures.empty())
            webgpu_refuse("render stages read no storage textures.");
        bind_stage_textures(
            pass, stage.slots, fragment, "WebGPU subset stage", texture_scratch,
            [&](const std::string& name, std::size_t slot) {
                const auto texture = point(name);
                if (!texture.view || slot >= stage.slots.samplers.size() ||
                    stage.slots.samplers[slot].empty())
                    webgpu_refuse("a texture slot '" + name + "' binds no view and sampler.");
                const auto sampler = point(stage.slots.samplers[slot]);
                if (!sampler.sampler)
                    webgpu_refuse("a sampler slot '" + stage.slots.samplers[slot] +
                                  "' binds no sampler.");
                return SDL_GPUTextureSamplerBinding{texture.view->texture->get(),
                                                    sampler.sampler->lease->get()};
            },
            [](const std::string& name, std::size_t) -> SDL_GPUTextureSamplerBinding {
                webgpu_refuse("a storage texture slot '" + name + "' is not in the subset.");
            });
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
        const auto arguments = webgpu_object<SdlWebGpuBuffer>(buffer, "buffer");
        if (!(arguments->usage & webgpu_buffer_usage::indirect))
            webgpu_refuse("drawIndirect needs a buffer created with INDIRECT.");
        require_webgpu_copy_range(arguments->byte_size(), gpu_size(offset), 16);
        bind();
        SDL_DrawGPUPrimitivesIndirect(pass, arguments->gpu_buffer(), webgpu_flags(offset), 1);
    }
    /** A draw's own state: a renderable sets what it draws with. */
    void clear() {
        pipeline.reset();
        groups.clear();
    }

protected:
    void resumed() override {
        if (pipeline)
            SDL_BindGPUGraphicsPipeline(pass, pipeline->lease->get());
    }
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
            // ranges getMappedRange returned. The zeroes precede every later upload.
            if (info.size)
                owner->uploads.push_back({buffer->buffer, {}, 0, 0, info.size, 0, 0, true});
        }
        if (descriptor.mapped_at_creation)
            buffer->mapping.map_at_creation(bytes);
        return buffer;
    }

    GpuHandle create_texture(const GpuTextureDescriptor& descriptor) override {
        if (descriptor.format != "rgba8unorm")
            webgpu_refuse("the subset creates rgba8unorm textures only.");
        if (descriptor.sample_count.value_or(1) != 1)
            webgpu_refuse("the subset creates single-sample textures only.");
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
            static_cast<void>(webgpu_object<SdlWebGpuBindGroupLayout>(group, "bind group layout"));
            layout->groups.push_back(group);
        }
        return layout;
    }

    GpuHandle create_compute_pipeline(const GpuComputePipelineDescriptor& descriptor) override {
        if (descriptor.layout.layout)
            static_cast<void>(webgpu_object<SdlWebGpuPipelineLayout>(descriptor.layout.layout,
                                                                     "pipeline layout"));
        const auto module =
            webgpu_object<SdlWebGpuShaderModule>(descriptor.compute.module, "shader module");
        if (!descriptor.compute.entry_point)
            webgpu_refuse("SDL_GPU compute stages are found by their named entry point.");
        const auto& entry = *descriptor.compute.entry_point;
        const auto stem = wgsl_stage_stem(module->code, entry, "comp");
        auto pipeline = std::make_shared<SdlWebGpuComputePipeline>();
        pipeline->lease = std::make_shared<SdlWebGpuComputeLease>();
        pipeline->lease->pipeline = load_sdl_webgpu_stage(
            stem, [&] { return load_sdl_gpu_compute_pipeline(owner->live_device(), stem, entry); });
        owner->leases.track(pipeline->lease);
        pipeline->layout = descriptor.layout.layout
                               ? descriptor.layout.layout
                               : sdl_webgpu_derived_layout(pipeline->lease->get().slots);
        return pipeline;
    }

    GpuHandle create_sampler(const GpuSamplerDescriptor& descriptor) override {
        const auto sampler = webgpu_sampler(descriptor);
        const auto filter = [](bool linear) {
            return linear ? SDL_GPU_FILTER_LINEAR : SDL_GPU_FILTER_NEAREST;
        };
        const auto address = [](WebGpuSampler::Address mode) {
            return mode == WebGpuSampler::Address::repeat ? SDL_GPU_SAMPLERADDRESSMODE_REPEAT
                   : mode == WebGpuSampler::Address::mirror_repeat
                       ? SDL_GPU_SAMPLERADDRESSMODE_MIRRORED_REPEAT
                       : SDL_GPU_SAMPLERADDRESSMODE_CLAMP_TO_EDGE;
        };
        SDL_GPUSamplerCreateInfo info{};
        info.mag_filter = filter(sampler.mag_linear);
        info.min_filter = filter(sampler.min_linear);
        info.mipmap_mode = sampler.mipmap_linear ? SDL_GPU_SAMPLERMIPMAPMODE_LINEAR
                                                 : SDL_GPU_SAMPLERMIPMAPMODE_NEAREST;
        info.address_mode_u = address(sampler.address_u);
        info.address_mode_v = address(sampler.address_v);
        info.address_mode_w = address(sampler.address_w);
        info.min_lod = sampler.lod_min_clamp;
        info.max_lod = sampler.lod_max_clamp;
        info.enable_anisotropy = sampler.max_anisotropy > 1;
        info.max_anisotropy = static_cast<float>(sampler.max_anisotropy);
        auto result = std::make_shared<SdlWebGpuSampler>();
        result->lease = owner->adopt<SdlWebGpuSamplerLease>(
            SDL_CreateGPUSampler(owner->live_device(), &info), "SDL_CreateGPUSampler");
        return result;
    }

    GpuHandle create_render_pipeline(const GpuRenderPipelineDescriptor& descriptor) override {
        require_webgpu_vertex_state(descriptor.vertex);
        if (!descriptor.layout.layout)
            webgpu_refuse("the subset's render pipelines take an explicit layout.");
        static_cast<void>(
            webgpu_object<SdlWebGpuPipelineLayout>(descriptor.layout.layout, "pipeline layout"));
        if (!descriptor.fragment || descriptor.fragment->targets.size() != 1)
            webgpu_refuse("render pipelines have a fragment stage with one target.");
        if (!descriptor.vertex.entry_point || !descriptor.fragment->entry_point)
            webgpu_refuse("SDL_GPU render stages are found by their named entry points.");
        const auto vertex_stem = wgsl_stage_stem(
            webgpu_object<SdlWebGpuShaderModule>(descriptor.vertex.module, "shader module")->code,
            *descriptor.vertex.entry_point, "vert");
        const auto fragment_stem = wgsl_stage_stem(
            webgpu_object<SdlWebGpuShaderModule>(descriptor.fragment->module, "shader module")
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
            if (!webgpu_front_face_ccw(*descriptor.primitive))
                info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_CLOCKWISE;
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
        pipeline->layout = descriptor.layout.layout;
        pipeline->lease = owner->adopt<SdlWebGpuGraphicsLease>(
            create_sdl_gpu_graphics_pipeline(device, vertex.shader, &info),
            "SDL_CreateGPUGraphicsPipeline");
        auto vertex_bindings = sdl_webgpu_stage_bindings(vertex.slots);
        auto fragment_bindings = sdl_webgpu_stage_bindings(fragment.slots);
        pipeline->vertex = {std::move(vertex.slots), std::move(vertex_bindings)};
        pipeline->fragment = {std::move(fragment.slots), std::move(fragment_bindings)};
        return pipeline;
    }

    GpuHandle create_bind_group(const GpuBindGroupDescriptor& descriptor) override {
        auto group = std::make_shared<SdlWebGpuBindGroup>();
        group->layout =
            webgpu_object<SdlWebGpuBindGroupLayout>(descriptor.layout, "bind group layout");
        for (const auto& entry : descriptor.entries) {
            const auto binding = webgpu_flags(entry.binding);
            const auto layout_entry =
                std::find_if(group->layout->entries.begin(), group->layout->entries.end(),
                             [&](const WebGpuLayoutEntry& row) { return row.binding == binding; });
            if (layout_entry == group->layout->entries.end())
                webgpu_refuse("bind group entry " + std::to_string(binding) +
                              " is absent from its layout.");
            SdlWebGpuGroupEntry resolved;
            resolved.binding = binding;
            if (const auto* buffer = std::get_if<GpuBufferBinding>(&entry.resource)) {
                resolved.buffer = webgpu_object<SdlWebGpuBuffer>(buffer->buffer, "buffer");
                const bool uniform = layout_entry->buffer == WebGpuBufferBinding::uniform;
                if (layout_entry->texture || layout_entry->sampler ||
                    (uniform ? resolved.buffer->kind != SdlWebGpuBufferKind::uniform
                             : resolved.buffer->kind != SdlWebGpuBufferKind::gpu))
                    webgpu_refuse("bind group entry " + std::to_string(binding) +
                                  " does not match its layout's resource.");
                resolved.offset = gpu_size(buffer->offset.value_or(0));
                if (buffer->size)
                    resolved.size = gpu_size(*buffer->size);
                const auto& dynamic = group->layout->dynamic_bindings;
                if (const auto at = std::find(dynamic.begin(), dynamic.end(), binding);
                    at != dynamic.end())
                    resolved.dynamic = static_cast<std::size_t>(at - dynamic.begin());
            } else if (layout_entry->sampler) {
                resolved.sampler =
                    webgpu_object<SdlWebGpuSampler>(std::get<GpuHandle>(entry.resource), "sampler");
            } else if (!layout_entry->texture) {
                webgpu_refuse("bind group entry " + std::to_string(binding) +
                              " binds a view where its layout declares a buffer.");
            } else {
                resolved.view =
                    webgpu_object<SdlWebGpuView>(std::get<GpuHandle>(entry.resource), "view");
            }
            group->entries.push_back(std::move(resolved));
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
            const auto commands = webgpu_object<SdlWebGpuCommandBuffer>(handle, "command buffer");
            if (commands->submitted)
                webgpu_refuse("a command buffer is submitted once.");
            commands->submitted = true;
            SdlGpuCommand command{SDL_AcquireGPUCommandBuffer(device)};
            if (!command)
                gpu_error("SDL_AcquireGPUCommandBuffer submit");
            record_sdl_webgpu_uploads(*owner, command);
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
        // Staged queue writes are submitted work.
        try {
            submit_sdl_webgpu_uploads(*owner);
        } catch (...) {
            return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
        }
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
    /**
     * A renderer's open pass on `command`, lent through `slot` for one
     * renderable's `draw` (`lend_webgpu_pass`), with its split on a frame a
     * library splits it.
     */
    static const GpuEncoderHandle& lend_render_pass(
        GpuEncoderHandle& slot, SDL_GPUCommandBuffer* command, SDL_GPURenderPass* pass,
        const bool* drawn = nullptr,
        const std::function<SDL_GPURenderPass*(const std::function<void()>&)>* pause = nullptr) {
        if (!command || !pass)
            webgpu_refuse("a renderer pass needs its command buffer and pass.");
        auto& lent = lend_webgpu_pass<SdlWebGpuRenderPass>(slot);
        lent.command = command;
        lent.pass = pass;
        lent.drawn = drawn;
        lent.pause = pause;
        return slot;
    }
};

/** `Engine::webgpu_device` over the engine's SDL_GPU device and its scene group, created on first use. */
inline SdlWebGpuDevice& sdl_engine_webgpu_device(Engine& engine, SDL_GPUDevice* device) {
    if (!engine.webgpu_device) {
        engine.webgpu_device = std::make_shared<SdlWebGpuDevice>(
            device, gpu_required_limits(engine.options.required_limits));
        bind_engine_scene_group(engine);
    }
    auto* result = dynamic_cast<SdlWebGpuDevice*>(engine.webgpu_device.get());
    if (!result || result->device_identity() != device)
        webgpu_refuse("the engine's WebGPU device belongs to another GPU device.");
    return *result;
}

} // namespace bbl::pal
