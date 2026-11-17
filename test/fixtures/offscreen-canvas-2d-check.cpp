// `createImageBitmap` over an ImageData and an OffscreenCanvas's 2D context
// (`pal_image_bitmap.hpp`, `pal_canvas.hpp`): each check throws on a
// mismatch; the fixture prints "ok" when every promise settled as expected.

#include <bblite/pal_image_bitmap.hpp>

#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using namespace bbl;

namespace {

void check(bool result, const std::string& message) {
    if (!result)
        throw std::runtime_error(message);
}

/** A width x height straight-alpha image whose texel (x, y) is (40x, 40y, 200, alpha). */
std::vector<std::uint8_t> image(int width, int height, std::uint8_t alpha = 255) {
    std::vector<std::uint8_t> rgba;
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x)
            rgba.insert(rgba.end(), {static_cast<std::uint8_t>(40 * x),
                                     static_cast<std::uint8_t>(40 * y), 200, alpha});
    return rgba;
}

std::vector<std::uint8_t> texel(const std::vector<std::uint8_t>& rgba, int width, int x, int y) {
    const auto offset = static_cast<std::size_t>(y * width + x) * 4;
    return {rgba.begin() + static_cast<std::ptrdiff_t>(offset),
            rgba.begin() + static_cast<std::ptrdiff_t>(offset + 4)};
}

pal::ImageBitmapOptionsInit options(js::Nullable<std::string> premultiply = std::nullopt,
                                    js::Nullable<std::string> orientation = std::nullopt) {
    return {std::move(premultiply), std::nullopt, std::move(orientation)};
}

pal::ImageBitmapResizeInit resize(js::Nullable<double> width = std::nullopt,
                                  js::Nullable<double> height = std::nullopt,
                                  js::Nullable<std::string> quality = std::nullopt) {
    return {width, height, std::move(quality)};
}

template <typename Body> void expect_throw(Body body, const char* name, const std::string& what) {
    try {
        body();
    } catch (...) {
        const auto error = std::current_exception();
        check(js::error_name(error) == name, what + " threw " + js::error_name(error));
        return;
    }
    throw std::runtime_error(what + " did not throw");
}

} // namespace

