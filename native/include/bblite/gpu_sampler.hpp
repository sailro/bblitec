#pragma once

#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

// `GPUSamplerDescriptor` and WebGPU's resolution of it, which the WebGPU
// subset's devices (`pal_webgpu_common.hpp`) and a texture's sampler state
// (`texture_sampler_state`, runtime.hpp) share.

namespace bbl {

/**
 * `GPUSamplerDescriptor`; absent members, which a designated initializer
 * leaves out, take WebGPU's defaults.
 */
struct GpuSamplerDescriptor {
    bbl::js::Nullable<std::string> label{};
    bbl::js::Nullable<std::string> address_mode_u{};
    bbl::js::Nullable<std::string> address_mode_v{};
    bbl::js::Nullable<std::string> address_mode_w{};
    bbl::js::Nullable<std::string> mag_filter{};
    bbl::js::Nullable<std::string> min_filter{};
    bbl::js::Nullable<std::string> mipmap_filter{};
    bbl::js::Nullable<double> lod_min_clamp{};
    bbl::js::Nullable<double> lod_max_clamp{};
    bbl::js::Nullable<std::string> compare{};
    bbl::js::Nullable<double> max_anisotropy{};
};

namespace pal {

[[noreturn]] inline void webgpu_refuse(const std::string& message) {
    throw std::runtime_error("WebGPU subset: " + message);
}

/** `GPUSamplerDescriptor` with WebGPU's defaults: nearest filters, clamp-to-edge, LOD 0..32. */
struct WebGpuSampler {
    bool mag_linear = false, min_linear = false, mipmap_linear = false;
    enum class Address { clamp_to_edge, repeat, mirror_repeat };
    Address address_u = Address::clamp_to_edge, address_v = Address::clamp_to_edge,
            address_w = Address::clamp_to_edge;
    float lod_min_clamp = 0.0f, lod_max_clamp = 32.0f;
    std::uint16_t max_anisotropy = 1;
};

/**
 * `device.createSampler(descriptor)`'s resolution and validation: the LOD
 * clamps are finite floats with 0 <= lodMinClamp <= lodMaxClamp,
 * `maxAnisotropy` converts as a `[Clamp] unsigned short` and is at least 1,
 * and above 1 only with linear mag, min and mipmap filters. Comparison
 * samplers are not in the subset.
 */
inline WebGpuSampler webgpu_sampler(const GpuSamplerDescriptor& descriptor) {
    const auto linear = [](const bbl::js::Nullable<std::string>& filter) {
        const auto name = filter.value_or(std::string("nearest"));
        if (name != "nearest" && name != "linear")
            webgpu_refuse("filter mode '" + name + "' is not admitted.");
        return name == "linear";
    };
    const auto address = [](const bbl::js::Nullable<std::string>& mode) {
        const auto name = mode.value_or(std::string("clamp-to-edge"));
        if (name == "clamp-to-edge")
            return WebGpuSampler::Address::clamp_to_edge;
        if (name == "repeat")
            return WebGpuSampler::Address::repeat;
        if (name == "mirror-repeat")
            return WebGpuSampler::Address::mirror_repeat;
        webgpu_refuse("address mode '" + name + "' is not admitted.");
    };
    if (descriptor.compare)
        webgpu_refuse("comparison samplers are not in the subset.");
    WebGpuSampler sampler;
    sampler.mag_linear = linear(descriptor.mag_filter);
    sampler.min_linear = linear(descriptor.min_filter);
    sampler.mipmap_linear = linear(descriptor.mipmap_filter);
    sampler.address_u = address(descriptor.address_mode_u);
    sampler.address_v = address(descriptor.address_mode_v);
    sampler.address_w = address(descriptor.address_mode_w);
    const double lod_min = descriptor.lod_min_clamp.value_or(0.0);
    const double lod_max = descriptor.lod_max_clamp.value_or(32.0);
    constexpr double float_max = std::numeric_limits<float>::max();
    if (!(std::fabs(lod_min) <= float_max && std::fabs(lod_max) <= float_max))
        webgpu_refuse("a sampler's LOD clamps are finite floats.");
    if (!(lod_min >= 0.0 && lod_max >= lod_min))
        webgpu_refuse("a sampler's LOD clamps satisfy 0 <= lodMinClamp <= lodMaxClamp.");
    sampler.lod_min_clamp = static_cast<float>(lod_min);
    sampler.lod_max_clamp = static_cast<float>(lod_max);
    // Clamped to the type's range, then rounded half to even; NaN is 0.
    const double anisotropy =
        std::nearbyint(std::clamp(descriptor.max_anisotropy.value_or(1.0), 0.0, 65535.0));
    if (!(anisotropy >= 1.0))
        webgpu_refuse("maxAnisotropy is at least 1.");
    if (anisotropy > 1.0 && !(sampler.mag_linear && sampler.min_linear && sampler.mipmap_linear))
        webgpu_refuse("maxAnisotropy above 1 needs linear mag, min and mipmap filters.");
    sampler.max_anisotropy = static_cast<std::uint16_t>(anisotropy);
    return sampler;
}

} // namespace pal
} // namespace bbl
