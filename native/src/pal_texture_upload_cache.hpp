#pragma once

#include <bblite/runtime.hpp>
#include <algorithm>
#include <array>
#include <cstring>
#include <memory>
#include <span>
#include <vector>

namespace bbl::pal {

inline bool same_texture_image(const TextureData& left, const TextureData& right) {
    // A pixels texture's image is its shared texels, whichever bytes each
    // binding holds of them.
    if (left.pixels || right.pixels)
        return left.pixels == right.pixels;
    if (left.bytes.data() != right.bytes.data() || left.bytes.size() != right.bytes.size() ||
        left.rgba_width != right.rgba_width || left.rgba_height != right.rgba_height ||
        left.invert_y != right.invert_y || left.premultiply_alpha != right.premultiply_alpha ||
        left.compressed_alternatives != right.compressed_alternatives)
        return false;
    const auto& a = left.compressed;
    const auto& b = right.compressed;
    if (a.storage != b.storage || a.format != b.format || a.width != b.width ||
        a.height != b.height || a.mips.size() != b.mips.size())
        return false;
    for (std::size_t i = 0; i < a.mips.size(); ++i) {
        if (a.mips[i].width != b.mips[i].width || a.mips[i].height != b.mips[i].height ||
            a.mips[i].copy != b.mips[i].copy || a.mips[i].bytes.data() != b.mips[i].bytes.data() ||
            a.mips[i].bytes.size() != b.mips[i].bytes.size())
            return false;
    }
    return true;
}

/** Share image uploads across material bindings on one device.
 * Samplers and UV transforms belong to the binding, not the image upload.
 * Retaining the source bytes makes pointer identity stable and preserves COW;
 * pixels images follow their texture's writes (`upload_pixels_writes`).
 * Only the bindings own GPU resources; the cache never prolongs their life. */
template <typename Resource> class TextureUploadCache {
    struct Entry {
        TextureData source;
        bool srgb{};
        std::array<std::uint8_t, 4> fallback{};
        std::weak_ptr<Resource> resource;
    };
    std::vector<Entry> entries_;

public:
    std::shared_ptr<Resource> find(const TextureData& source, bool srgb,
                                   std::array<std::uint8_t, 4> fallback) const {
        if (source.gpu_source || source.render_source)
            throw std::runtime_error(
                "GPU-backed texture requires a live sampled-resource binding.");
        for (const auto& entry : entries_)
            if (entry.srgb == srgb && entry.fallback == fallback &&
                same_texture_image(entry.source, source))
                if (auto resource = entry.resource.lock())
                    return resource;
        return {};
    }

    template <typename Upload>
    std::shared_ptr<Resource> acquire(const TextureData& source, bool srgb,
                                      std::array<std::uint8_t, 4> fallback, Upload upload) {
        prune();
        if (auto resource = find(source, srgb, fallback))
            return resource;
        auto resource = std::make_shared<Resource>(upload());
        entries_.push_back({source, srgb, fallback, resource});
        return resource;
    }

    void prune() {
        std::erase_if(entries_, [](const Entry& entry) { return entry.resource.expired(); });
    }

    /**
     * Brings every live pixels image up to its texture's writes
     * (pixels-texture.ts): `write(image, texels, width, region)` uploads
     * `region` of the `width`-texel-wide RGBA8 `texels` into the image's
     * base level, the only one a pixels texture's sampler reads.
     */
    template <typename Write> void upload_pixels_writes(Write write) {
        for (auto& entry : entries_) {
            const auto& texels = entry.source.pixels;
            if (!texels || entry.source.pixels_version == texels->version)
                continue;
            if (const auto image = entry.resource.lock()) {
                const std::uint32_t width = entry.source.rgba_width;
                const std::uint32_t height = entry.source.rgba_height;
                if (width == 0 || texels->rgba.size() / 4u / width < height)
                    throw std::runtime_error("Pixels texture texels are shorter than the texture.");
                PixelsTexels::Region region = texels->written_since(entry.source.pixels_version);
                if (region.whole())
                    region = {0, 0, width, height};
                write(*image, region_texels(texels->rgba.data(), width, region), region);
            }
            entry.source.pixels_version = texels->version;
        }
    }

private:
    /** The region's rows, tightly packed: its own span of full-width rows, else a copy. */
    std::span<const std::uint8_t> region_texels(const std::uint8_t* texels, std::uint32_t width,
                                                PixelsTexels::Region region) {
        const std::size_t stride = static_cast<std::size_t>(width) * 4u;
        const std::size_t row_bytes = static_cast<std::size_t>(region.width) * 4u;
        const std::uint8_t* first =
            texels + region.y * stride + static_cast<std::size_t>(region.x) * 4u;
        if (region.width == width)
            return {first, row_bytes * region.height};
        packed_.resize(row_bytes * region.height);
        for (std::uint32_t row = 0; row < region.height; ++row)
            std::memcpy(packed_.data() + row * row_bytes, first + row * stride, row_bytes);
        return packed_;
    }

    std::vector<std::uint8_t> packed_;
};

} // namespace bbl::pal
