#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("Physical floats fixture", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto make = [&](const char* style) {
            const auto element = ui_create_element(engine, "div");
            ui_set_attribute(engine, element, "style", style);
            return element;
        };
        const auto parent =
            make("position:absolute;left:10px;top:10px;width:200px;display:flow-root;");
        const auto left = make("float:left;width:50px;height:40px;");
        const auto right = make("float:right;width:60px;height:60px;");
        const auto cleared = make("clear:left;width:20px;height:10px;");
        ui_append_child(engine, parent, left);
        ui_append_child(engine, parent, right);
        ui_append_child(engine, parent, cleared);
        ui_append_to_root(engine, parent);
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        const auto update = [&] { pal::update_ui_rml_runtime(runtime, 320, 240); };
        const auto raw = [&](UiElementHandle element) {
            return runtime.projected_elements.at(element.value).element;
        };
        const auto offset = [&](UiElementHandle element) {
            return raw(element)->GetAbsoluteOffset(Rml::BoxArea::Border) -
                   raw(parent)->GetAbsoluteOffset(Rml::BoxArea::Content);
        };
        const auto expect_near = [](float actual, float expected) {
            if (std::abs(actual - expected) > .1f) {
                std::fprintf(stderr, "Float layout %.3f != %.3f\n", actual, expected);
                std::abort();
            }
        };
        update();
        expect_near(offset(left).x, 0);
        expect_near(offset(right).x, 140);
        expect_near(offset(cleared).y, 40);
        ui_set_style_property(engine, cleared, "clear", "both");
        update();
        expect_near(offset(cleared).y, 60);
        assert(ui_get_style_property(engine, cleared, "clear") == "both");
        ui_set_style_property(engine, cleared, "clear", "right");
        update();
        expect_near(offset(cleared).y, 60);
        ui_set_style_property(engine, cleared, "clear", "none");
        update();
        expect_near(offset(cleared).y, 0);
        ui_set_style_property(engine, left, "float", "right");
        update();
        expect_near(offset(left).x, 150);
        expect_near(offset(right).x, 90);
        assert(ui_get_style_property(engine, left, "float") == "right");
        assert(ui_remove_style_property(engine, left, "float") == "right");
        update();
        assert(raw(left)->GetComputedValues().float_() == Rml::Style::Float::None);
        assert(ui_get_style_property(engine, left, "float").empty());
        ui_set_style_property(engine, left, "float", "left");
        ui_remove_style_property(engine, cleared, "clear");
        update();
        expect_near(offset(left).x, 0);
        expect_near(offset(cleared).y, 0);
        ui_set_attribute(engine, cleared, "style", "clear:both;width:20px;height:10px;");
        update();
        expect_near(offset(cleared).y, 60);
        for (const auto* property : {"float", "clear"}) {
            ui_set_style_property(engine, left, property, "inline-start");
            bool refused = false;
            try {
                update();
            } catch (const std::runtime_error& error) {
                refused =
                    std::string(error.what()).find("Unsupported retained UI") != std::string::npos;
            }
            assert(refused);
            ui_set_style_property(engine, left, property, "none");
            update();
        }
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
