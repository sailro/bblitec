#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace bbl::pal {

/** GPU textures follow their immutable source pixels without extending source lifetime. */
template <class Resource> struct UiCachedTexture {
    Resource resource;
    std::weak_ptr<const std::vector<std::uint8_t>> source;
};

template <class Resource, class Release>
std::size_t
prune_ui_texture_cache(std::unordered_map<std::uint64_t, UiCachedTexture<Resource>>& textures,
                       Release&& release) {
    std::size_t released = 0;
    for (auto texture = textures.begin(); texture != textures.end();) {
        if (!texture->second.source.expired()) {
            ++texture;
            continue;
        }
        release(texture->second.resource);
        texture = textures.erase(texture);
        ++released;
    }
    return released;
}

} // namespace bbl::pal
