#include "pal_ui_rml.cpp"

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
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
    const auto expect = [&](const std::string& actual, const char* wanted, const char* message) {
        if (actual != wanted) {
            std::fprintf(stderr, "%s: '%s' != '%s'\n", message, actual.c_str(), wanted);
            check(false, message);
        }
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    auto* window = SDL_CreateWindow("Computed custom properties", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(
            engine, sheet, "menu",
            "--gap: 12px;--math: calc(10px + 2px);--chain: var(--gap) var(--none, 1em);"
            "--font: system-ui;width:var(--gap);height:4px;");
        const auto menu = ui_create_element(engine, "div");
        ui_set_attribute(engine, menu, "class", "menu");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, child, "style", "--own: 3px;width:10px;height:2px;");
        ui_append_child(engine, menu, child);
        ui_append_to_root(engine, menu);
        // A first read names the properties; the next layout serializes them.
        for (const char* name : {"--gap", "--math", "--chain", "--font", "--none"})
            static_cast<void>(ui_computed_style(engine, menu, name));
        for (const char* name : {"--gap", "--own"})
            static_cast<void>(ui_computed_style(engine, child, name));
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        update();
        // The specified text, not the projection's (12dp, 12dp, a resolved font family).
        expect(ui_computed_style(engine, menu, "--gap"), "12px", "a custom property's text");
        expect(ui_computed_style(engine, menu, "--math"), "calc(10px + 2px)",
               "math stays as written");
        expect(ui_computed_style(engine, menu, "--chain"), "12px 1em", "var() substitutes");
        expect(ui_computed_style(engine, menu, "--font"), "system-ui",
               "font keywords stay as written");
        expect(ui_computed_style(engine, menu, "--none"), "",
               "an undefined custom property is empty");
        expect(ui_computed_style(engine, child, "--gap"), "12px", "custom properties inherit");
        expect(ui_computed_style(engine, child, "--own"), "3px", "an inline style attribute's");
        // The projection still applies its own form for layout.
        auto* raw = runtime.projected_elements.at(menu.value).element;
        check(std::abs(raw->GetBox().GetSize(Rml::BoxArea::Border).x - 12.0f) < 0.1f,
              "var() layout reads the projected value");
        // Inline writes and removals follow the cascade.
        ui_set_style_property(engine, menu, "--gap", "20px");
        update();
        expect(ui_computed_style(engine, menu, "--gap"), "20px", "an inline write");
        expect(ui_computed_style(engine, menu, "--chain"), "20px 1em",
               "a write reaches what substitutes it");
        check(std::abs(raw->GetBox().GetSize(Rml::BoxArea::Border).x - 20.0f) < 0.1f,
              "an inline write lays out");
        ui_remove_style_property(engine, menu, "--gap");
        update();
        expect(ui_computed_style(engine, menu, "--gap"), "12px", "a removal restores the rule's");
        check(ui_get_style_property(engine, menu, "--bbl-specified--gap").empty(),
              "the twin stays private");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Computed custom property fixture: %s\n", error.what());
    return 1;
}
