#pragma once

#include <bblite/pal_compute_texture.hpp>
#include <bblite/pal_compute_mipmaps.hpp>
#include <bblite/pal_compute_pipeline.hpp>
#include <bblite/pal_storage_buffer.hpp>

#include <algorithm>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

class AnimationFrameSource;
using ComputeCommand = std::variant<ComputeDispatch, ComputeMipmapDraw>;

/** Backend-owned handles; never contains scene or JavaScript state. */
struct OffscreenCompletion {
    virtual ~OffscreenCompletion() = default;
};

struct OffscreenDevice {
    virtual ~OffscreenDevice() = default;
    virtual std::shared_ptr<ComputeGroupLayout>
    create_compute_group_layout(const ComputeGroupLayoutDescriptor&) {
        throw std::runtime_error("This device does not provide compute group layouts.");
    }
    virtual std::shared_ptr<ComputePipelineLayout>
    create_compute_pipeline_layout(const ComputePipelineLayoutDescriptor&) {
        throw std::runtime_error("This device does not provide compute pipeline layouts.");
    }
    virtual std::shared_ptr<ComputeShaderModule>
    create_compute_shader_module(const ComputeShaderModuleDescriptor&, const std::string&) {
        throw std::runtime_error("This device does not provide compute shader modules.");
    }
    virtual std::shared_ptr<ComputePipeline>
    create_compute_pipeline(const ComputePipelineDescriptor&) {
        throw std::runtime_error("This device does not provide compute pipelines.");
    }
    virtual std::shared_ptr<ComputeBindGroup>
    create_compute_bind_group(const ComputeBindGroupDescriptor&) {
        throw std::runtime_error("This device does not provide compute bind groups.");
    }
    virtual void dispatch_compute(const ComputeDispatch&) {
        throw std::runtime_error("This device does not provide compute dispatch.");
    }
    /** Consume one ordered source command list at its queue submission boundary. */
    virtual void submit_compute_commands(std::span<const ComputeCommand> commands) {
        for (const auto& command : commands) {
            if (const auto* dispatch = std::get_if<ComputeDispatch>(&command))
                dispatch_compute(*dispatch);
            else {
                const auto& mip = std::get<ComputeMipmapDraw>(command);
                mip.level->submit(mip.vertices);
            }
        }
    }
    virtual ComputeShaderLimits compute_shader_limits() const {
        throw std::runtime_error("This device does not provide compute shader limits.");
    }
    virtual double minimum_uniform_buffer_offset_alignment() const {
        throw std::runtime_error("This device does not provide uniform buffer limits.");
    }
    virtual double maximum_storage_buffer_size() const {
        throw std::runtime_error("This device does not provide storage buffers.");
    }
    virtual std::shared_ptr<StorageBufferAllocation>
    create_storage_buffer(const StorageBufferDescriptor&,
                          std::optional<std::span<const std::uint8_t>>) {
        throw std::runtime_error("This device does not provide storage buffers.");
    }
    virtual std::shared_ptr<StorageReadback>
    create_storage_readback(const StorageReadbackDescriptor&) {
        throw std::runtime_error("This device does not provide storage readback.");
    }
    virtual ComputeTextureCapabilities compute_texture_capabilities() const {
        throw std::runtime_error("This device does not provide compute textures.");
    }
    virtual void create_compute_texture(const ComputeTextureDescriptor&, ComputeTextureCreated) {
        throw std::runtime_error("This device does not provide compute textures.");
    }
    virtual std::shared_ptr<ComputeMipmapPipeline>
    prepare_compute_mipmap_pipeline(const std::string&, const std::string&) {
        throw std::runtime_error("This device does not provide compute texture mipmaps.");
    }
    virtual std::shared_ptr<ComputeMipmapLevel>
    prepare_compute_mipmap_level(const std::shared_ptr<ComputeMipmapPipeline>&,
                                 const std::shared_ptr<ComputeTextureAllocation>&,
                                 const ComputeTextureDescriptor&, std::uint32_t, std::uint32_t,
                                 std::uint32_t) {
        throw std::runtime_error("This device does not provide compute texture mipmaps.");
    }
    virtual std::unique_ptr<OffscreenCompletion>
    on_submitted_work_done(std::function<void(std::exception_ptr)>) {
        throw std::runtime_error("This device does not provide a GPU completion fence.");
    }
};

struct OffscreenImage {
    virtual ~OffscreenImage() = default;
};

/** Submitted GPU output, leased until the presenter's GPU work has finished. */
struct OffscreenFrame {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint64_t sequence = 0;
    std::shared_ptr<OffscreenImage> image;
};

/**
 * The cross-thread boundary contains leased GPU images and dimensions, never
 * an Engine, a JavaScript reference, or a callback. Images use the shared GPU
 * device's ordered submission queue; no per-frame readback/upload is involved.
 * A slow presenter keeps only the newest submitted frame.
 */
class OffscreenSurface {
public:
    struct Extent {
        std::uint32_t width;
        std::uint32_t height;
    };

    OffscreenSurface(std::uint32_t width, std::uint32_t height,
                     std::shared_ptr<AnimationFrameSource> animation_frames = {},
                     std::uint64_t capture_frame_count = 0)
        : extent_(checked_extent(width, height)), animation_frames_(std::move(animation_frames)),
          capture_frame_count_(capture_frame_count) {}

