#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    const auto expect_near = [](float actual, float expected) {
        if (std::abs(actual - expected) > .1f) {
            std::fprintf(stderr, "Viewport layout %.3f expected %.3f\n", actual, expected);
            throw std::runtime_error("Viewport layout mismatch");
        }
    };
    assert(pal::rml_css_length_math("width:min(310px,calc(100vw - 36px));height:calc(100vh - 36px)",
                                    1280, 720) == "width:310.000000px;height:684.000000px");
    assert(pal::rml_css_length_math("width:clamp(20px,calc(25vw * 2),500px)", 800, 600) ==
           "width:400.000000px");
    // A percentage of a layout length folds to RmlUi's canonical form, with lengths added and
    // min()/max()/clamp() bounds of the same form.
    assert(pal::rml_css_length_math("width:calc(100% - 20px)", 800, 600) ==
           "width:bbl-calc(100.000000 -20.000000)");
    assert(pal::rml_css_length_math("max-width:min(260px,100%)", 800, 600) ==
           "max-width:bbl-calc(100.000000 0.000000 upper 0.000000 260.000000)");
    assert(pal::rml_css_length_math("top:calc(2 * (25% + 1.5px) + 1vw)", 800, 600) ==
           "top:bbl-calc(50.000000 11.000000)");
    assert(pal::rml_css_length_math("width:clamp(10px,50%,calc(100% - 4px))", 800, 600) ==
           "width:bbl-calc(50.000000 0.000000 lower 0.000000 10.000000 upper 100.000000 "
           "-4.000000)");
    assert(pal::rml_css_length_math("left:calc(-1 * min(50%, 20px))", 800, 600) ==
           "left:bbl-calc(-50.000000 -0.000000 lower -0.000000 -20.000000)");
    // Bare viewport extremes resolve here (RmlUi has no vmin/vmax); vw/vh stay native.
    assert(pal::rml_css_length_math("box-shadow:0 0 0 160vmax red", 1280, 720) ==
           "box-shadow:0 0 0 2048.000000px red");
    assert(pal::rml_css_length_math("width:10VMIN;margin:-2svmin 10vw", 1280, 720) ==
           "width:72.000000px;margin:-14.400000px 10vw");
    assert(pal::rml_css_length_math("animation-name:a1vmin;--n2vmax:0", 1280, 720) ==
           "animation-name:a1vmin;--n2vmax:0");
    // A custom property's percentage is one of the length its substitution lands in.
    assert(pal::rml_css_length_math("--inset:calc(100% - 4px)", 800, 600) ==
           "--inset:calc(100% - 4px)");
    for (const char* style :
         {"transform-origin:calc(100% - 30px) 0", "width:min(10px,50%,calc(100% - 4px))",
          "width:max(1px,min(50%,20px))", "width:calc(50% * 50%)"}) {
        bool refused = false;
        try {
            static_cast<void>(pal::rml_css_length_math(style, 800, 600));
        } catch (const std::runtime_error&) {
            refused = true;
        }
        assert(refused);
    }
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Viewport math", 1280, 720, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        auto panel = ui_create_element(engine, "div");
        ui_set_attribute(engine, panel, "class", "panel");
        const auto sheet = ui_create_element(engine, "style");
        ui_add_class_style(
            engine, sheet, "panel",
            "position:absolute;top:18px;right:18px;width:min(310px,calc(100vw - 36px));max-height:calc(100vh - 36px);padding:14px;border:1px solid #ffffff;overflow-y:auto;pointer-events:auto;");
        ui_append_to_root(engine, sheet);
        const auto content = ui_create_element(engine, "div");
        ui_set_attribute(engine, content, "style", "height:2000px;");
        ui_append_child(engine, panel, content);
        ui_append_to_root(engine, panel);
        // Percentages of the containing block inside CSS math, resolved at layout.
        const auto box = ui_create_element(engine, "div");
        ui_set_attribute(engine, box, "style",
                         "position:absolute;left:0;top:0;width:400px;height:100px;");
        const auto fill = ui_create_element(engine, "div");
        ui_set_attribute(engine, fill, "style", "height:10px;width:calc(100% - 20px);");
        const auto capped = ui_create_element(engine, "div");
        ui_set_attribute(engine, capped, "class", "capped");
        ui_add_class_style(engine, sheet, "capped", "height:10px;width:min(260px,100%);");
        const auto centred = ui_create_element(engine, "div");
        ui_set_attribute(engine, centred, "style",
                         "position:absolute;top:0;width:64px;height:10px;left:calc(50% - 32px);");
        for (const auto child : {fill, capped, centred})
            ui_append_child(engine, box, child);
        ui_append_to_root(engine, box);
        pal::UiRmlRuntime runtime(engine, window, 1280, 720);
        const auto width_of = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value)
                .element->GetBox()
                .GetSize(Rml::BoxArea::Border)
                .x;
        };
        const auto left_of = [&](UiElementHandle handle) {
            return runtime.projected_elements.at(handle.value)
                .element->GetAbsoluteOffset(Rml::BoxArea::Border)
                .x;
        };
        expect_near(width_of(fill), 380);
        expect_near(width_of(capped), 260);
        expect_near(left_of(centred) - left_of(box), 168);
        ui_set_style_property(engine, box, "width", "200px");
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        expect_near(width_of(fill), 180);
        expect_near(width_of(capped), 200);
        expect_near(left_of(centred) - left_of(box), 68);
        auto* raw = runtime.projected_elements.at(panel.value).element;
        auto* child = runtime.projected_elements.at(content.value).element;
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).x, 340);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).y, 714);
        expect_near(raw->GetAbsoluteOffset(Rml::BoxArea::Border).x, 922);
        const auto* scrollbar = raw->GetElementScroll()->GetScrollbar(Rml::ElementScroll::VERTICAL);
        assert(scrollbar && scrollbar->IsVisible());
        expect_near(child->GetBox().GetSize().x, 295);
        runtime.context->SetDefaultScrollBehavior(Rml::ScrollBehavior::Instant, 1);
        runtime.context->ProcessMouseMove(950, 100, 0);
        runtime.context->ProcessMouseWheel({0, 1}, 0);
        assert(raw->GetScrollTop() > 0);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).x, 314);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).y, 234);
        expect_near(raw->GetAbsoluteOffset(Rml::BoxArea::Border).x, -12);
        ui_set_style_property(engine, panel, "width", "min(600px,calc(50vw - 16px))");
        pal::update_ui_rml_runtime(runtime, 320, 240);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).x, 174);
        pal::update_ui_rml_runtime(runtime, 800, 600);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).x, 414);
        ui_remove_style_property(engine, panel, "width");
        pal::update_ui_rml_runtime(runtime, 1280, 720);
        expect_near(raw->GetBox().GetSize(Rml::BoxArea::Border).x, 340);
        assert(runtime.projected_elements.at(panel.value).element == raw);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Viewport math fixture: %s\n", error.what());
    return 1;
}
