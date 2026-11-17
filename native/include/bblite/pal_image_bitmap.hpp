#pragma once

#include <bblite/features/has_image_decoder.hpp>
#include <bblite/features/has_webp_decoder.hpp>

#include <bblite/js_error.hpp>
#include <bblite/js_file.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/pal_canvas.hpp>
#include <bblite/pal_canvas_pixels.hpp>
#include <bblite/pal_event_loop.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/pal_native_workers.hpp>

#if BBLITE_HAS_WEBP_DECODER
#include <webp/decode.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <memory>
#include <optional>
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

/** The `ImageBitmapOptions` dictionary a program passes, as its strings. */
struct ImageBitmapOptionsInit {
    js::Nullable<std::string> premultiply_alpha;
    js::Nullable<std::string> color_space_conversion;
    js::Nullable<std::string> image_orientation;
};

/**
 * The decode policy: `premultiplyAlpha` `"none"` or `"premultiply"` and `colorSpaceConversion`
 * `"none"`, each explicit (the native decode applies no defaults), and `imageOrientation`
 * absent, `"none"` or `"from-image"` (orientation metadata is not applied). Anything else
 * throws a NotSupportedError DOMException.
 */
[[nodiscard]] inline ImageBitmapOptions image_bitmap_options(const ImageBitmapOptionsInit& init) {
    const auto unsupported = [](const char* member, const js::Nullable<std::string>& value) {
        return js::make_dom_exception(std::string("createImageBitmap ") + member + " " +
                                          (value ? "\"" + *value + "\"" : "undefined") +
                                          " is not supported natively.",
                                      "NotSupportedError");
    };
    if (!init.premultiply_alpha ||
        (*init.premultiply_alpha != "none" && *init.premultiply_alpha != "premultiply"))
        throw unsupported("premultiplyAlpha", init.premultiply_alpha);
    if (!init.color_space_conversion || *init.color_space_conversion != "none")
        throw unsupported("colorSpaceConversion", init.color_space_conversion);
    if (init.image_orientation && *init.image_orientation != "none" &&
        *init.image_orientation != "from-image")
        throw unsupported("imageOrientation", init.image_orientation);
    return {*init.premultiply_alpha == "premultiply"};
}

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
        // The header gives the size; libwebp then decodes straight into the image's pixels.
        DecodedImage image;
        if (!WebPGetInfo(bytes.data(), bytes.size(), &image.width, &image.height) ||
            image.width <= 0 || image.height <= 0)
            throw std::runtime_error("The WebP image could not be decoded.");
        const auto stride = static_cast<std::size_t>(image.width) * 4;
        image.rgba.resize(stride * static_cast<std::size_t>(image.height));
        if (!WebPDecodeRGBAInto(bytes.data(), bytes.size(), image.rgba.data(), image.rgba.size(),
                                static_cast<int>(stride)))
            throw std::runtime_error("The WebP image could not be decoded.");
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

/** createImageBitmap's `resizeWidth`, `resizeHeight` and `resizeQuality`, as a program passes them. */
struct ImageBitmapResizeInit {
    js::Nullable<double> width;
    js::Nullable<double> height;
    js::Nullable<std::string> quality;
};

/** createImageBitmap's source rectangle `(sx, sy, sw, sh)`. */
struct ImageBitmapSourceRect {
    double x = 0.0;
    double y = 0.0;
    double width = 0.0;
    double height = 0.0;
};

