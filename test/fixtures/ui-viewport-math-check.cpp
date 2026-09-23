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
    bool refused = false;
    try {
        static_cast<void>(pal::rml_css_length_math("width:calc(100% - 20px)", 800, 600));
    } catch (const std::runtime_error&) {
        refused = true;
    }
    assert(refused);
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
            "position:absolute;top:18px;right:18px;width:min(310px,calc(100vw - 36px));max-height:calc(100vh - 36px);padding:14px;border:1px #ffffff;overflow-y:auto;pointer-events:auto;");
        ui_append_to_root(engine, sheet);
        const auto content = ui_create_element(engine, "div");
        ui_set_attribute(engine, content, "style", "height:2000px;");
        ui_append_child(engine, panel, content);
        ui_append_to_root(engine, panel);
        pal::UiRmlRuntime runtime(engine, window, 1280, 720);
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
