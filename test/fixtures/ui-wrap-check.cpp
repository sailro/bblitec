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
    SDL_Window* window = SDL_CreateWindow("UI wrapping fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        const auto child = ui_create_element(engine, "span");
        ui_set_attribute(engine, panel, "style", "width:64px;font-size:16px;white-space:normal;overflow-wrap:normal;");
        ui_set_text(engine, child, "abcdefghijklmnopqrstuvwx");
        ui_append_child(engine, panel, child);
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* text = dynamic_cast<Rml::ElementText*>(runtime.projected_elements.at(child.value).element->GetChild(0));
        assert(text);
        const auto lines = [&]() {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
            std::string joined;
            for (const auto& line : text->GetLines()) joined += line.text;
            assert(joined == "abcdefghijklmnopqrstuvwx");
            return text->GetLines().size();
        };
        assert(lines() == 1);
        ui_set_style_property(engine, panel, "overflow-wrap", "anywhere");
        const auto wrapped = lines();
        assert(wrapped > 1);
        ui_set_style_property(engine, child, "overflow-wrap", "normal");
        assert(lines() == 1);
        ui_set_style_property(engine, child, "overflow-wrap", "break-word");
        assert(lines() == wrapped);
        ui_set_style_property(engine, panel, "white-space", "nowrap");
        assert(lines() == 1);
        ui_set_style_property(engine, panel, "white-space", "normal");
        ui_set_style_property(engine, child, "word-break", "break-all");
        ui_set_style_property(engine, child, "overflow-wrap", "normal");
        assert(lines() > 1);
        ui_set_style_property(engine, child, "word-break", "normal");
        assert(lines() == 1);
        ui_set_style_property(engine, child, "overflow-wrap", "anywhere");
        ui_set_style_property(engine, panel, "width", "128px");
        assert(lines() < wrapped && lines() > 1);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
