#include "pal_ui_rml.cpp"
#include <cmath>
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

namespace {
// A desktop until a step says otherwise.
bbl::InputCapabilities device{bbl::PointerPrecision::Fine, true};
bbl::InputCapabilities read_input() { return device; }
bool reduced = false;
bool read_motion() { return reduced; }
} // namespace

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI input media fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        const auto rule = [&](std::string style, UiMediaCondition media) {
            ui_add_style_rule(engine, sheet,
                              {.primary = "panel", .style = std::move(style), .media = media});
        };
        rule("width:40px;height:20px;", {});
        // @media (hover: none) and (pointer: coarse)
        rule("width:80px;", {.hover = false, .pointer = PointerPrecision::Coarse});
        // @media (prefers-reduced-motion: reduce) and (pointer: fine)
        rule("height:30px;", {.reduced_motion = true, .pointer = PointerPrecision::Fine});
        ui_append_to_root(engine, sheet);
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "class", "panel");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480, read_motion, read_input);
        const auto size = [&] {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            return runtime.projected_elements.at(panel.value)
                .element->GetBox()
                .GetSize(Rml::BoxArea::Border);
        };
        const auto expect = [&](float width, float height, const char* message) {
            const auto box = size();
            if (std::abs(box.x - width) >= .01f || std::abs(box.y - height) >= .01f)
                std::fprintf(stderr, "%s: %gx%g\n", message, box.x, box.y);
            check(std::abs(box.x - width) < .01f && std::abs(box.y - height) < .01f, message);
        };
        expect(40, 20, "a mouse hovers and points finely");
        check(runtime.observes_input_capabilities(), "the sheet observes the pointing device");
        device = {PointerPrecision::Coarse, false};
        expect(80, 20, "touch alone points coarsely without hover");
        reduced = true;
        expect(80, 20, "a conjunction holds only while all its features do");
        device = {PointerPrecision::Fine, true};
        expect(40, 30, "reduced motion with a fine pointer");
        device = {PointerPrecision::None, false};
        expect(40, 20, "no pointing device is neither coarse nor fine");
        reduced = false;
        ui_clear_style_rules(engine, sheet);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(!runtime.observes_input_capabilities() && !runtime.observes_motion_preference(),
              "a sheet without such features reads no device state");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI input media failure: %s\n", error.what());
    return 1;
}
