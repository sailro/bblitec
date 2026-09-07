#pragma once

namespace bbl::pal {

/** Optional native capabilities shared by realms. Implementations must contain
 * no JavaScript values or callbacks and synchronize their own native state. */
struct HostServices {
    virtual ~HostServices() = default;
};

} // namespace bbl::pal