    void resize(std::uint32_t width, std::uint32_t height) {
        const auto next = checked_extent(width, height);
        std::lock_guard lock(mutex_);
        extent_ = next;
    }

    Extent extent() const {
        std::lock_guard lock(mutex_);
        return extent_;
    }

    std::optional<OffscreenFrame> take_frame() {
        std::lock_guard lock(mutex_);
        return std::exchange(frame_, std::nullopt);
    }

    void close() {
        {
            std::lock_guard lock(mutex_);
            closed_ = true;
        }
    }

    bool closed() const {
        std::lock_guard lock(mutex_);
        return closed_;
    }

private:
    friend class OffscreenRun;
    static Extent checked_extent(std::uint32_t width, std::uint32_t height) {
        // Bound native GPU allocations; this is not a WebIDL conversion.
        if (!width || !height || width > 16384 || height > 16384) {
            throw std::runtime_error("Offscreen extent must be in [1, 16384].");
        }
        return {width, height};
    }

    void publish(std::uint32_t width, std::uint32_t height, std::shared_ptr<OffscreenImage> image) {
        checked_extent(width, height);
        if (!image)
            throw std::runtime_error("Offscreen frame has no GPU image.");
        std::optional<OffscreenFrame> next(std::in_place,
                                           OffscreenFrame{width, height, 0, std::move(image)});
        {
            std::lock_guard lock(mutex_);
            if (closed_)
                return;
            next->sequence = ++sequence_;
            frame_.swap(next);
        }
        // Release a superseded frame outside the mailbox lock.
    }

    mutable std::mutex mutex_;
    Extent extent_;
    std::optional<OffscreenFrame> frame_;
    std::uint64_t sequence_ = 0;
    bool closed_ = false;
    bool producer_active_ = false;
    const std::shared_ptr<AnimationFrameSource> animation_frames_;
    const std::uint64_t capture_frame_count_;
};

/**
 * One engine run's presentation endpoint, bound on its owning thread.
 * The window/event pump remains on the OS thread that created the window.
 */
class OffscreenRun {
public:
    OffscreenRun(std::shared_ptr<OffscreenSurface> surface, std::shared_ptr<OffscreenDevice> device)
        : OffscreenRun(require_resource(surface), require_resource(device)) {
        surface_owner_ = std::move(surface);
        device_owner_ = std::move(device);
    }
    explicit OffscreenRun(OffscreenSurface& surface, OffscreenDevice& device)
        : surface_(surface), device_(device) {
#if !defined(BBLITE_OFFSCREEN_SURFACES) || !BBLITE_OFFSCREEN_SURFACES
        throw std::runtime_error("This build has no offscreen surface support.");
#endif
        std::lock_guard lock(surface_.mutex_);
        if (surface_.producer_active_ || surface_.closed_) {
            throw std::runtime_error("Offscreen surface already has an owner or is closed.");
        }
        surface_.producer_active_ = true;
    }
    OffscreenRun(const OffscreenRun&) = delete;
    OffscreenRun& operator=(const OffscreenRun&) = delete;
    ~OffscreenRun() {
        if (current_ == this)
            current_ = nullptr;
        std::lock_guard lock(surface_.mutex_);
        surface_.producer_active_ = false;
    }

    static OffscreenRun* current() {
#if defined(BBLITE_OFFSCREEN_SURFACES) && BBLITE_OFFSCREEN_SURFACES
        return current_;
#else
        return nullptr;
#endif
    }
    OffscreenSurface::Extent extent() const { return surface_.extent(); }
    void resize(std::uint32_t width, std::uint32_t height) { surface_.resize(width, height); }
    OffscreenDevice& device() const {
        require_live_device();
        return device_;
    }
    void invalidate_device() {
        device_disposed_ = true;
        discard_pending();
    }
    const std::shared_ptr<AnimationFrameSource>& animation_frames() const {
        return surface_.animation_frames_;
    }
    std::uint64_t capture_frame_count() const { return surface_.capture_frame_count_; }

    class Binding {
    public:
        explicit Binding(OffscreenRun& run) : previous_(std::exchange(current_, &run)) {}
        ~Binding() { current_ = previous_; }
        Binding(const Binding&) = delete;
        Binding& operator=(const Binding&) = delete;

    private:
        OffscreenRun* previous_;
    };

    bool closed() const { return device_disposed_ || surface_.closed(); }

    void publish(std::uint32_t width, std::uint32_t height, std::shared_ptr<OffscreenImage> image) {
        require_live_device();
        surface_.publish(width, height, std::move(image));
    }

    void discard_pending() { surface_.take_frame(); }

private:
    void require_live_device() const {
        if (device_disposed_)
            throw std::runtime_error("The engine GPU device has been disposed.");
    }
    template <typename T> static T& require_resource(const std::shared_ptr<T>& resource) {
        if (!resource)
            throw std::invalid_argument("Offscreen run requires a surface and device.");
        return *resource;
    }
    inline static thread_local OffscreenRun* current_ = nullptr;
    OffscreenSurface& surface_;
    OffscreenDevice& device_;
    std::shared_ptr<OffscreenSurface> surface_owner_;
    std::shared_ptr<OffscreenDevice> device_owner_;
    bool device_disposed_ = false;
};

} // namespace bbl::pal
