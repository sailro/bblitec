#define main generated_main
#include "../../artifacts/ui-runtime-image-src/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cstdio>
#include <fstream>
#include <iterator>

namespace bbl {
std::string asset_path(const std::string& path) {
    return "artifacts/ui-runtime-image-src/public/" + path;
}
} // namespace bbl
namespace bbl::pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Missing fixture file: " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
} // namespace bbl::pal
#define FIXTURE_APPLICATION_TIMEOUT_MS 5000
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window =
        SDL_CreateWindow("UI runtime image source fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        // The empty source failed first (its task was queued at the write), then each decode
        // completed in src write order: the image, the missing file, the preloaded image.
        const auto log = ui_element(engine, ui_get_element_by_id(engine, "log")).text;
        if (log != "EAMP")
            std::fprintf(stderr, "log: %s\n", log.c_str());
        check(log == "EAMP", "load and error events");

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        // The color of the textured draw covering a point, as the decoded image holds it.
        const auto color_at = [&](float x, float y) -> std::uint32_t {
            for (const auto& draw : frame.draws) {
                if (!draw.texture_id)
                    continue;
                float min_x = 1e6f, min_y = 1e6f, max_x = -1e6f, max_y = -1e6f;
                for (auto i = draw.first_index; i < draw.first_index + draw.index_count; ++i) {
                    const auto& vertex = frame.vertices[frame.indices[i]];
                    min_x = std::min(min_x, vertex.x);
                    max_x = std::max(max_x, vertex.x);
                    min_y = std::min(min_y, vertex.y);
                    max_y = std::max(max_y, vertex.y);
                }
                if (x < min_x || x > max_x || y < min_y || y > max_y)
                    continue;
                for (const auto& texture : frame.textures) {
                    if (texture.id != draw.texture_id || !texture.rgba)
                        continue;
                    const auto& pixels = *texture.rgba;
                    const std::size_t center =
                        (static_cast<std::size_t>(texture.height / 2) * texture.width +
                         texture.width / 2) *
                        4;
                    return (static_cast<std::uint32_t>(pixels[center]) << 24) |
                           (static_cast<std::uint32_t>(pixels[center + 1]) << 16) |
                           (static_cast<std::uint32_t>(pixels[center + 2]) << 8) |
                           pixels[center + 3];
                }
            }
            return 0;
        };
        constexpr std::uint32_t red = 0xff0000ff, green = 0x00ff00ff, blue = 0x0000ffff;
        const struct {
            float left;
            std::uint32_t color;
            const char* image;
        } expected[] = {{0, red, "a"},    {20, green, "c0"},  {40, blue, "c1"},   {60, red, "d0"},
                        {80, blue, "d1"}, {100, green, "f0"}, {120, blue, "f1"},  {140, blue, "g0"},
                        {160, 0, "g1"},   {180, 0, "g2"},     {200, green, "f2"}, {220, blue, "d2"},
                        {240, red, "g3"}};
        for (const auto& image : expected) {
            const auto color = color_at(image.left + 5, 5);
            if (color != image.color)
                std::fprintf(stderr, "%s: %08x\n", image.image, color);
            check(color == image.color, "image pixels");
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI runtime image source failure: %s\n", error.what());
    return 1;
}
