#pragma once

#include <cstdint>

namespace bbl::pal {

struct DeviceOptions {
    bool hidden_test_pass = false;
    bool immediate_present = false;
    // Dawn validation is always enabled.
    bool gpu_debug = false;
    // Zero preserves the backend default.
    std::uint32_t max_vertex_attributes = 0;
    std::uint32_t max_color_attachment_bytes_per_sample = 0;
};

} // namespace bbl::pal
