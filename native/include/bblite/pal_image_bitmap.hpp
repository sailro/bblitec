#pragma once

#include <bblite/features/has_image_decoder.hpp>
#include <bblite/features/has_webp_decoder.hpp>

#include <bblite/js_error.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/pal_native_workers.hpp>

#if BBLITE_HAS_WEBP_DECODER
#include <webp/decode.h>
#endif

#include <cstdint>
#include <cstring>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::pal {

/** `createImageBitmap` options this port decodes: no color conversion, no orientation. */
struct ImageBitmapOptions {
    /** `premultiplyAlpha: "premultiply"`; otherwise `"none"` keeps straight alpha. */
    bool premultiply = false;
};

/** Whether `bytes` start with the RIFF/WEBP container signature. */
[[nodiscard]] inline bool webp_signature(std::span<const std::uint8_t> bytes) {
    return bytes.size() >= 12 && std::memcmp(bytes.data(), "RIFF", 4) == 0 &&
           std::memcmp(bytes.data() + 8, "WEBP", 4) == 0;
}

/**
 * Decode an encoded image to straight-alpha RGBA8, rows top to bottom, on any thread. WebP
 * decodes through libwebp, which is thread-safe, so decodes run concurrently; another format
 * decodes through SDL_image under its process-wide lock, when the program links its codec.
 */
[[nodiscard]] inline DecodedImage decode_bitmap_bytes(std::span<const std::uint8_t> bytes) {
    if (webp_signature(bytes)) {
#if BBLITE_HAS_WEBP_DECODER
        int width = 0, height = 0;
        std::uint8_t* pixels = WebPDecodeRGBA(bytes.data(), bytes.size(), &width, &height);
        if (!pixels || width <= 0 || height <= 0) {
            if (pixels)
                WebPFree(pixels);
            throw std::runtime_error("The WebP image could not be decoded.");
        }
        DecodedImage image;
        image.width = width;
        image.height = height;
        const auto size = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4;
        image.rgba.assign(pixels, pixels + size);
        WebPFree(pixels);
        return image;
#else
        throw std::runtime_error("This program does not link the WebP codec.");
#endif
    }
#if BBLITE_HAS_IMAGE_DECODER
    return decode_image(bytes);
#else
    throw std::runtime_error("This program links no codec for this image format.");
#endif
}

/**
 * An ImageBitmap: decoded RGBA8 pixels, shared by copies. `close()` releases the pixels;
 * a closed bitmap reads 0 x 0 and has no pixels.
 */
class ImageBitmap {
public:
    ImageBitmap() = default;
    ImageBitmap(DecodedImage image, bool premultiplied)
        : state_(std::make_shared<State>(
              State{image.width, image.height,
                    std::make_shared<const std::vector<std::uint8_t>>(std::move(image.rgba)),
                    premultiplied})) {}

    /** `bitmap.width` (0 once closed). */
    [[nodiscard]] double width() const { return state().pixels ? state().width : 0.0; }
    /** `bitmap.height` (0 once closed). */
    [[nodiscard]] double height() const { return state().pixels ? state().height : 0.0; }
    /** `bitmap.close()`. */
    void close() const { state().pixels.reset(); }
    [[nodiscard]] bool closed() const { return !state().pixels; }
    /** Whether the pixels are premultiplied (`premultiplyAlpha: "premultiply"`). */
    [[nodiscard]] bool premultiplied() const { return state().premultiplied; }
    /**
     * The decoded pixels: width * height RGBA8 texels, rows top to bottom, straight alpha unless
     * `premultiplied()`. A closed bitmap throws an InvalidStateError DOMException.
     */
    [[nodiscard]] const std::shared_ptr<const std::vector<std::uint8_t>>& pixels() const {
        if (!state().pixels)
            throw js::make_dom_exception("The ImageBitmap is closed.", "InvalidStateError");
        return state().pixels;
    }

    [[nodiscard]] const void* get() const noexcept { return state_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(state_); }
    [[nodiscard]] friend bool operator==(const ImageBitmap& left, const ImageBitmap& right) {
        return left.state_ == right.state_;
    }
    void gc_trace(const js::TraceVisitor&) const {}

private:
    struct State {
        int width = 0;
        int height = 0;
        std::shared_ptr<const std::vector<std::uint8_t>> pixels;
        bool premultiplied = false;
    };
    State& state() const {
        if (!state_)
            throw std::runtime_error("ImageBitmap receiver is absent.");
        return *state_;
    }
    std::shared_ptr<State> state_;
};

/**
 * `createImageBitmap(blob, options)`: decodes on the native workers and settles on the realm
 * when that decode finishes (decodes started together settle in completion order). A decode
 * failure rejects with an InvalidStateError DOMException.
 */
[[nodiscard]] inline js::Promise<ImageBitmap> create_image_bitmap(const js::Blob& blob,
                                                                  ImageBitmapOptions options = {}) {
    js::Promise<ImageBitmap> result;
    auto& loop = EventLoop::current();
    auto work = std::make_shared<NativeWork<DecodedImage>>();
    const auto id =
        loop.register_completion([result, work, options](std::unique_ptr<ExternalEvent>) {
            try {
                result.resolve(ImageBitmap(work->get(), options.premultiply));
            } catch (const WorkerTerminated&) {
                throw;
            } catch (const std::exception& error) {
                result.reject(js::dom_exception_error(
                    std::string("The source image could not be decoded: ") + error.what(),
                    "InvalidStateError"));
            }
        });
    try {
        *work = start_native_work(
            [bytes = blob.payload(), premultiply = options.premultiply] {
                auto image = decode_bitmap_bytes(*bytes);
                if (premultiply)
                    premultiply_image_alpha(image);
                return image;
            },
            [inbox = loop.inbox(), id] { inbox->post(std::make_unique<CompletionEvent>(id)); });
    } catch (...) {
        loop.cancel_completion(id);
        result.reject(std::current_exception());
    }
    return result;
}

} // namespace bbl::pal
