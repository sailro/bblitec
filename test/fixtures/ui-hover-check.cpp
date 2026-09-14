#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI hover fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(engine, sheet, "menu_entry", "background-color:#123456;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "menu_entry", "", "", true, -1,
            "background-color:#abcdef;");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "menu_entry", "", "", false, -1,
            "background-color:#edab12;", UiScrollbarPart::None, false, true);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "menu_entry", "", "", false, -1,
            "background-color:#1122ff;", UiScrollbarPart::None, true, false);
        ui_append_to_root(engine, sheet);
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "class", "menu_entry");
        ui_set_attribute(engine, panel, "style", "position:absolute;left:20px;top:20px;width:100px;height:40px;pointer-events:auto;");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto mouse_button = [&](bool down) {
            SDL_Event event{};
            event.type = down ? SDL_EVENT_MOUSE_BUTTON_DOWN : SDL_EVENT_MOUSE_BUTTON_UP;
            event.button.windowID = SDL_GetWindowID(window);
            event.button.button = SDL_BUTTON_LEFT;
            event.button.down = down;
            event.button.x = 40;
            event.button.y = 40;
            static_cast<void>(pal::handle_ui_rml_event(runtime, event));
        };
        const auto color = [&](uint8_t red, uint8_t green, uint8_t blue) {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            const bool found = std::any_of(frame.vertices.begin(), frame.vertices.end(), [&](const auto& vertex) {
                return vertex.red == red && vertex.green == green && vertex.blue == blue && vertex.alpha == 255;
            });
            if (!found) {
                auto* raw = runtime.projected_elements.at(panel.value).element;
                const auto actual = raw->GetProperty(Rml::PropertyId::BackgroundColor)->Get<Rml::Colourb>();
                std::fprintf(stderr, "Expected color %02x%02x%02x; actual %02x%02x%02x; hover %d active %d focus %d focus-visible %d\n",
                    red, green, blue, actual.red, actual.green, actual.blue,
                    raw->IsPseudoClassSet("hover"), raw->IsPseudoClassSet("active"), raw->IsPseudoClassSet("focus"), raw->IsPseudoClassSet("focus-visible"));
            }
            assert(found);
        };
        color(0x12, 0x34, 0x56);
        runtime.context->ProcessMouseMove(40, 40, 0);
        color(0xab, 0xcd, 0xef);
        assert(runtime.projected_elements.at(panel.value).element->IsPseudoClassSet("hover"));
        mouse_button(true);
        color(0xed, 0xab, 0x12);
        mouse_button(false);
        color(0xab, 0xcd, 0xef);
        runtime.context->ProcessMouseMove(200, 100, 0);
        color(0x12, 0x34, 0x56);
        assert(!runtime.projected_elements.at(panel.value).element->IsPseudoClassSet("hover"));
        ui_focus(engine, panel, true);
        color(0x11, 0x22, 0xff);
        ui_focus(engine, panel, false);
        color(0x12, 0x34, 0x56);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