namespace image_bitmap_detail {

/** An ImageBitmapOptions enum member: its value, `fallback` when absent; another throws TypeError. */
inline std::string enum_member(const js::Nullable<std::string>& value, const char* member,
                               std::initializer_list<const char*> values, const char* fallback) {
    if (!value)
        return fallback;
    for (const char* admitted : values)
        if (*value == admitted)
            return *value;
    throw js::NamedError("TypeError", std::string("Failed to execute 'createImageBitmap': The ") +
                                          member + " value '" + *value + "' is not valid.");
}

/** An [EnforceRange] unsigned long member: a non-finite or out-of-range value throws TypeError. */
inline std::uint32_t enforced_unsigned_long(double value, const char* member) {
    const double integer = std::trunc(value);
    if (!std::isfinite(integer) || integer < 0.0 || integer > 4294967295.0)
        throw js::NamedError("TypeError", std::string("Failed to execute 'createImageBitmap': ") +
                                              member + " is outside the unsigned long range.");
    return static_cast<std::uint32_t>(integer);
}

/** Pixels beyond which a native ImageBitmap is not allocated: a 16384 x 16384 canvas's. */
inline constexpr std::uint64_t maximum_pixels = std::uint64_t{16384} * 16384;

} // namespace image_bitmap_detail

/**
 * `createImageBitmap(new ImageData(rgba, width, height)[, sx, sy, sw, sh][, options])`. The
 * ImageData constructor's checks throw first. The bitmap is the source rectangle of the image
 * over transparent black, as the bytes are at the call, scaled to the resize members by the
 * canvas draw's sampler (nearest for `resizeQuality: "pixelated"`, bilinear otherwise) and
 * flipped for `imageOrientation: "flipY"`; the promise resolves in a later task. A zero `sw` or
 * `sh` rejects with RangeError, a zero resize member with InvalidStateError, an invalid member
 * with TypeError. `premultiplyAlpha: "premultiply"` keeps premultiplied pixels, other values
 * straight ones; an sRGB ImageData needs no colour space conversion.
 */
