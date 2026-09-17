#pragma once

#include <bblite/runtime.hpp>
#include <algorithm>
#include <array>
#include <memory>
#include <vector>

namespace bbl::pal {

/** Share immutable image uploads across material bindings on one device.
 * Samplers and UV transforms belong to the binding, not the image upload.
 * Retaining the source bytes makes pointer identity stable and preserves COW.
 * Only the bindings own GPU resources; the cache never prolongs their life. */
template <typename Resource>
class TextureUploadCache {
    struct Entry {
        TextureData source;
        bool srgb;
        std::array<std::uint8_t, 4> fallback;
        std::weak_ptr<Resource> resource;
    };
    std::vector<Entry> entries_;

    static bool same_image(const TextureData& left, const TextureData& right) {
        if (left.bytes.data() != right.bytes.data() || left.bytes.size() != right.bytes.size() ||
            left.rgba_width != right.rgba_width || left.rgba_height != right.rgba_height ||
            left.invert_y != right.invert_y || left.premultiply_alpha != right.premultiply_alpha ||
            left.compressed_alternatives != right.compressed_alternatives) return false;
        const auto& a = left.compressed;
        const auto& b = right.compressed;
        if (a.storage != b.storage || a.format != b.format || a.width != b.width || a.height != b.height ||
            a.block_width != b.block_width || a.block_height != b.block_height ||
            a.block_bytes != b.block_bytes || a.mips.size() != b.mips.size()) return false;
        for (std::size_t i = 0; i < a.mips.size(); ++i) {
            if (a.mips[i].width != b.mips[i].width || a.mips[i].height != b.mips[i].height ||
                a.mips[i].bytes.data() != b.mips[i].bytes.data() ||
                a.mips[i].bytes.size() != b.mips[i].bytes.size()) return false;
        }
        return true;
    }

public:
    template <typename Upload>
    std::shared_ptr<Resource> acquire(const TextureData& source, bool srgb,
        std::array<std::uint8_t, 4> fallback, Upload upload) {
        prune();
        for (const auto& entry : entries_) {
            if (entry.srgb == srgb && entry.fallback == fallback && same_image(entry.source, source)) {
                if (auto resource = entry.resource.lock()) return resource;
            }
        }
        auto resource = std::make_shared<Resource>(upload());
        entries_.push_back({source, srgb, fallback, resource});
        return resource;
    }

    void prune() {
        std::erase_if(entries_, [](const Entry& entry) { return entry.resource.expired(); });
    }
};

} // namespace bbl::pal
