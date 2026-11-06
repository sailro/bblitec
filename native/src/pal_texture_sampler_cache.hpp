#pragma once

#include <bblite/runtime.hpp>

#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * The device's one sampler for `state` among `samplers`, which `create`
 * makes on first use; the backend releases them with its device.
 */
template <class Sampler, class Create>
Sampler cached_texture_sampler(std::vector<std::pair<TextureSamplerState, Sampler>>& samplers,
                               const TextureSamplerState& state, Create&& create) {
    for (const auto& [kept, created] : samplers)
        if (kept == state)
            return created;
    Sampler created = create(state);
    samplers.emplace_back(state, created);
    return created;
}

} // namespace bbl::pal
