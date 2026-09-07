#pragma once

#include "pal_node_capture.hpp"
#include <bblite/pal.hpp>
#include <unordered_map>

namespace bbl::pal {

// Native handles are lookup keys only. Receipts expose monotonic allocation
// identities, and distinguish observed bindings from observed uploads.
struct NodeCaptureState {
    static bool requested() {
        return !environment_variable("BBLITE_RENDER_CAPTURE").empty() &&
            environment_variable("BBLITE_NODE_GPU_CAPTURE") == "1";
    }
    NodeGpuCapture capture{requested()};
    std::unordered_map<const void*, std::uint64_t> identities;
    std::unordered_map<const void*, std::vector<NodeGpuBindingCapture>> groups;

    std::uint64_t allocate(const void* handle, std::string_view role, std::size_t bytes = 0) {
        if (!capture.enabled() || !handle) return 0;
        const auto previous = identities.find(handle);
        if (previous != identities.end()) capture.destroy(previous->second);
        return identities[handle] = capture.create_resource(role, bytes);
    }
    std::uint64_t identity(const void* handle, std::string_view role) {
        if (!capture.enabled() || !handle) return 0;
        const auto found = identities.find(handle);
        return found == identities.end() ? allocate(handle, role) : found->second;
    }
    void write(const void* handle, const void* data, std::size_t bytes) {
        if (!capture.enabled()) return;
        capture.write(identities.at(handle), 0,
            {static_cast<const std::uint8_t*>(data), bytes});
    }
    void upload(const void* handle, std::string_view role, const void* data, std::size_t bytes) {
        if (!capture.enabled()) return;
        allocate(handle, role, bytes);
        write(handle, data, bytes);
    }
    void update(const void* handle, const void* data, std::size_t bytes) {
        // Other material families may share the uploader but are not captured.
        if (capture.enabled() && identities.contains(handle)) write(handle, data, bytes);
    }
};

} // namespace bbl::pal
