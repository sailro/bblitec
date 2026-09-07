#pragma once

#include <algorithm>
#include <memory>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string_view>
#include <vector>

namespace bbl::pal {

enum class TextBindingRole { uniform, curves, bands, metadata, styles };

inline std::uint32_t text_gpu_u32(std::size_t value) {
    if (value > std::numeric_limits<std::uint32_t>::max())
        throw std::runtime_error("Text resource extent exceeds the native API's 32-bit range.");
    return static_cast<std::uint32_t>(value);
}

// Resource names come from the composed WGSL reflection, including SDL's
// compacted stage sidecars. The backend only maps those names to native leases.
inline TextBindingRole text_binding_role(std::string_view name) {
    if (name == "tu") return TextBindingRole::uniform;
    if (name == "ct") return TextBindingRole::curves;
    if (name == "bt") return TextBindingRole::bands;
    if (name == "gm") return TextBindingRole::metadata;
    if (name == "sty") return TextBindingRole::styles;
    throw std::runtime_error("Unmapped text shader resource: " + std::string(name));
}

/** Source text owners may outlive a renderer run; retire their device leases first. */
class TextResourceRetirement {
public:
    template<class Resource>
    void track(const std::shared_ptr<Resource>& resource) {
        std::erase_if(resources_, [](const Entry& entry) { return entry.resource.expired(); });
        resources_.push_back({resource, [](const std::shared_ptr<void>& value) {
            std::static_pointer_cast<Resource>(value)->retire();
        }});
    }

    void retire() noexcept {
        for (const auto& entry : resources_) {
            if (const auto value = entry.resource.lock()) entry.release(value);
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
