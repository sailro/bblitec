#pragma once
// One bind-group layout entry of a pinned GPU program, as generated plans
// carry it (`plannedLayoutEntryCpp` in src/recording-engine.ts).

#include <cstdint>
#include <string_view>

namespace bbl {

/**
 * A group-0 layout entry in WebGPU's own spelling (`GPUBindGroupLayoutEntry`),
 * with every default the pin left out filled in: exactly one of the buffer
 * type, the texture sample type, the sampler type or the storage texture's
 * access is set, the others empty. `name` is the WGSL identifier the module
 * declares at the binding, which SDL_GPU's slot sidecars name.
 */
struct PinnedLayoutEntry {
    std::uint32_t binding;
    std::string_view name;
    std::string_view buffer_type;
    std::string_view sample_type;
    std::string_view sampler_type;
    std::string_view storage_access;
    std::string_view storage_format;
};

} // namespace bbl
