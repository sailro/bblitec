#pragma once
#include <bblite/pal_gpu_adapter.hpp>
#include <memory>
#include <optional>

namespace bbl::pal {
class AnimationFrameSource;

/** Optional native capabilities shared by realms. Implementations must contain
 * no JavaScript values or callbacks and synchronize their own native state. */
struct HostServices {
    virtual ~HostServices() = default;
    virtual std::shared_ptr<AnimationFrameSource> animation_frame_source() const { return {}; }
    /** Identity of an available native graphics service; computation-only hosts omit it. */
    virtual const void* graphics_identity() const { return nullptr; }
    virtual std::optional<GpuAdapterInfo> graphics_adapter_info() const { return std::nullopt; }
};

} // namespace bbl::pal
