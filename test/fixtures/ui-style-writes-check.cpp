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
    SDL_Window* window = SDL_CreateWindow("UI style writes fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        const std::string authored = "display:block;width:100px;padding:1px 2px 3px 4px;overflow-wrap:anywhere;";
        ui_set_attribute(engine, panel, "style", authored);
        ui_set_style_property(engine, panel, "padding-left", "10px");
        ui_set_style_property(engine, panel, "padding", "20px");
        ui_set_style_property(engine, panel, "padding-right", "30px");
        const auto child = ui_create_element(engine, "div");
        ui_set_attribute(engine, child, "style", "overflow-wrap:normal;filter:brightness(0.5);");
        ui_append_child(engine, panel, child);
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(panel.value).element;
        auto* child_raw = runtime.projected_elements.at(child.value).element;
        const auto update = [&]() { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto padding = [&](float top, float right, float bottom, float left) {
            update();
            for (const auto& [id, expected] : {
                std::pair{Rml::PropertyId::PaddingTop, top}, {Rml::PropertyId::PaddingRight, right},
                {Rml::PropertyId::PaddingBottom, bottom}, {Rml::PropertyId::PaddingLeft, left}})
                assert(std::abs(raw->GetProperty(id)->Get<float>() - expected) < .01f);
        };
        padding(20, 30, 20, 20);
        ui_set_style_property(engine, panel, "padding-left", "15px");
        padding(20, 30, 20, 15);
        // Reassigning the same shorthand still replaces later longhands.
        ui_set_style_property(engine, panel, "padding", "20px");
        padding(20, 20, 20, 20);
        ui_set_style_property(engine, panel, "padding-left", "");
        padding(20, 20, 20, 0);
        assert(ui_get_style_property(engine, panel, "padding-left").empty());
        ui_set_style_property(engine, panel, "padding", "5px");
        padding(5, 5, 5, 5);
        ui_set_style_property(engine, panel, "padding", "");
        padding(0, 0, 0, 0);
        assert(raw->GetProperty(Rml::PropertyId::Width)->Get<float>() == 100.f);
        // Restoring identical cssText restores properties removed by live writes.
        ui_set_attribute(engine, panel, "style", authored);
        padding(1, 2, 3, 4);
        ui_set_style_property(engine, panel, "width", "250px");
        update();
        assert(raw->GetProperty(Rml::PropertyId::Width)->Get<float>() == 250.f);
        ui_set_attribute(engine, panel, "style", authored);
        update();
        assert(raw->GetProperty(Rml::PropertyId::Width)->Get<float>() == 100.f);
        ui_set_style_property(engine, panel, "width", "");
        update();
        assert(!raw->GetLocalStyleProperties().contains(Rml::PropertyId::Width));
        ui_set_style_property(engine, child, "overflow-wrap", "");
        ui_set_style_property(engine, child, "filter", "");
        update();
        assert(!child_raw->GetLocalStyleProperties().contains(Rml::PropertyId::OverflowWrap));
        assert(child_raw->GetProperty(Rml::PropertyId::OverflowWrap)->Get<int>() == 2);
        assert(!child_raw->GetLocalStyleProperties().contains(Rml::PropertyId::Filter));
        // Repeated writes retain bounded state instead of a growing event history.
        for (int i = 0; i < 50; ++i) {
            ui_set_style_property(engine, panel, "padding", "4px");
            ui_set_style_property(engine, panel, "padding-left", "2px");
        }
        padding(4, 4, 4, 2);
        assert(ui_element(engine, panel).style_property_order.size() == 3);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
