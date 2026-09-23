#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

namespace bbl::pal {

/** Backend query storage. Values crossing this boundary are nanoseconds. */
struct GpuTimestampQuerySet {
    virtual ~GpuTimestampQuerySet() = default;
};

struct GpuTimestampReadback {
    virtual ~GpuTimestampReadback() = default;
    /** Nonblocking; called only on the owning realm. A failed readback throws. */
    virtual std::optional<std::vector<std::uint64_t>> poll() = 0;
};

struct GpuTimestampWrite {
    std::shared_ptr<GpuTimestampQuerySet> query_set;
    std::uint32_t index = 0;
    bool beginning = true;
};

} // namespace bbl::pal