int main() try {
    const js::RealmScope scope;
    pal::EventLoop loop;
    int settled = 0;
    int expected = 0;
    std::vector<std::string> order;
    const auto settle = [&] {
        if (++settled == expected)
            loop.close();
    };
    std::exception_ptr failure;
    const auto source = image(4, 3);
    const auto translucent = image(4, 3, 128);
    const auto square = image(4, 4);
    const auto canvas = js::make_gc_shared<pal::OffscreenCanvas>(4, 3);
    const auto resized = js::make_gc_shared<pal::OffscreenCanvas>(1, 1);
    const auto guard = [&](auto body) {
        return [&failure, body](auto&&... values) {
            try {
                body(std::forward<decltype(values)>(values)...);
            } catch (...) {
                failure = std::current_exception();
            }
        };
    };
    loop.run([&] {
        // The ImageData constructor's checks throw before createImageBitmap runs.
        expect_throw(
            [&] {
                (void)pal::create_image_bitmap(std::span(source.data(), 10), 4, 3, std::nullopt,
                                               options(), resize());
            },
            "InvalidStateError", "a length that is no multiple of 4");
        expect_throw(
            [&] {
                (void)pal::create_image_bitmap(source, 5, 3, std::nullopt, options(), resize());
            },
            "IndexSizeError", "a width that does not divide the length");
        expect_throw(
            [&] {
                (void)pal::create_image_bitmap(source, 4, 2, std::nullopt, options(), resize());
            },
            "IndexSizeError", "a height other than the length's");

        // A crop is exact, straight alpha kept; the rectangle off the image is transparent black.
        ++expected;
        pal::create_image_bitmap(translucent, 4, 3, pal::ImageBitmapSourceRect{-1, 1, 3, -2},
                                 options(), resize())
            .then(guard([&](const pal::ImageBitmap& bitmap) {
                check(bitmap.width() == 3 && bitmap.height() == 2 && !bitmap.premultiplied(),
                      "crop size");
                const auto& pixels = *bitmap.pixels();
                // sh = -2 from y = 1 spans rows -1 and 0: the first is off the image.
                check(texel(pixels, 3, 1, 0) == std::vector<std::uint8_t>{0, 0, 0, 0},
                      "a texel above the image is transparent");
                check(texel(pixels, 3, 0, 1) == std::vector<std::uint8_t>{0, 0, 0, 0},
                      "a texel left of the image is transparent");
                check(texel(pixels, 3, 1, 1) == texel(translucent, 4, 0, 0), "crop texel (0, 0)");
                check(texel(pixels, 3, 2, 1) == texel(translucent, 4, 1, 0), "crop texel (1, 0)");
                order.push_back("bitmap");
                settle();
            }));
        // Resolution waits for a task: a microtask queued after the call runs first.
        loop.queue_microtask([&] { order.push_back("microtask"); });

        // Pixelated resize repeats texels; flipY flips the rows after it.
        ++expected;
        pal::create_image_bitmap(source, 4, 3, pal::ImageBitmapSourceRect{0, 0, 2, 2},
                                 options(std::nullopt, std::string("flipY")),
                                 resize(4.0, std::nullopt, std::string("pixelated")))
            .then(guard([&](const pal::ImageBitmap& bitmap) {
                // resizeHeight follows resizeWidth's ratio: ceil(2 * 4 / 2).
                check(bitmap.width() == 4 && bitmap.height() == 4, "pixelated size");
                const auto& pixels = *bitmap.pixels();
                for (int y = 0; y < 4; ++y)
                    for (int x = 0; x < 4; ++x)
                        check(texel(pixels, 4, x, y) == texel(source, 4, x / 2, 1 - y / 2),
                              "pixelated texel " + std::to_string(x) + "," + std::to_string(y));
                settle();
            }));

        // A bilinear halving averages each 2 x 2 block; premultiply keeps premultiplied pixels.
        ++expected;
        pal::create_image_bitmap(square, 4, 4, std::nullopt, options(std::string("premultiply")),
                                 resize(2.0, 2.0, std::string("high")))
            .then(guard([&](const pal::ImageBitmap& bitmap) {
                check(bitmap.width() == 2 && bitmap.height() == 2 && bitmap.premultiplied(),
                      "halved size");
                const auto& pixels = *bitmap.pixels();
                for (int y = 0; y < 2; ++y)
                    for (int x = 0; x < 2; ++x)
                        check(texel(pixels, 2, x, y) ==
                                  std::vector<std::uint8_t>{static_cast<std::uint8_t>(80 * x + 20),
                                                            static_cast<std::uint8_t>(80 * y + 20),
                                                            200, 255},
                              "halved texel " + std::to_string(x) + "," + std::to_string(y));
                settle();
            }));

        // The rejections, each as the browser names it.
        const auto rejects = [&](js::Promise<pal::ImageBitmap> promise, const char* name, bool dom,
                                 const char* what) {
            ++expected;
            promise.then(guard([&, what](const pal::ImageBitmap&) {
                             throw std::runtime_error(std::string(what) + " resolved");
                         }),
                         guard([&, name, dom, what](std::exception_ptr error) {
                             check(js::error_name(error) == name &&
                                       js::error_is(error, "DOMException") == dom,
                                   std::string(what) + " rejected with " + js::error_name(error));
                             settle();
                         }));
        };
        rejects(pal::create_image_bitmap(source, 4, 3, pal::ImageBitmapSourceRect{0, 0, 0, 2},
                                         options(), resize()),
                "RangeError", false, "a zero crop width");
        rejects(pal::create_image_bitmap(source, 4, 3, std::nullopt, options(), resize(0.0)),
                "InvalidStateError", true, "a zero resize width");
        rejects(pal::create_image_bitmap(source, 4, 3, std::nullopt, options(),
                                         resize(std::numeric_limits<double>::quiet_NaN())),
                "TypeError", false, "a NaN resize width");
        rejects(pal::create_image_bitmap(source, 4, 3, std::nullopt, options(std::string("both")),
                                         resize()),
                "TypeError", false, "an unknown premultiplyAlpha");

        // An OffscreenCanvas's 2D context: one per canvas, drawn by drawImage, encoded by
        // convertToBlob.
        const auto context = pal::offscreen_canvas_context_2d(canvas);
        check(context.has_value() && *context == canvas &&
                  *pal::offscreen_canvas_context_2d(canvas) == canvas,
              "one 2D context per canvas");
        expect_throw([&] { (void)canvas->rendering_context(); }, "Error",
                     "a WebGPU context on a 2D canvas");
        expect_throw([&] { (void)canvas->transfer(); }, "Error", "a 2D canvas's transfer");
        ++expected;
        pal::create_image_bitmap(source, 4, 3, std::nullopt, options(), resize())
            .then(guard([&, context](const pal::ImageBitmap& bitmap) {
                pal::offscreen_canvas_draw_image(*context, bitmap, 0, 0);
                bitmap.close();
                expect_throw([&] { pal::offscreen_canvas_draw_image(*context, bitmap, 0, 0); },
                             "InvalidStateError", "a closed bitmap's draw");
                pal::offscreen_canvas_convert_to_blob(canvas, std::string("image/png"),
                                                      std::nullopt)
                    .then(guard([&](const js::Blob& blob) {
                        check(blob.type() == "image/png", "PNG blob type " + blob.type());
                        const auto decoded = pal::decode_image(blob.bytes());
                        check(decoded.width == 4 && decoded.height == 3 && decoded.rgba == source,
                              "the PNG holds the drawn pixels");
                        settle();
                    }));
            }));
        // A JPEG keeps its type; a canvas without a context is transparent black.
        ++expected;
        pal::offscreen_canvas_convert_to_blob(js::make_gc_shared<pal::OffscreenCanvas>(3, 2),
                                              std::string("IMAGE/JPEG"), 0.5)
            .then(guard([&](const js::Blob& blob) {
                check(blob.type() == "image/jpeg", "JPEG blob type " + blob.type());
                const auto decoded = pal::decode_image(blob.bytes());
                check(decoded.width == 3 && decoded.height == 2, "JPEG size");
                settle();
            }));
        ++expected;
        pal::offscreen_canvas_convert_to_blob(js::make_gc_shared<pal::OffscreenCanvas>(2, 1),
                                              std::nullopt, std::nullopt)
            .then(guard([&](const js::Blob& blob) {
                check(blob.type() == "image/png" &&
                          pal::decode_image(blob.bytes()).rgba == std::vector<std::uint8_t>(8, 0),
                      "an undrawn canvas encodes transparent black");
                settle();
            }));
        // Resizing resets the 2D bitmap.
        const auto resized_context = pal::offscreen_canvas_context_2d(resized);
        ++expected;
        pal::create_image_bitmap(source, 4, 3, std::nullopt, options(), resize())
            .then(guard([&, resized_context](const pal::ImageBitmap& bitmap) {
                pal::offscreen_canvas_draw_image(*resized_context, bitmap, 0, 0);
                resized->set_width(2);
                pal::offscreen_canvas_convert_to_blob(resized, std::nullopt, std::nullopt)
                    .then(guard([&](const js::Blob& blob) {
                        const auto decoded = pal::decode_image(blob.bytes());
                        check(decoded.width == 2 && decoded.rgba == std::vector<std::uint8_t>(8, 0),
                              "a resized canvas's bitmap is cleared");
                        settle();
                    }));
            }));
        ++expected;
        pal::offscreen_canvas_convert_to_blob(js::make_gc_shared<pal::OffscreenCanvas>(0, 4),
                                              std::nullopt, std::nullopt)
            .then(guard([&](const js::Blob&) {
                      throw std::runtime_error("an empty canvas encoded");
                  }),
                  guard([&](std::exception_ptr error) {
                      check(js::error_name(error) == "IndexSizeError",
                            "an empty canvas's rejection");
                      settle();
                  }));
    });
    if (failure)
        std::rethrow_exception(failure);
    check(settled == expected, "every promise settled");
    check(order.size() == 2 && order[0] == "microtask" && order[1] == "bitmap",
          "a bitmap resolves in a later task");
    std::printf("ok\n");
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
}