inline js::Promise<ImageBitmap> create_image_bitmap(std::span<const std::uint8_t> rgba,
                                                    double width_value, double height_value,
                                                    std::optional<ImageBitmapSourceRect> source,
                                                    const ImageBitmapOptionsInit& options,
                                                    const ImageBitmapResizeInit& resize) {
    // new ImageData(data, sw, sh): sw and sh are WebIDL unsigned longs.
    const std::uint32_t image_width = js::to_uint32(width_value);
    if (rgba.empty() || rgba.size() % 4 != 0)
        throw js::make_dom_exception(
            "Failed to construct 'ImageData': The input data length is not a multiple of 4.",
            "InvalidStateError");
    const std::size_t texels = rgba.size() / 4;
    if (image_width == 0 || texels % image_width != 0)
        throw js::make_dom_exception("Failed to construct 'ImageData': The input data length is "
                                     "not a multiple of (4 * width).",
                                     "IndexSizeError");
    const std::size_t image_height = texels / image_width;
    if (js::to_uint32(height_value) != image_height)
        throw js::make_dom_exception("Failed to construct 'ImageData': The input data length is "
                                     "not equal to (4 * width * height).",
                                     "IndexSizeError");
    js::Promise<ImageBitmap> result;
    try {
        using image_bitmap_detail::enum_member;
        // The dictionary converts its members in name order.
        enum_member(options.color_space_conversion, "colorSpaceConversion", {"none", "default"},
                    "default");
        const bool flip = enum_member(options.image_orientation, "imageOrientation",
                                      {"from-image", "flipY", "none"}, "from-image") == "flipY";
        const bool premultiply =
            enum_member(options.premultiply_alpha, "premultiplyAlpha",
                        {"none", "premultiply", "default"}, "default") == "premultiply";
        const auto output_height = resize.height
                                       ? std::optional(image_bitmap_detail::enforced_unsigned_long(
                                             *resize.height, "resizeHeight"))
                                       : std::nullopt;
        const bool pixelated =
            enum_member(resize.quality, "resizeQuality", {"pixelated", "low", "medium", "high"},
                        "low") == "pixelated";
        const auto output_width =
            resize.width ? std::optional(image_bitmap_detail::enforced_unsigned_long(*resize.width,
                                                                                     "resizeWidth"))
                         : std::nullopt;
        // The rectangle's members are WebIDL longs; a negative extent spans the other way.
        long long left = 0;
        long long top = 0;
        long long columns = static_cast<long long>(image_width);
        long long rows = static_cast<long long>(image_height);
        if (source) {
            left = js::to_int32(source->x);
            top = js::to_int32(source->y);
            columns = js::to_int32(source->width);
            rows = js::to_int32(source->height);
            if (columns == 0 || rows == 0)
                throw js::NamedError("RangeError",
                                     std::string("Failed to execute 'createImageBitmap': The crop "
                                                 "rect ") +
                                         (columns == 0 ? "width" : "height") + " is 0.");
            if (columns < 0) {
                left += columns;
                columns = -columns;
            }
            if (rows < 0) {
                top += rows;
                rows = -rows;
            }
        }
        if (output_width == 0u || output_height == 0u)
            throw js::make_dom_exception(
                std::string("Failed to execute 'createImageBitmap': The resize ") +
                    (output_width == 0u ? "width" : "height") + " is 0.",
                "InvalidStateError");
        const auto scaled = [](std::uint32_t resized, long long extent, long long across) {
            return static_cast<std::uint64_t>(
                std::ceil(static_cast<double>(extent) * resized / static_cast<double>(across)));
        };
        const std::uint64_t target_columns = output_width    ? *output_width
                                             : output_height ? scaled(*output_height, columns, rows)
                                                             : static_cast<std::uint64_t>(columns);
        const std::uint64_t target_rows = output_height  ? *output_height
                                          : output_width ? scaled(*output_width, rows, columns)
                                                         : static_cast<std::uint64_t>(rows);
        if (static_cast<std::uint64_t>(columns) * static_cast<std::uint64_t>(rows) >
                image_bitmap_detail::maximum_pixels ||
            target_columns * target_rows > image_bitmap_detail::maximum_pixels)
            throw js::make_dom_exception("The ImageBitmap could not be allocated.",
                                         "InvalidStateError");
        // The source rectangle of the image placed over transparent black.
        DecodedImage image{static_cast<int>(columns), static_cast<int>(rows),
                           std::vector<std::uint8_t>(static_cast<std::size_t>(columns) *
                                                         static_cast<std::size_t>(rows) * 4,
                                                     0)};
        const long long first_column = std::max(left, 0LL);
        const long long end_column = std::min(left + columns, static_cast<long long>(image_width));
        for (long long row = 0; row < rows && first_column < end_column; ++row) {
            const long long source_row = top + row;
            if (source_row < 0 || source_row >= static_cast<long long>(image_height))
                continue;
            std::copy_n(rgba.data() + (static_cast<std::size_t>(source_row) * image_width +
                                       static_cast<std::size_t>(first_column)) *
                                          4,
                        static_cast<std::size_t>(end_column - first_column) * 4,
                        image.rgba.data() + (static_cast<std::size_t>(row * columns) +
                                             static_cast<std::size_t>(first_column - left)) *
                                                4);
        }
        if (target_columns != static_cast<std::uint64_t>(columns) ||
            target_rows != static_cast<std::uint64_t>(rows)) {
            // The resize draws the rectangle over the whole output, as drawImage blits.
            UiElementRecord::CanvasState canvas;
            reset_canvas(canvas, static_cast<double>(target_columns),
                         static_cast<double>(target_rows));
            canvas.drawing.image_smoothing_enabled = !pixelated;
            const auto extent_x = static_cast<double>(columns);
            const auto extent_y = static_cast<double>(rows);
            retain_canvas_image(canvas, {{}, canvas_bitmap(std::move(image)), extent_x, extent_y},
                                0.0, 0.0, extent_x, extent_y, 0.0, 0.0, canvas.width,
                                canvas.height);
            const auto composed = compose_canvas_image_data(canvas, no_canvas_source, 0.0, 0.0,
                                                            canvas.width, canvas.height);
            image = DecodedImage{
                static_cast<int>(target_columns), static_cast<int>(target_rows),
                std::vector<std::uint8_t>(composed.data.data(),
                                          composed.data.data() + composed.data.size())};
        }
        if (flip) {
            const auto stride = static_cast<std::ptrdiff_t>(image.width) * 4;
            for (int upper = 0, lower = image.height - 1; upper < lower; ++upper, --lower)
                std::swap_ranges(image.rgba.begin() + upper * stride,
                                 image.rgba.begin() + (upper + 1) * stride,
                                 image.rgba.begin() + lower * stride);
        }
        if (premultiply)
            premultiply_image_alpha(image);
        const ImageBitmap bitmap(std::move(image), premultiply);
        EventLoop::current().post([result, bitmap] { result.resolve(bitmap); });
    } catch (const WorkerTerminated&) {
        throw;
    } catch (...) {
        result.reject(std::current_exception());
    }
    return result;
}

