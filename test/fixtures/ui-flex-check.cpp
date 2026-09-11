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
    SDL_Window* window = SDL_CreateWindow("UI flex fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "style", "display:flex;width:220px;height:120px;flex-flow:wrap row;align-content:start;align-items:start;column-gap:10px;row-gap:8px;");
        std::vector<UiElementHandle> children;
        for (int i = 0; i < 3; ++i) {
            const auto child = ui_create_element(engine, "div");
            ui_set_attribute(engine, child, "style", "flex:0 0 100px;height:20px;");
            ui_append_child(engine, panel, child);
            children.push_back(child);
        }
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        const auto update = [&]() { pal::update_ui_rml_runtime(runtime, 640, 480); };
        const auto element = [&](UiElementHandle handle) { return runtime.projected_elements.at(handle.value).element; };
        const auto box = [&](size_t index, float x, float y, float width, float height) {
            update();
            auto* child = element(children.at(index));
            const auto offset = child->GetAbsoluteOffset(Rml::BoxArea::Border) - element(panel)->GetAbsoluteOffset(Rml::BoxArea::Content);
            const auto size = child->GetBox().GetSize(Rml::BoxArea::Border);
            if (std::abs(offset.x - x) >= .1f || std::abs(offset.y - y) >= .1f ||
                std::abs(size.x - width) >= .1f || std::abs(size.y - height) >= .1f)
                std::fprintf(stderr, "Flex child %zu: actual %.2f %.2f %.2f %.2f; expected %.2f %.2f %.2f %.2f\n",
                    index, offset.x, offset.y, size.x, size.y, x, y, width, height);
            assert(std::abs(offset.x - x) < .1f && std::abs(offset.y - y) < .1f);
            assert(std::abs(size.x - width) < .1f && std::abs(size.y - height) < .1f);
        };
        box(0, 0, 0, 100, 20);
        box(1, 110, 0, 100, 20);
        box(2, 0, 28, 100, 20);
        ui_set_style_property(engine, panel, "width", "330px");
        box(2, 220, 0, 100, 20);
        ui_set_style_property(engine, panel, "width", "220px");
        ui_set_style_property(engine, panel, "flex-flow", "wrap-reverse row");
        box(2, 0, 0, 100, 20);
        box(0, 0, 28, 100, 20);
        ui_set_style_property(engine, panel, "align-content", "end");
        box(2, 0, 72, 100, 20);
        box(0, 0, 100, 100, 20);
        ui_set_style_property(engine, panel, "flex-flow", "row");
        update();
        assert(element(panel)->GetComputedValues().flex_wrap() == Rml::Style::FlexWrap::Nowrap);
        ui_set_style_property(engine, panel, "flex-flow", "wrap");
        update();
        assert(element(panel)->GetComputedValues().flex_direction() == Rml::Style::FlexDirection::Row);

        // A new declaration list resets the inline layout in authored order.
        ui_set_attribute(engine, panel, "style", "display:flex;width:220px;height:100px;align-items:start;column-gap:10px;");
        ui_set_style_property(engine, panel, "flex-flow", "row-reverse nowrap");
        ui_set_style_property(engine, panel, "justify-content", "start");
        ui_set_style_property(engine, children[2], "display", "none");
        box(0, 110, 0, 100, 20);
        box(1, 0, 0, 100, 20);
        ui_set_style_property(engine, panel, "justify-content", "end");
        box(0, 120, 0, 100, 20);
        ui_set_style_property(engine, panel, "flex-flow", "row wrap-reverse");
        ui_set_style_property(engine, panel, "align-content", "end");
        ui_set_style_property(engine, children[0], "height", "40px");
        ui_set_style_property(engine, children[1], "align-self", "start");
        box(1, 120, 60, 100, 20);
        ui_set_style_property(engine, children[1], "align-self", "end");
        box(1, 120, 80, 100, 20);

        ui_set_style_property(engine, children[0], "flex", "1");
        update();
        const auto* basis = element(children[0])->GetProperty(Rml::PropertyId::FlexBasis);
        assert(basis->unit == Rml::Unit::PERCENT && basis->Get<float>() == 0.f);
        ui_set_style_property(engine, children[0], "flex", "none");
        update();
        assert(element(children[0])->GetComputedValues().flex_grow() == 0.f);
        assert(element(children[0])->GetComputedValues().flex_shrink() == 0.f);
        ui_set_style_property(engine, children[0], "flex", "initial");
        update();
        assert(element(children[0])->GetComputedValues().flex_shrink() == 1.f);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
