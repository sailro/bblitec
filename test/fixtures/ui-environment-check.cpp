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

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    const pal::UiSafeAreaInsets notch{44, 0, 34, 0};
    check(pal::rml_css_environment("calc(90px + env(safe-area-inset-bottom))", notch) ==
              "calc(90px + 34.000000px)",
          "a safe-area inset is the window's");
    check(pal::rml_css_environment("max(12px, env( safe-area-inset-top , 1px ))", notch) ==
              "max(12px, 44.000000px)",
          "a defined variable ignores its fallback");
    check(pal::rml_css_environment("env(keyboard-inset-height, env(safe-area-inset-left, 3px))",
                                   notch) == "0.000000px",
          "an undefined variable takes its fallback");
    check(pal::rml_css_environment("content:'env(x)'", notch) == "content:'env(x)'",
          "strings keep their text");
    bool refused = false;
    try {
        static_cast<void>(pal::rml_css_environment("env(titlebar-area-x)", notch));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    check(refused, "an undefined variable without a fallback refuses");

    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI environment fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        // A page without env() reads no safe area.
        Engine engine;
        engine.ui_viewport_fit_cover = true;
        const auto panel = ui_create_element(engine, "div");
        ui_set_style_property(engine, panel, "width", "calc(40px + 2px)");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(!runtime.safe_area_insets, "a page without env() reads no safe area");
    }
    {
        Engine engine;
        engine.ui_viewport_fit_cover = true;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "bar",
                           "padding:0 max(14px, env(safe-area-inset-right)) "
                           "max(12px, env(safe-area-inset-bottom)) 0;height:10px;");
        ui_append_to_root(engine, sheet);
        const auto bar = ui_create_element(engine, "div");
        ui_set_attribute(engine, bar, "class", "bar");
        ui_set_style_property(engine, bar, "width", "calc(40px + env(safe-area-inset-left))");
        ui_append_to_root(engine, bar);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        // A desktop window's safe area is the whole window, as a desktop
        // browser's insets are zero.
        check(runtime.safe_area_insets && *runtime.safe_area_insets == pal::UiSafeAreaInsets{},
              "a desktop window has no insets");
        const auto size = runtime.projected_elements.at(bar.value).element->GetBox().GetSize(
            Rml::BoxArea::Border);
        if (std::abs(size.x - 54) >= .01f || std::abs(size.y - 22) >= .01f)
            std::fprintf(stderr, "bar %gx%g\n", size.x, size.y);
        check(std::abs(size.x - 54) < .01f && std::abs(size.y - 22) < .01f,
              "rule and inline style env() resolve before their math");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI environment failure: %s\n", error.what());
    return 1;
}