/** The same over a Uint8ClampedArray's bytes. */
inline js::Promise<ImageBitmap> create_image_bitmap(const js::U8CArray& rgba, double width,
                                                    double height,
                                                    std::optional<ImageBitmapSourceRect> source,
                                                    const ImageBitmapOptionsInit& options,
                                                    const ImageBitmapResizeInit& resize) {
    return create_image_bitmap(std::span<const std::uint8_t>(js::typed_array_bytes(rgba)), width,
                               height, source, options, resize);
}

/** The same over a Uint8Array's bytes. */
inline js::Promise<ImageBitmap> create_image_bitmap(const js::U8Array& rgba, double width,
                                                    double height,
                                                    std::optional<ImageBitmapSourceRect> source,
                                                    const ImageBitmapOptionsInit& options,
                                                    const ImageBitmapResizeInit& resize) {
    return create_image_bitmap(std::span<const std::uint8_t>(rgba.data(), rgba.size()), width,
                               height, source, options, resize);
}

/**
 * `context.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)` on an OffscreenCanvas's 2D
 * context: the bitmap's pixels as they are now, blitted as a canvas draws an image. A closed
 * bitmap throws InvalidStateError.
 */
inline void offscreen_canvas_draw_image(const std::shared_ptr<OffscreenCanvas>& context,
                                        const ImageBitmap& image, double sx, double sy, double sw,
                                        double sh, double dx, double dy, double dw, double dh) {
    auto& canvas = *context->context_2d();
    const auto& pixels = image.pixels();
    const int width = static_cast<int>(image.width());
    const int height = static_cast<int>(image.height());
    std::shared_ptr<const UiElementRecord::CanvasBitmap> bitmap;
    if (image.premultiplied())
        bitmap = std::make_shared<const UiElementRecord::CanvasBitmap>(
            UiElementRecord::CanvasBitmap{width, height, *pixels});
    else
        bitmap = canvas_bitmap(DecodedImage{width, height, *pixels});
    retain_canvas_image(canvas, {{}, std::move(bitmap), image.width(), image.height()}, sx, sy, sw,
                        sh, dx, dy, dw, dh);
}

/** `drawImage(bitmap, dx, dy, dw, dh)`: the whole bitmap into that rectangle. */
inline void offscreen_canvas_draw_image(const std::shared_ptr<OffscreenCanvas>& context,
                                        const ImageBitmap& image, double dx, double dy, double dw,
                                        double dh) {
    offscreen_canvas_draw_image(context, image, 0.0, 0.0, image.width(), image.height(), dx, dy, dw,
                                dh);
}

/** `drawImage(bitmap, dx, dy)`: the whole bitmap at its size. */
inline void offscreen_canvas_draw_image(const std::shared_ptr<OffscreenCanvas>& context,
                                        const ImageBitmap& image, double dx, double dy) {
    offscreen_canvas_draw_image(context, image, dx, dy, image.width(), image.height());
}

} // namespace bbl::pal
