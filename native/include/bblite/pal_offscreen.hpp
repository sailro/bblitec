#pragma once

#include <bblite/features/offscreen_surfaces.hpp>
#include <bblite/gpu.hpp>
#include <bblite/pal_gpu_adapter.hpp>

#include <bblite/pal_compute_texture.hpp>
#include <bblite/pal_compute_mipmaps.hpp>
#include <bblite/pal_compute_pipeline.hpp>
#include <bblite/pal_storage_buffer.hpp>
#include <bblite/pal_gpu_timestamp.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

class AnimationFrameSource;
using ComputeCommand = std::variant<ComputeDispatch, ComputeMipmapDraw, GpuTimestampWrite>;

/** Backend-owned handles; never contains scene or JavaScript state. */
struct OffscreenCompletion {
    virtual ~OffscreenCompletion() = default;
};

struct OffscreenDevice : GpuDevice {
    ~OffscreenDevice() override {
        for (const auto& resource : source_buffers_) {
            if (const auto buffer = resource.lock())
                buffer->destroy();
        }
    }
    GpuHandle create_buffer(const GpuBufferDescriptor& descriptor) override {
        const StorageBufferDescriptor options{gpu_size(descriptor.size),
                                              gpu_u32(gpu_size(descriptor.usage)),
                                              descriptor.label.value_or(std::string{})};
        auto allocation = create_storage_buffer(options, std::nullopt);
        if (!allocation)
            throw std::runtime_error("GPU buffer creation returned no allocation.");
        allocation->size = static_cast<double>(options.byte_length);
        const std::lock_guard lock(source_buffers_mutex_);
        std::erase_if(source_buffers_, [](const auto& resource) { return resource.expired(); });
        source_buffers_.push_back(allocation);
        return allocation;
    }
    virtual std::optional<GpuAdapterInfo> adapter_info() const { return std::nullopt; }
    virtual bool supports_gpu_timestamps() const { return false; }
    virtual std::shared_ptr<GpuTimestampQuerySet> create_gpu_timestamp_query_set(std::uint32_t) {
        throw std::runtime_error("This device does not provide GPU timestamps.");
    }
    virtual std::shared_ptr<GpuTimestampReadback>
    resolve_gpu_timestamps(const std::shared_ptr<GpuTimestampQuerySet>&, std::uint32_t) {
        throw std::runtime_error("This device does not provide GPU timestamp readback.");
    }
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
    // The WebGPU subset's own overload stays visible beside the compute tasks'.
    using GpuDevice::create_compute_pipeline;
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
            else if (const auto* mip = std::get_if<ComputeMipmapDraw>(&command))
                mip->level->submit(mip->vertices);
            else
                throw std::runtime_error("This device does not provide GPU timestamps.");
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
    notify_submitted_work_done(std::function<void(std::exception_ptr)>) {
        throw std::runtime_error("This device does not provide a GPU completion fence.");
    }

private:
    // A retained source pool may outlive this device. Retire its native handles
    // before the host destroys the device, preserving the source receipt fields.
    std::mutex source_buffers_mutex_;
    std::vector<std::weak_ptr<StorageBufferAllocation>> source_buffers_;
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
    bool capture_ready = true;
    /** Normalized view into a leased image shared by several canvas surfaces. */
    std::array<float, 4> uv{0, 0, 1, 1};
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
                     std::uint64_t capture_frame_count = 0,
                     std::shared_ptr<const std::atomic<bool>> capture_ready = {})
        : extent_(checked_extent(width, height)), animation_frames_(std::move(animation_frames)),
          capture_frame_count_(capture_frame_count), capture_ready_(std::move(capture_ready)) {}

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
    bool presenting() const {
        std::lock_guard lock(mutex_);
        return presenting_;
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

    bool publish(std::uint32_t width, std::uint32_t height, std::shared_ptr<OffscreenImage> image,
                 std::array<float, 4> uv, std::uint64_t sequence) {
        checked_extent(width, height);
        if (!image)
            throw std::runtime_error("Offscreen frame has no GPU image.");
        std::optional<OffscreenFrame> next(std::in_place,
                                           OffscreenFrame{width, height, 0, std::move(image)});
        const bool ready = !capture_ready_ || capture_ready_->load();
        next->capture_ready = ready;
        next->uv = uv;
        {
            std::lock_guard lock(mutex_);
            if (closed_)
                return false;
            next->sequence = sequence;
            frame_.swap(next);
        }
        // Release a superseded frame outside the mailbox lock.
        return ready;
    }

    mutable std::mutex mutex_;
    Extent extent_;
    std::optional<OffscreenFrame> frame_;
    bool closed_ = false;
    bool producer_active_ = false;
    bool presenting_ = true;
    const std::shared_ptr<AnimationFrameSource> animation_frames_;
    const std::uint64_t capture_frame_count_;
    const std::shared_ptr<const std::atomic<bool>> capture_ready_;
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
#if !BBLITE_OFFSCREEN_SURFACES
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
#if BBLITE_OFFSCREEN_SURFACES
        return current_;
#else
        return nullptr;
#endif
    }
    OffscreenSurface::Extent extent() const { return surface_.extent(); }
    struct View {
        std::shared_ptr<OffscreenRun> destination;
        std::uint32_t x, y, width, height;
    };
    void set_views(OffscreenSurface::Extent extent, std::vector<View> views) {
        render_extent_ = OffscreenSurface::checked_extent(extent.width, extent.height);
        views_ = std::move(views);
    }
    OffscreenSurface::Extent render_extent() const {
        return render_extent_ ? *render_extent_ : extent();
    }
    void resize(std::uint32_t width, std::uint32_t height) { surface_.resize(width, height); }
    void set_presenting(bool value) {
        std::lock_guard lock(surface_.mutex_);
        surface_.presenting_ = value;
        if (!value)
            surface_.frame_.reset();
    }
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
    /** Supplied RAF time, read and written only by the owning realm. */
    void set_animation_frame_timestamp(double timestamp) { animation_frame_timestamp_ = timestamp; }
    std::optional<double> animation_frame_timestamp() const { return animation_frame_timestamp_; }
    std::uint64_t capture_frame_count() const { return surface_.capture_frame_count_; }
    bool last_frame_capture_ready() const { return last_frame_capture_ready_; }

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
        const auto sequence = ++published_frames_;
        if (views_.empty()) {
            last_frame_capture_ready_ =
                surface_.publish(width, height, std::move(image), {0, 0, 1, 1}, sequence);
            return;
        }
        last_frame_capture_ready_ = true;
        for (const auto& view : views_) {
            if (view.x + view.width > width || view.y + view.height > height)
                throw std::logic_error("Canvas view exceeds its submitted image.");
            const std::array<float, 4> uv{
                static_cast<float>(view.x) / width, static_cast<float>(view.y) / height,
                static_cast<float>(view.width) / width, static_cast<float>(view.height) / height};
            auto& target = view.destination ? *view.destination : *this;
            last_frame_capture_ready_ &=
                target.surface_.publish(view.width, view.height, image, uv, sequence);
        }
    }

    void discard_pending() {
        surface_.take_frame();
        for (const auto& view : views_)
            if (view.destination)
                view.destination->discard_pending();
    }

private:
    bool last_frame_capture_ready_ = false;
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
    std::optional<double> animation_frame_timestamp_;
    bool device_disposed_ = false;
    std::optional<OffscreenSurface::Extent> render_extent_;
    std::vector<View> views_;
    std::uint64_t published_frames_ = 0;
};

/** A realm renderer presents to its Window host, which alone captures its frames. */
inline void refuse_endpoint_capture(const OffscreenRun* endpoint,
                                    const std::string& screenshot_path) {
    if (endpoint && !screenshot_path.empty())
        throw std::runtime_error("Capture offscreen output from its presentation host.");
}

} // namespace bbl::pal
