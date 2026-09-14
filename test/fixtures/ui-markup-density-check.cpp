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
    auto* window = SDL_CreateWindow("Markup density", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto cross = ui_create_element(engine, "div");
        ui_set_attribute(engine, cross, "style", "position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px");
        ui_set_inner_rml(engine, cross, "<div style=\"position:absolute;left:10px;top:10px;width:2px;height:2px\"></div><div style=\"position:absolute;right:0;top:10px;width:8px;height:2px\"></div>");
        ui_append_to_root(engine, cross);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* parent = runtime.projected_elements.at(cross.value).element;
        const auto expectNear = [](float actual, float expected) { assert(std::abs(actual - expected) < .1f); };
        for (const float density : {1.f, 2.f, 3.f}) {
            engine.options.width = 640; engine.options.height = 480;
            engine.canvas_client_width = 640 / density; engine.canvas_client_height = 480 / density;
            runtime.context->SetDensityIndependentPixelRatio(density);
            runtime.context->Update();
            runtime.sync_client_rects(true);
            const auto rect = ui_get_client_rect(engine, cross);
            expectNear(static_cast<float>(rect.width), 22);
            expectNear(static_cast<float>(rect.left + rect.width / 2), 320 / density);
            auto* dot = parent->GetChild(0);
            const auto position = dot->GetAbsoluteOffset(Rml::BoxArea::Border);
            expectNear(dot->GetBox().GetSize().x, 2 * density);
            expectNear(dot->GetBox().GetSize().y, 2 * density);
            expectNear(position.x + density, 320);
            expectNear(position.y + density, 240);
            expectNear(parent->GetChild(1)->GetBox().GetSize().x, 8 * density);
        }
        ui_set_inner_rml(engine, cross, "<div style=\"width:4px;height:6px\"></div>");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        expectNear(parent->GetChild(0)->GetBox().GetSize().x, 12);
        expectNear(parent->GetChild(0)->GetBox().GetSize().y, 18);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
