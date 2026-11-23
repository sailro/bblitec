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
    auto* window = SDL_CreateWindow("Computed box edges", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_append_to_root(engine, sheet);
        ui_add_class_style(engine, sheet, "plate",
                           "width:100px;padding:3px 5px 7.5px 9px;border:2px solid #000;"
                           "border-bottom-width:4px;");
        ui_add_class_style(engine, sheet, "bordered", "box-sizing:border-box;border-style:none;");
        const auto plate = ui_create_element(engine, "div");
        ui_set_attribute(engine, plate, "class", "plate");
        ui_append_to_root(engine, plate);
        const auto bordered = ui_create_element(engine, "div");
        ui_set_attribute(engine, bordered, "class", "plate bordered");
        ui_append_to_root(engine, bordered);
        // A first read requests the style; the next layout serializes it.
        static_cast<void>(ui_computed_style(engine, plate, "box-sizing"));
        static_cast<void>(ui_computed_style(engine, bordered, "box-sizing"));
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expect(ui_computed_style(engine, plate, "box-sizing"), "content-box", "the initial sizing");
        expect(ui_computed_style(engine, bordered, "box-sizing"), "border-box",
               "a declared sizing");
        expect(ui_computed_style(engine, plate, "padding-top"), "3px", "the top padding");
        expect(ui_computed_style(engine, plate, "padding-right"), "5px", "the right padding");
        expect(ui_computed_style(engine, plate, "padding-bottom"), "7.5px", "a fractional padding");
        expect(ui_computed_style(engine, plate, "padding-left"), "9px", "the left padding");
        expect(ui_computed_style(engine, plate, "border-top-width"), "2px", "the top border");
        expect(ui_computed_style(engine, plate, "border-bottom-width"), "4px", "a longhand border");
        expect(ui_computed_style(engine, bordered, "border-top-width"), "0px",
               "a border without a style has no width");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Computed box edge fixture: %s\n", error.what());
    return 1;
}
