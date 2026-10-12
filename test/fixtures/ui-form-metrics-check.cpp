#include "pal_ui_rml.cpp"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstdlib>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
void require(bool condition, const char* what) {
    if (!condition)
        throw std::runtime_error(what);
}

// Chromium 152's coverage (0-255) of a light 13.333px Arial select's arrow,
// 12x8 pixels around its center, and of a closed 12px Segoe UI disclosure
// marker from its summary's padding-box origin, rows 5 to 12.
constexpr std::array<int, 96> chromium_chevron{
    0,   0,  0,  0,   0,   0,   0,   0,   0,  0,  0,  0,   0,   0,   127, 32,  0,   0,   0,   0,
    32,  96, 0,  0,   0,   127, 255, 223, 32, 0,  0,  32,  191, 255, 96,  0,   0,   32,  223, 255,
    223, 32, 32, 191, 255, 223, 0,   0,   0,  0,  32, 223, 255, 223, 191, 255, 223, 0,   0,   0,
    0,   0,  0,  32,  223, 255, 255, 223, 0,  0,  0,  0,   0,   0,   0,   0,   32,  223, 223, 0,
    0,   0,  0,  0,   0,   0,   0,   0,   0,  32, 0,  0,   0,   0,   0,   0,
};
constexpr std::array<int, 72> chromium_disclosure{
    153, 25,  0,   0,   0,   0,   0,  0, 0, 255, 245, 117, 0,   0,   0,   0,  0, 0,
    255, 255, 255, 209, 81,  0,   0,  0, 0, 255, 255, 255, 255, 255, 174, 46, 0, 0,
    255, 255, 255, 255, 255, 194, 66, 0, 0, 255, 255, 255, 230, 102, 0,   0,  0, 0,
    255, 255, 138, 10,  0,   0,   0,  0, 0, 174, 45,  0,   0,   0,   0,   0,  0, 0,
};

/** Mean absolute coverage difference of a texture's alpha against Chromium's. */
template <std::size_t N>
double coverage_error(const bbl::pal::UiRenderTexture& texture, const std::array<int, N>& expected,
                      int width, int first_row) {
    double sum = 0;
    for (std::size_t index = 0; index < N; ++index) {
        const int x = static_cast<int>(index) % width,
                  y = static_cast<int>(index) / width + first_row;
        const auto alpha =
            (*texture.rgba)[(static_cast<std::size_t>(y) * texture.width + x) * 4 + 3];
        sum += std::abs(static_cast<int>(alpha) - expected[index]);
    }
    return sum / N / 255.0;
}
} // namespace

int main() try {
    using namespace bbl;
    using namespace bbl::pal;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Form metrics fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto add = [&](std::string_view tag, std::string style) {
            const auto handle = ui_create_element(engine, tag);
            if (!style.empty())
                ui_set_attribute(engine, handle, "style", std::move(style));
            ui_append_to_root(engine, handle);
            return handle;
        };
        const auto option = [&](UiElementHandle select, std::string label) {
            const auto handle = ui_create_element(engine, "option");
            ui_set_text(engine, handle, std::move(label));
            ui_append_child(engine, select, handle);
        };
        const auto intrinsic = add("select", "display:block;");
        option(intrinsic, "Lower memory \xC2\xB7 1M splats");
        option(intrinsic, "High detail \xC2\xB7 4M splats");
        const auto wide = add("select", "display:block;width:300px;");
        option(wide, "Lower memory");
        const auto details = add("details", "font:12px 'Segoe UI';");
        const auto summary = ui_create_element(engine, "summary");
        ui_set_text(engine, summary, "Camera pose");
        ui_append_child(engine, details, summary);

        UiRmlRuntime runtime(engine, window, 640, 480);
        update_ui_rml_runtime(runtime, 640, 480);
        static_cast<void>(record_ui_rml_frame(runtime, 640, 480));
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        // Chromium sizes this select to 180x19: border, a 4px inset, the
        // longest label rounded up, then 16px for the arrow.
        const auto size = element(intrinsic)->GetBox().GetSize(Rml::BoxArea::Border);
        require(size.x == 180.f && size.y == 19.f, "select intrinsic size");
        // The arrow is centered 9px from the right edge, on the rounded-down middle.
        auto* select = element(wide);
        auto* arrow = select->GetChild(0);
        const auto box = select->GetBox().GetSize(Rml::BoxArea::Border);
        const auto center = arrow->GetAbsoluteOffset(Rml::BoxArea::Border) +
                            arrow->GetBox().GetSize(Rml::BoxArea::Border) * .5f -
                            select->GetAbsoluteOffset(Rml::BoxArea::Border);
        require(center.x == box.x - 9.f && center.y == 9.f, "select arrow center");
        // The label starts after the 4px internal inset.
        const auto label = select->GetChild(1)->GetAbsoluteOffset(Rml::BoxArea::Border) -
                           select->GetAbsoluteOffset(Rml::BoxArea::Border);
        require(label.x == 5.f, "select label inset");
        const auto texture = [&](std::uint32_t width,
                                 std::uint32_t height) -> const UiRenderTexture& {
            for (const auto& candidate : runtime.render_interface.frame.textures)
                if (candidate.width == width && candidate.height == height && candidate.rgba)
                    return candidate;
            throw std::runtime_error("Missing control mark texture");
        };
        const double chevron = coverage_error(texture(12, 8), chromium_chevron, 12, 0);
        const double disclosure = coverage_error(texture(9, 9), chromium_disclosure, 9, 0);
        if (chevron > 0.06 || disclosure > 0.03) {
            std::fprintf(stderr, "chevron %.4f disclosure %.4f\n", chevron, disclosure);
            throw std::runtime_error("control mark coverage differs from Chromium");
        }
        // Chromium places the summary text 0.66em + 0.4em after the marker's edge.
        const auto text = element(summary)->GetBox().GetPosition(Rml::BoxArea::Content);
        require(std::abs(text.x - 12.72f) < 1e-3f, "summary text inset");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Form metrics: %s\n", error.what());
    return 1;
}
