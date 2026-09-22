#include "pal_ui_rml.cpp"

namespace {
double fixture_time = 1000;
}
namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return fixture_time; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI visibility fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "fade-open",
                           "visibility:visible;opacity:1;transition:opacity 0.2s linear;");
        ui_add_class_style(
            engine, sheet, "fade-closed",
            "visibility:hidden;opacity:0;transition:opacity 0.2s linear,visibility 0s linear 0.2s;");
        ui_append_to_root(engine, sheet);
        const auto parent = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, parent, "style",
            "position:absolute;left:20px;top:20px;width:120px;height:50px;background-color:#ff0000;visibility:hidden;z-index:2;");
        ui_append_to_root(engine, parent);
        const auto inherited = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, inherited, "style",
            "position:absolute;left:10px;top:10px;width:20px;height:20px;background-color:#0000ff;pointer-events:auto;");
        ui_append_child(engine, parent, inherited);
        const auto shown = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, shown, "style",
            "position:absolute;left:50px;top:10px;width:20px;height:20px;background-color:#00ff00;visibility:visible;pointer-events:auto;");
        ui_append_child(engine, parent, shown);
        const auto delayed = ui_create_element(engine, "div");
        ui_set_attribute(
            engine, delayed, "style",
            "position:absolute;left:200px;top:20px;width:60px;height:30px;background-color:#123456;");
        ui_set_attribute(engine, delayed, "class", "fade-open");
        ui_append_to_root(engine, delayed);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        update();
        auto* p = runtime.projected_elements.at(parent.value).element;
        auto* hidden = runtime.projected_elements.at(inherited.value).element;
        auto* visible = runtime.projected_elements.at(shown.value).element;
        auto* fade = runtime.projected_elements.at(delayed.value).element;
        check(!p->IsVisible() && !hidden->IsVisible(), "visibility inheritance");
        check(visible->IsVisible(true), "visible child beneath hidden ancestor");
        check(p->GetBox().GetSize().x == 120.f && p->GetBox().GetSize().y == 50.f,
              "hidden layout retained");
        const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
        const auto painted = [&](uint8_t red, uint8_t green, uint8_t blue) {
            return std::any_of(frame.vertices.begin(), frame.vertices.end(), [&](const auto& v) {
                return v.red == red && v.green == green && v.blue == blue && v.alpha == 255;
            });
        };
        check(!painted(255, 0, 0) && !painted(0, 0, 255) && painted(0, 255, 0),
              "visibility paint and stacking context");
        check(runtime.context->GetElementAtPoint({75, 35}) == visible,
              "visible descendant hit testing");
        check(runtime.context->GetElementAtPoint({35, 35}) != hidden,
              "hidden descendant hit testing");
        check(!hidden->Focus() && visible->Focus(), "visibility focus eligibility");
        ui_set_style_property(engine, parent, "display", "none");
        update();
        check(!visible->IsVisible(true), "display none still hides the entire subtree");
        ui_set_style_property(engine, parent, "display", "");
        ui_set_style_property(engine, parent, "visibility", "visible");
        update();
        check(hidden->IsVisible(true), "visibility inheritance updates");
        ui_set_attribute(engine, delayed, "class", "fade-closed");
        update();
        fixture_time += 100;
        update();
        check(fade->IsVisible() && fade->GetComputedValues().opacity() > 0.1f &&
                  fade->GetComputedValues().opacity() < 0.9f,
              "delayed hiding preserves the fade");
        fixture_time += 100;
        update();
        fixture_time += 10;
        update();
        check(!fade->IsVisible(), "zero-duration transition completes after its delay");
        ui_set_attribute(engine, delayed, "class", "fade-open");
        update();
        fixture_time += 1;
        update();
        check(fade->IsVisible(), "zero-duration visibility restoration");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI visibility failure: %s\n", error.what());
    return 1;
}
