#pragma once
#include <memory>

namespace bbl::pal {
class AnimationFrameSource;

/** Optional native capabilities shared by realms. Implementations must contain
 * no JavaScript values or callbacks and synchronize their own native state. */
struct HostServices {
    virtual ~HostServices() = default;
    virtual std::shared_ptr<AnimationFrameSource> animation_frame_source() const { return {}; }
};

} // namespace bbl::pal
