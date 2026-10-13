#pragma once

#include <bblite/byte_hash.hpp>
#include <bblite/gpu.hpp>
#include <bblite/gpu_renderable.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_offscreen.hpp>

#include "pal_gpu_lease_retirement.hpp"
#include "pal_webgpu_usage.hpp"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// The WebGPU subset the backends' WebGPU devices (`pal_dawn_webgpu.hpp`,
// `pal_sdl_gpu_webgpu.hpp`) share: usage bits, a buffer's mapping state and
// the settlement of native completions on the calling realm.

namespace bbl::pal {

/**
 * The compiled stage a runtime WGSL module's entry point deploys as, when a
 * backend consumes offline-compiled stages: `wgsl-<digest>.<entry>.<stage>`,
 * where the digest is `hash_bytes` over the module's UTF-8 text, as
 * src/wgsl-artifacts.ts `wgslStageStem` names it at generation.
 */
inline std::string wgsl_stage_stem(const std::string& code, const std::string& entry_point,
                                   const char* stage) {
    char digest[17];
    std::snprintf(digest, sizeof(digest), "%016llx",
                  static_cast<unsigned long long>(hash_bytes(code.data(), code.size())));
    return std::string("wgsl-") + digest + "." + entry_point + "." + stage;
}

[[noreturn]] inline void webgpu_refuse(const std::string& message) {
    throw std::runtime_error("WebGPU subset: " + message);
}

/** A handle as the backend object `Object` its device created; anything else refuses. */
template <class Object>
std::shared_ptr<Object> webgpu_object(const GpuHandle& handle, const char* what) {
    auto object = std::dynamic_pointer_cast<Object>(handle);
    if (!object)
        webgpu_refuse(std::string("expected a ") + what + " this device created.");
    return object;
}

/** `setBindGroup`'s dynamic offsets. */
inline std::vector<std::uint32_t> webgpu_offsets(const js::Array<double>& offsets) {
    std::vector<std::uint32_t> result;
    result.reserve(offsets.size());
    for (const double offset : offsets)
        result.push_back(webgpu_flags(offset));
    return result;
}

/** `GPUBufferBindingLayout.type` with its default. */
enum class WebGpuBufferBinding { uniform, storage, read_only_storage };
inline WebGpuBufferBinding webgpu_buffer_binding(const GpuBufferBindingLayout& layout) {
    const std::string type = layout.type.value_or(std::string("uniform"));
    if (type == "uniform")
        return WebGpuBufferBinding::uniform;
    if (type == "storage")
        return WebGpuBufferBinding::storage;
    if (type == "read-only-storage")
        return WebGpuBufferBinding::read_only_storage;
    webgpu_refuse("buffer binding type '" + type + "' is not admitted.");
}

/** A sampled texture binding: this subset admits float 2D single-sampled textures only. */
inline void require_webgpu_texture_binding(const GpuTextureBindingLayout& layout) {
    if (layout.sample_type.value_or(std::string("float")) != "float" ||
        layout.view_dimension.value_or(std::string("2d")) != "2d" ||
        layout.multisampled.value_or(false))
        webgpu_refuse("texture bindings are float 2D single-sampled textures.");
}

/** One layout entry, resolved against WebGPU's defaults. */
struct WebGpuLayoutEntry {
    std::uint32_t binding = 0;
    std::uint32_t visibility = 0;
    bool texture = false;
    WebGpuBufferBinding buffer = WebGpuBufferBinding::uniform;
    bool dynamic_offset = false;
};
inline std::vector<WebGpuLayoutEntry>
webgpu_layout_entries(const GpuBindGroupLayoutDescriptor& descriptor) {
    std::vector<WebGpuLayoutEntry> result;
    for (const auto& source : descriptor.entries) {
        WebGpuLayoutEntry entry;
        entry.binding = webgpu_flags(source.binding);
        entry.visibility = webgpu_flags(source.visibility);
        if (source.buffer.has_value() == source.texture.has_value())
            webgpu_refuse("a layout entry declares exactly one buffer or texture.");
        for (const auto& other : result)
            if (other.binding == entry.binding)
                webgpu_refuse("a layout declares binding " + std::to_string(entry.binding) +
                              " twice.");
        if (source.buffer) {
            entry.buffer = webgpu_buffer_binding(*source.buffer);
            entry.dynamic_offset = source.buffer->has_dynamic_offset.value_or(false);
            if (entry.buffer == WebGpuBufferBinding::storage &&
                (entry.visibility & webgpu_shader_stage::vertex))
                webgpu_refuse("a vertex stage cannot see a writable storage buffer.");
        } else {
            require_webgpu_texture_binding(*source.texture);
            entry.texture = true;
        }
        result.push_back(entry);
    }
    return result;
}

/**
 * Settles a native GPU operation on the calling realm. `start` begins the
 * operation with a callback any thread may call once; `on_realm` runs on the
 * realm first and may replace the outcome.
 */
using WebGpuCompletionStart =
    std::function<std::unique_ptr<OffscreenCompletion>(std::function<void(std::exception_ptr)>)>;
inline js::Promise<js::PromiseVoid>
settle_webgpu_operation(const WebGpuCompletionStart& start,
                        std::function<std::exception_ptr(std::exception_ptr)> on_realm = {},
                        js::Promise<js::PromiseVoid> result = {}) {
    struct Completion final : CompletionEvent {
        std::exception_ptr error;
        Completion(std::uint64_t id, std::exception_ptr value)
            : CompletionEvent(id), error(std::move(value)) {}
    };
    struct Pending {
        std::unique_ptr<OffscreenCompletion> operation;
    };
    auto pending = std::make_shared<Pending>();
    auto& loop = EventLoop::current();
    const auto id = loop.register_completion(
        [result, pending, on_realm = std::move(on_realm)](std::unique_ptr<ExternalEvent> event) {
            auto* completion = dynamic_cast<Completion*>(event.get());
            if (!completion)
                throw std::logic_error("Incorrect WebGPU completion payload.");
            auto error = completion->error;
            if (on_realm)
                error = on_realm(error);
            if (error)
                result.reject(error);
            else
                result.resolve(js::PromiseVoid{});
        });
    try {
        pending->operation = start([inbox = loop.inbox(), id](std::exception_ptr error) {
            inbox->post(std::make_unique<Completion>(id, std::move(error)));
        });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}

/**
 * One buffer's WebGPU mapping state (`mapState`, `getMappedRange`, `unmap`),
 * independent of how a backend reads or writes the bytes. A read mapping
 * copies the buffer's bytes into each returned ArrayBuffer; a write mapping
 * (`mappedAtCreation`) hands out zeroed ArrayBuffers whose bytes the backend
 * transfers at `unmap()`. An ArrayBuffer returned before `unmap()` no longer
 * reaches the buffer after it.
 */
class WebGpuBufferMapState {
public:
    struct Range {
        std::size_t offset = 0;
        js::ArrayBuffer bytes;
    };

    std::string map_state() const {
        switch (phase_) {
        case Phase::pending:
            return "pending";
        case Phase::mapped:
            return "mapped";
        case Phase::unmapped:
            break;
        }
        return "unmapped";
    }
    bool unmapped() const { return phase_ == Phase::unmapped; }

    /** `mappedAtCreation: true`: the whole buffer, mapped for writing. */
    void map_at_creation(std::size_t size) {
        if (size % 4 != 0)
            webgpu_refuse("mappedAtCreation requires a size that is a multiple of 4.");
        phase_ = Phase::mapped;
        write_ = true;
        offset_ = 0;
        size_ = size;
    }

    /**
     * Validates `mapAsync(mode, offset, size)` and enters the pending phase;
     * returns the mapped range's offset and size.
     */
    std::pair<std::size_t, std::size_t> begin_read(double mode, bbl::js::Nullable<double> offset,
                                                   bbl::js::Nullable<double> size,
                                                   std::size_t buffer_size, bool map_read_usage) {
        if (mode != gpu_map_mode_read)
            webgpu_refuse("mapAsync admits GPUMapMode.READ only.");
        if (!map_read_usage)
            webgpu_refuse("mapAsync(READ) requires a buffer created with MAP_READ.");
        if (phase_ != Phase::unmapped)
            webgpu_refuse("mapAsync requires an unmapped buffer.");
        const auto [start, count] = range(offset, size, 0, buffer_size);
        phase_ = Phase::pending;
        write_ = false;
        offset_ = start;
        size_ = count;
        ++generation_;
        return {start, count};
    }
    std::uint64_t generation() const { return generation_; }
    /** The native mapping of `generation` finished; false if `unmap()` aborted it meanwhile. */
    bool complete(std::uint64_t generation, bool success) {
        if (phase_ != Phase::pending || generation != generation_)
            return false;
        phase_ = success ? Phase::mapped : Phase::unmapped;
        return success;
    }
    void set_pending_promise(js::Promise<js::PromiseVoid> promise) {
        pending_ = std::move(promise);
    }

    /**
     * `getMappedRange(offset, size)`: a range inside the mapping that overlaps
     * no range returned before. `read(offset, size)` supplies a read
     * mapping's bytes.
     */
    js::ArrayBuffer get_mapped_range(
        bbl::js::Nullable<double> offset, bbl::js::Nullable<double> size, std::size_t buffer_size,
        const std::function<std::vector<std::uint8_t>(std::size_t, std::size_t)>& read) {
        if (phase_ != Phase::mapped)
            webgpu_refuse("getMappedRange requires a mapped buffer.");
        const auto [start, count] = range(offset, size, 0, buffer_size);
        if (start < offset_ || count > size_ || start - offset_ > size_ - count)
            webgpu_refuse("getMappedRange exceeds the mapped range.");
        for (const auto& previous : ranges_)
            if (start < previous.offset + previous.bytes.byte_length() &&
                previous.offset < start + count)
                webgpu_refuse("getMappedRange overlaps a range it returned before.");
        js::ArrayBuffer bytes(write_ ? std::vector<std::uint8_t>(count, 0) : read(start, count));
        if (bytes.byte_length() != count)
            webgpu_refuse("a read mapping returned the wrong byte count.");
        ranges_.push_back({start, bytes});
        return bytes;
    }

    /**
     * `unmap()`: aborts a pending mapping, rejecting its promise, and returns
     * the ranges a write mapping hands back to the buffer.
     */
    std::vector<Range> unmap() {
        std::vector<Range> written;
        if (phase_ == Phase::pending && pending_) {
            pending_->reject(std::make_exception_ptr(
                std::runtime_error("AbortError: unmap() aborted the pending mapAsync().")));
        }
        if (phase_ == Phase::mapped && write_)
            written = std::move(ranges_);
        phase_ = Phase::unmapped;
        ranges_.clear();
        pending_.reset();
        write_ = false;
        ++generation_;
        return written;
    }

private:
    enum class Phase { unmapped, pending, mapped };
    /** WebGPU's mapping range rules: offset a multiple of 8, size of 4, inside the buffer. */
    static std::pair<std::size_t, std::size_t> range(bbl::js::Nullable<double> offset,
                                                     bbl::js::Nullable<double> size,
                                                     std::size_t base, std::size_t limit) {
        const std::size_t start = offset ? gpu_size(*offset) : base;
        if (start > limit)
            webgpu_refuse("a mapping offset exceeds the buffer.");
        const std::size_t count = size ? gpu_size(*size) : limit - start;
        if (start % 8 != 0 || count % 4 != 0 || count > limit - start)
            webgpu_refuse("a mapping range is misaligned or exceeds the buffer.");
        return {start, count};
    }
    Phase phase_ = Phase::unmapped;
    bool write_ = false;
    std::size_t offset_ = 0, size_ = 0;
    std::uint64_t generation_ = 0;
    std::vector<Range> ranges_;
    std::optional<js::Promise<js::PromiseVoid>> pending_;
};

/** `queue.writeBuffer` validation both backends apply before their transport. */
inline void require_webgpu_buffer_write(std::uint32_t usage, const WebGpuBufferMapState& mapping,
                                        std::size_t buffer_size, std::size_t offset,
                                        std::size_t count) {
    if (!(usage & webgpu_buffer_usage::copy_dst))
        webgpu_refuse("writeBuffer requires a buffer created with COPY_DST.");
    if (!mapping.unmapped())
        webgpu_refuse("writeBuffer requires an unmapped buffer.");
    if (offset % 4 != 0 || count % 4 != 0)
        webgpu_refuse("writeBuffer offsets and sizes are multiples of 4.");
    if (offset > buffer_size || count > buffer_size - offset)
        webgpu_refuse("writeBuffer exceeds the buffer.");
}

/** `copyBufferToBuffer` and `clearBuffer` ranges, validated as WebGPU does. */
inline void require_webgpu_copy_range(std::size_t buffer_size, std::size_t offset,
                                      std::size_t count) {
    if (offset % 4 != 0 || count % 4 != 0)
        webgpu_refuse("buffer copy offsets and sizes are multiples of 4.");
    if (offset > buffer_size || count > buffer_size - offset)
        webgpu_refuse("a buffer copy exceeds its buffer.");
}

} // namespace bbl::pal
