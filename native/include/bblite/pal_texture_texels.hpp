#pragma once
// The texels of texture records: the pinned upload transforms, the decode a
// `loadTexture2D` load runs, the hand-off that shares it with the first
// readers, and its release. The codec itself is pal_image.hpp's.

#include <bblite/features/has_image_decoder.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

/**
 * The pin's upload transforms of decoded texels, the one owner of their
 * rule: `premultiplyAlpha` premultiplies (`createImageBitmap`), and
 * `invertY` flips the rows (`copyExternalImageToTexture`'s `flipY`).
 */
inline void orient_image(DecodedImage& image, bool invert_y, bool premultiply_alpha) {
    if (premultiply_alpha)
        premultiply_image_alpha(image);
    if (!invert_y)
        return;
    const auto row_bytes = static_cast<std::ptrdiff_t>(image.width) * 4;
    for (int top = 0, bottom = image.height - 1; top < bottom; ++top, --bottom) {
        const auto first = image.rgba.begin() + top * row_bytes;
        std::swap_ranges(first, first + row_bytes, image.rgba.begin() + bottom * row_bytes);
    }
}

/** A texture's encoded `bytes`, decoded with its upload transforms. */
inline DecodedImage decode_texture_image(const TextureData& data) {
#if BBLITE_HAS_IMAGE_DECODER
    DecodedImage image =
        decode_image(std::span<const std::uint8_t>{data.bytes.data(), data.bytes.size()});
    orient_image(image, data.invert_y, data.premultiply_alpha);
    return image;
#else
    return decode_image(std::span<const std::uint8_t>{data.bytes.data(), data.bytes.size()});
#endif
}

/** Texels a reader keeps, with their size. */
struct SharedImage {
    int width = 0;
    int height = 0;
    SharedTexels rgba;
};

/**
 * The texels a texture's load decoded, handed to the readers that come
 * before the next frame boundary.
 *
 * The pin decodes an image as it loads it, and its upload drops the bitmap.
 * A native load decodes there too, with the upload transforms applied, and
 * every copy of the record shares this hand-off: an atlas shares the texels,
 * the first upload takes them (moving them when no atlas shares them), and
 * the frame boundary after the load settles drops them (`release`). Readers
 * after that reuse the texels an atlas still keeps, or decode `bytes` again,
 * so a record retains only the encoded file. Any thread may read.
 */
class LoadedTexels {
public:
    explicit LoadedTexels(DecodedImage texels)
        : width_(texels.width), height_(texels.height),
          held_(std::make_shared<std::vector<std::uint8_t>>(std::move(texels.rgba))) {}

    /** An upload's texels: the load's, or those an atlas keeps; nothing once both are gone. */
    std::optional<DecodedImage> take() {
        const std::lock_guard lock(mutex_);
        const auto held = std::exchange(held_, nullptr);
        if (held && held.use_count() == 1)
            return DecodedImage{width_, height_, std::move(*held)};
        if (const SharedTexels texels = held ? SharedTexels(held) : kept_.lock())
            return DecodedImage{width_, height_, *texels};
        return std::nullopt;
    }

    /**
     * An atlas's texels: the load's, or those another atlas keeps, else a new
     * decode of `data` that later readers reuse while this atlas keeps it.
     */
    SharedImage share(const TextureData& data) {
        const std::lock_guard lock(mutex_);
        SharedTexels texels = held_ ? SharedTexels(held_) : kept_.lock();
        if (!texels)
            texels = share_texels(decode_texture_image(data).rgba);
        kept_ = texels;
        return {width_, height_, std::move(texels)};
    }

    /** Drop the load's texels; those an atlas keeps stay reusable. */
    void release() {
        const std::lock_guard lock(mutex_);
        held_.reset();
    }

private:
    std::mutex mutex_;
    const int width_;
    const int height_;
    std::shared_ptr<std::vector<std::uint8_t>> held_;
    std::weak_ptr<const std::vector<std::uint8_t>> kept_;
};

/** The texels a texture uploads from its encoded image (`decode_uploadable_image`). */
inline DecodedImage texture_image_texels(const TextureData& data) {
    if (data.loaded_texels)
        if (auto texels = data.loaded_texels->take())
            return std::move(*texels);
    return decode_texture_image(data);
}

/** The texels an atlas over a texture's encoded image keeps, shared where they exist. */
inline SharedImage shared_texture_texels(const TextureData& data) {
    if (data.loaded_texels)
        return data.loaded_texels->share(data);
    DecodedImage image = decode_texture_image(data);
    // The texels leave the image in their own statement, so the aggregate
    // below reads only members that were never moved from.
    auto texels = share_texels(std::move(image.rgba));
    return {image.width, image.height, std::move(texels)};
}

/**
 * A `loadTexture2D` record given its image file, decoded as the pin fetches
 * and decodes before it settles: the record keeps the file and its size, and
 * hands its texels to its first readers (`LoadedTexels`). Native data only,
 * so a native job may run it.
 */
inline FileTexture decode_file_texture(FileTexture texture, std::vector<std::uint8_t> bytes) {
    DecodedImage texels = decode_image(bytes);
    orient_image(texels, texture.data.invert_y, texture.data.premultiply_alpha);
    texture.width = static_cast<std::uint32_t>(texels.width);
    texture.height = static_cast<std::uint32_t>(texels.height);
    texture.data.bytes = std::move(bytes);
    texture.data.loaded_texels = std::make_shared<LoadedTexels>(std::move(texels));
    return texture;
}

/**
 * A settled load's record, memoized under its key as the pin's
 * `loadTexture2D` map does; its texels wait for readers until the next frame
 * boundary (`release_loaded_texels`).
 */
inline const FileTexture& cache_file_texture(Engine& engine, std::string key, FileTexture texture) {
    const auto [entry, inserted] =
        engine.file_texture_cache.try_emplace(std::move(key), std::move(texture));
    if (inserted && entry->second.data.loaded_texels)
        engine.unread_loaded_texels.push_back(entry->second.data.loaded_texels);
    return entry->second;
}

/** At a frame boundary: drop the texels of loads that settled before it. */
inline void release_loaded_texels(Engine& engine) {
    for (const auto& texels : engine.unread_loaded_texels)
        texels->release();
    engine.unread_loaded_texels.clear();
}

} // namespace bbl::pal
