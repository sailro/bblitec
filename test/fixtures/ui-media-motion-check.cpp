#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected fixture asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
}

namespace {
bool reduced = false;
bool read_motion_preference() { return reduced; }
}

int main() {
    using namespace bbl;
    static_cast<void>(pal::system_reduced_motion());
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("UI motion preference fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto sheet = ui_create_element(engine, "style");
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "panel", "", "", false, -1,
            "width:40px;background-color:#123456;", UiScrollbarPart::None, false, false, UiMotionPreference::NoPreference);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "panel", "", "", false, -1,
            "width:80px;background-color:#abcdef;animation:none;transition:none;", UiScrollbarPart::None, false, false, UiMotionPreference::Reduce);
        ui_append_to_root(engine, sheet);
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "class", "panel");
        ui_set_attribute(engine, panel, "style", "height:20px;");
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480, read_motion_preference);
        const auto check = [&](float width, uint8_t red) {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            auto* raw = runtime.projected_elements.at(panel.value).element;
            assert(std::abs(raw->GetBox().GetSize(Rml::BoxArea::Border).x - width) < .01f);
            const auto& frame = pal::record_ui_rml_frame(runtime, 640, 480);
            assert(std::any_of(frame.vertices.begin(), frame.vertices.end(), [&](const auto& vertex) {
                return vertex.red == red && vertex.alpha == 255;
            }));
        };
        check(40, 0x12);
        reduced = true;
        check(80, 0xab);
        reduced = false;
        check(40, 0x12);
        ui_clear_style_rules(engine, sheet);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!runtime.observes_motion_preference);
        ui_add_style_rule(engine, sheet, UiStyleSelectorKind::Class, "panel", "", "", false, -1,
            "--bbl-inset-outline:2px solid #ff0000;", UiScrollbarPart::None, false, false, UiMotionPreference::Reduce);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.observes_motion_preference);
        assert(!runtime.projected_elements.at(panel.value).inset_outline_element);
        reduced = true;
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(runtime.projected_elements.at(panel.value).inset_outline_element);
        reduced = false;
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!runtime.projected_elements.at(panel.value).inset_outline_element);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
