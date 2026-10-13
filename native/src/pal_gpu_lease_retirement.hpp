#pragma once

#include <algorithm>
#include <cstddef>
#include <memory>
#include <vector>

namespace bbl::pal {

/**
 * Source records may outlive a renderer run and its device: a device owner
 * tracks the native leases it created and retires them, first, at its own end.
 * A lease's `retire()` releases its native handle and refuses later use.
 */
class GpuLeaseRetirement {
public:
    /** Expired entries are dropped once the list doubles since its last compaction. */
    template <class Resource> void track(const std::shared_ptr<Resource>& resource) {
        if (resources_.size() >= compact_at_) {
            std::erase_if(resources_, [](const Entry& entry) { return entry.resource.expired(); });
            compact_at_ = std::max<std::size_t>(minimum_compaction, 2 * resources_.size());
        }
        resources_.push_back({resource, [](const std::shared_ptr<void>& value) {
                                  std::static_pointer_cast<Resource>(value)->retire();
                              }});
    }

    void retire() noexcept {
        for (const auto& entry : resources_) {
            if (const auto value = entry.resource.lock())
                entry.release(value);
        }
        resources_.clear();
        compact_at_ = minimum_compaction;
    }

    std::size_t tracked_resource_count() const noexcept { return resources_.size(); }

private:
    struct Entry {
        std::weak_ptr<void> resource;
        void (*release)(const std::shared_ptr<void>&);
    };
    static constexpr std::size_t minimum_compaction = 64;
    std::vector<Entry> resources_;
    std::size_t compact_at_ = minimum_compaction;
};

} // namespace bbl::pal
