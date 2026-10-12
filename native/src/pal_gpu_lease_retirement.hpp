#pragma once

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
    template <class Resource> void track(const std::shared_ptr<Resource>& resource) {
        std::erase_if(resources_, [](const Entry& entry) { return entry.resource.expired(); });
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
    }

    std::size_t tracked_resource_count() const noexcept { return resources_.size(); }

private:
    struct Entry {
        std::weak_ptr<void> resource;
        void (*release)(const std::shared_ptr<void>&);
    };
    std::vector<Entry> resources_;
};

} // namespace bbl::pal
