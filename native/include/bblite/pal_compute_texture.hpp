#pragma once

#include <array>
#include <cstdint>
#include <exception>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {
inline bool compute_filter_linear(std::string_view value) {
    if (value == "linear")
        return true;
    if (value == "nearest")
        return false;
    throw std::runtime_error("Invalid compute sampler filter mode.");
}

/** GPU descriptor after the generated Babylon validation and capability rules. */
struct ComputeTextureDescriptor {
    std::array<std::uint32_t, 3> extent{1, 1, 1};
    std::uint32_t mip_levels = 1;
    std::string dimension = "2d";
    std::string format;
    std::vector<std::string> accesses;
    bool sampled = true;
    bool render_attachment = false;
    std::string sample_type;
    std::string sampler_type;
    std::string label;
    struct Sampler {
        std::string address_u = "clamp-to-edge";
        std::string address_v = "clamp-to-edge";
        std::string address_w = "clamp-to-edge";
        std::string min_filter = "nearest";
        std::string mag_filter = "nearest";
        std::string mip_filter = "nearest";
        std::uint16_t anisotropy = 1;
    } sampler;
    std::string storage_view_dimension = "2d";
    std::string sampled_view_dimension = "2d";
};

struct ComputeTextureCapabilities {
    std::array<double, 4> limits{};
    bool float32_filterable = false;
    bool texture_formats_tier1 = false;
};

/** Views and sampler share this allocation; explicit destruction preserves facade identity. */
struct ComputeTextureAllocation {
    virtual ~ComputeTextureAllocation() = default;
    virtual void destroy() = 0;
};
struct ComputeTextureValidationError final : std::runtime_error {
    using std::runtime_error::runtime_error;
};
struct ComputeTextureCreation {
    std::shared_ptr<ComputeTextureAllocation> allocation;
    std::exception_ptr creation_error;
    std::optional<std::string> validation_error;
};
using ComputeTextureCreated =
    std::function<void(std::shared_ptr<ComputeTextureAllocation>, std::exception_ptr)>;

} // namespace bbl::pal
