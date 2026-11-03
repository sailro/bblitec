#include "pal_ui_rml.cpp"

#include <bblite/js_synchronous_promise.hpp>
#include <fstream>

namespace bbl {
std::string asset_path(const std::string& path) { return "artifacts/ui-canvas-images/" + path; }
} // namespace bbl
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Unable to read fixture image: " + path);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool result, const char* message) {
        if (!result)
            throw std::runtime_error(message);
    };
    // frame.png: 4x4, pixel (x, y) = (60x, 60y, 100, 255) but (3, 3) = (200, 100, 50, 128).
    const auto image_pixel = [](int x, int y) {
        return x == 3 && y == 3 ? std::array<int, 4>{199, 100, 50, 128}
                                : std::array<int, 4>{60 * x, 60 * y, 100, 255};
    };
    const auto expect_pixel = [&](const UiCanvasImageData& data, int x, int y,
                                  std::array<int, 4> wanted, const char* message) {
        const std::size_t offset = (static_cast<std::size_t>(y) * data.width + x) * 4;
        for (std::size_t channel = 0; channel < 4; ++channel)
            if (std::abs(data.data[offset + channel] - wanted[channel]) > 1) {
                std::fprintf(stderr, "%s: (%d, %d) channel %zu is %d, not %d\n", message, x, y,
                             channel, data.data[offset + channel], wanted[channel]);
                check(false, message);
            }
    };
    const auto throws = [](const auto& work, std::string_view name) {
        try {
            work();
        } catch (const js::NamedError& error) {
            return name.empty() || error.name == name;
        } catch (const std::runtime_error&) {
            return name.empty();
        }
        return false;
    };
    // A promise's resolve and reject functions each keep one identity.
    const auto resolving = [&](const auto& promise) {
        const auto reject = promise.resolving_function_identity(true);
        check(reject == promise.resolving_function_identity(true) &&
                  reject != promise.resolving_function_identity(false),
              "resolving function identities");
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Canvas image fixture", 320, 240, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    pal::EventLoop loop;
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    Engine engine;
    const auto canvas = ui_create_element(engine, "canvas");
    const auto image = ui_create_element(engine, "img");
    const auto broken = ui_create_element(engine, "img");
    const auto versioned = ui_create_element(engine, "img");
    loop.run([&] {
        resolving(js::Promise<double>{});
        resolving(js::SynchronousPromise<double>{});
        ui_canvas_set_width(engine, canvas, 8);
        ui_canvas_set_height(engine, canvas, 8);
        ui_set_attribute(engine, image, "src", "frame.png");
        ui_set_attribute(engine, broken, "src", "missing.png");
        ui_set_attribute(engine, versioned, "src", "/frame.png?v=2#top");
        // An image still loading draws nothing.
        ui_canvas_draw_image(engine, canvas, image, 0, 0);
        check(ui_element(engine, canvas).canvas->draws.empty(), "a loading image draws nothing");
        pal::EventLoop::current().post([&] {
            // An unrendered image's size: its attribute, else its natural size.
            check(ui_image_width(engine, image) == 4 && ui_image_height(engine, image) == 4,
                  "an unrendered image's natural size");
            check(ui_image_width(engine, versioned) == 4,
                  "a query and fragment name the same file");
            ui_set_attribute(engine, broken, "width", "7");
            check(ui_image_width(engine, broken) == 7 && ui_image_height(engine, broken) == 0,
                  "a dimension attribute, else a broken image's zero");
            ui_canvas_draw_image(engine, canvas, image, 0, 0);
            auto data = ui_canvas_get_image_data(engine, canvas, 0, 0, 4, 4);
            check(data.width == 4 && data.height == 4 && data.data.size() == 64, "readback size");
            for (int y = 0; y < 4; ++y)
                for (int x = 0; x < 4; ++x)
                    expect_pixel(data, x, y, image_pixel(x, y), "an image draws its pixels");

            // A mirrored draw through save/translate/scale/restore.
            ui_canvas_save(engine, canvas);
            ui_canvas_translate(engine, canvas, 8, 0);
            ui_canvas_scale(engine, canvas, -1, 1);
            ui_canvas_draw_image(engine, canvas, image, 0, 0);
            ui_canvas_restore(engine, canvas);
            check(ui_element(engine, canvas).canvas->drawing.transform.a == 1, "restore");
            data = ui_canvas_get_image_data(engine, canvas, 4, 0, 4, 4);
            for (int y = 0; y < 4; ++y)
                for (int x = 0; x < 4; ++x)
                    expect_pixel(data, x, y, image_pixel(3 - x, y), "a mirrored draw");

            // The smoothing quality is an enum: other strings are ignored.
            ui_canvas_set_image_smoothing_quality(engine, canvas, "high");
            ui_canvas_set_image_smoothing_quality(engine, canvas, "best");
            check(ui_element(engine, canvas).canvas->drawing.image_smoothing_quality == "high",
                  "image smoothing quality");
            // A source rectangle stretched without smoothing.
            ui_canvas_set_image_smoothing(engine, canvas, false);
            ui_canvas_draw_image(engine, canvas, image, 1, 1, 2, 2, 0, 4, 4, 4);
            data = ui_canvas_get_image_data(engine, canvas, 0, 4, 4, 4);
            for (int y = 0; y < 4; ++y)
                for (int x = 0; x < 4; ++x)
                    expect_pixel(data, x, y, image_pixel(1 + x / 2, 1 + y / 2),
                                 "a nearest source rectangle");
            // The source rectangle clips to the image and the destination in proportion.
            ui_canvas_draw_image(engine, canvas, image, 2, 2, 4, 4, 4, 4, 4, 4);
            data = ui_canvas_get_image_data(engine, canvas, 4, 4, 4, 4);
            expect_pixel(data, 0, 0, image_pixel(2, 2), "a clipped source rectangle");
            expect_pixel(data, 1, 1, image_pixel(3, 3), "a clipped source rectangle");
            expect_pixel(data, 2, 2, {0, 0, 0, 0}, "the clipped destination stays clear");

            // The canvas renders the bitmap as a texture.
            ui_append_to_root(engine, canvas);
            ui_append_to_root(engine, image);
            check(throws([&] { static_cast<void>(ui_image_width(engine, image)); }, ""),
                  "a rendered image's size refuses");
            {
                pal::UiRmlRuntime runtime(engine, window, 320, 240);
                const auto& frame = pal::record_ui_rml_frame(runtime, 320, 240);
                check(std::any_of(frame.draws.begin(), frame.draws.end(),
                                  [](const auto& draw) { return draw.texture_id != 0; }),
                      "the image draw renders textured");
            }

            // clearRect cannot cut an image draw; a full clear drops everything.
            check(throws([&] { ui_canvas_clear_rect(engine, canvas, 1, 1, 1, 1); }, ""),
                  "a clear cutting an image refuses");
            ui_canvas_clear_rect(engine, canvas, 0, 0, 8, 8);
            check(ui_element(engine, canvas).canvas->draws.empty(), "a full clear");
            ui_canvas_set_fill_style(engine, canvas, "#ff0000");
            ui_canvas_fill_rect(engine, canvas, 0, 0, 2, 2);
            ui_canvas_set_fill_style(engine, canvas, "rgba(0,0,255,0.5)");
            ui_canvas_fill_rect(engine, canvas, 1, 1, 2, 2);
            data = ui_canvas_get_image_data(engine, canvas, 0, 0, 3, 3);
            expect_pixel(data, 0, 0, {255, 0, 0, 255}, "an opaque fill");
            expect_pixel(data, 1, 1, {127, 0, 128, 255}, "a translucent fill over an opaque one");
            expect_pixel(data, 2, 2, {0, 0, 255, 128}, "a translucent fill over nothing");
            // Negative extents normalize; a zero one and a non-finite one throw.
            data = ui_canvas_get_image_data(engine, canvas, 2, 2, -2, -2);
            expect_pixel(data, 0, 0, {255, 0, 0, 255}, "a normalized rectangle");
            check(throws([&] { ui_canvas_get_image_data(engine, canvas, 0, 0, 0, 2); },
                         "IndexSizeError"),
                  "a zero-width readback");
            check(throws(
                      [&] {
                          ui_canvas_get_image_data(engine, canvas, 0, 0,
                                                   std::numeric_limits<double>::infinity(), 2);
                      },
                      "TypeError"),
                  "a non-finite readback");
            // A broken image throws InvalidStateError.
            check(throws([&] { ui_canvas_draw_image(engine, canvas, broken, 0, 0); },
                         "InvalidStateError"),
                  "a broken image");
            // A path draw cannot be read back.
            ui_canvas_begin_path(engine, canvas);
            ui_canvas_move_to(engine, canvas, 0, 0);
            ui_canvas_line_to(engine, canvas, 4, 0);
            ui_canvas_line_to(engine, canvas, 0, 4);
            ui_canvas_fill(engine, canvas);
            check(throws([&] { ui_canvas_get_image_data(engine, canvas, 0, 0, 1, 1); }, ""),
                  "a path readback refuses");
            loop.close();
        });
    });
    if (failure)
        std::rethrow_exception(failure);
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Canvas image fixture: %s\n", error.what());
    return 1;
}
