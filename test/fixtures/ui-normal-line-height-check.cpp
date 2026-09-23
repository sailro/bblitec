#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Normal line height", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto parent = ui_create_element(engine, "div");
        ui_set_attribute(engine, parent, "style", "font-family:system-ui;font-size:12px;");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, child, "style", "font-size:24px;");
        ui_set_text(engine, child, "Font metrics");
        ui_append_child(engine, parent, child);
        ui_append_to_root(engine, parent);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto element = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value).element;
        };
        const auto normal = [&](UiElementHandle handle) {
            auto* raw = element(handle);
            const auto& values = raw->GetComputedValues();
            assert(values.font_face_handle());
            const auto& metrics =
                Rml::GetFontEngineInterface()->GetFontMetrics(values.font_face_handle());
            assert(values.line_height().inherit_type == Rml::Style::LineHeight::Normal);
            assert(std::abs(raw->GetLineHeight() - metrics.line_spacing) < .001f);
        };
        update();
        normal(parent);
        normal(child);
        assert(element(child)->GetLineHeight() > element(parent)->GetLineHeight() * 1.8f);
        for (const char* style : {"font-family:sans-serif;font-size:18px;font-weight:700;",
                                  "font-family:monospace;font-size:10px;"}) {
            ui_set_attribute(engine, child, "style", style);
            update();
            normal(child);
        }
        ui_set_style_property(engine, parent, "line-height", "2");
        update();
        assert(element(parent)->GetLineHeight() == 24);
        assert(element(child)->GetLineHeight() == 20);
        ui_set_style_property(engine, parent, "line-height", "30px");
        update();
        assert(element(parent)->GetLineHeight() == 30);
        assert(element(child)->GetLineHeight() == 30);
        ui_set_style_property(engine, child, "line-height", "normal");
        update();
        normal(child);
        ui_remove_style_property(engine, parent, "line-height");
        update();
        normal(parent);
        normal(child);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
