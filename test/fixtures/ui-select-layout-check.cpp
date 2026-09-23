#include "pal_ui_rml.cpp"
#include <cassert>

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int main() try {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    auto* window = SDL_CreateWindow("Select layout", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto select = ui_create_element(engine, "select");
        ui_set_attribute(
            engine, select, "style",
            "position:absolute;left:20px;top:20px;padding:6px 9px;border:1px #ffffff;border-radius:7px;color:#ffffff;background-color:#14344e;");
        std::vector<UiElementHandle> options;
        for (const char* value : {"256", "128", "64", "32"}) {
            auto option = ui_create_element(engine, "option");
            ui_set_text(engine, option, value);
            ui_set_form_value(engine, option, value);
            ui_append_child(engine, select, option);
            options.push_back(option);
        }
        std::string events;
        ui_on_event(engine, select, "input", [&](const PlatformMouseEvent&) {
            events += "input:" + ui_get_form_value(engine, select) + ";";
        });
        ui_on_event(engine, select, "change", [&](const PlatformMouseEvent&) {
            events += "change:" + ui_get_form_value(engine, select) + ";";
        });
        ui_append_to_root(engine, select);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = rmlui_dynamic_cast<Rml::ElementFormControlSelect*>(
            runtime.projected_elements.at(select.value).element);
        const auto render = [&] {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
        };
        render();
        const auto size = raw->GetBox().GetSize(Rml::BoxArea::Border);
        if (size.x < 62 || size.x > 64 || std::abs(size.y - 31) > .1f) {
            std::fprintf(stderr, "Select border box: %.3f x %.3f\n", size.x, size.y);
            throw std::runtime_error("Select did not use option-derived dimensions");
        }
        auto* arrow = raw->GetChild(0);
        auto* value = raw->GetChild(1);
        assert(arrow->GetTagName() == "selectarrow" && value->GetTagName() == "selectvalue");
        const auto arrow_position = arrow->GetAbsoluteOffset(Rml::BoxArea::Border);
        const auto arrow_size = arrow->GetBox().GetSize(Rml::BoxArea::Border);
        assert(std::abs(arrow_position.y + arrow_size.y * .5f - 20 - size.y * .5f) < .1f);
        assert(value->GetAbsoluteOffset().x + value->GetBox().GetSize().x <= arrow_position.x);
        const auto click = [&](float x, float y) {
            runtime.context->ProcessMouseMove(static_cast<int>(x), static_cast<int>(y), 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
            render();
        };
        click(arrow_position.x + arrow_size.x * .5f, arrow_position.y + arrow_size.y * .5f);
        assert(raw->IsSelectBoxVisible());
        auto* option = raw->GetOption(2);
        const auto option_position = option->GetAbsoluteOffset(Rml::BoxArea::Border);
        const auto option_size = option->GetBox().GetSize(Rml::BoxArea::Border);
        click(option_position.x + 5, option_position.y + option_size.y * .5f);
        assert(!raw->IsSelectBoxVisible());
        assert(ui_get_form_value(engine, select) == "64" && events == "input:64;change:64;");
        ui_set_text(engine, options[0], "A much longer option");
        render();
        assert(raw->GetBox().GetSize(Rml::BoxArea::Border).x > size.x + 60);
        ui_set_style_property(engine, select, "width", "80px");
        render();
        assert(std::abs(raw->GetBox().GetSize(Rml::BoxArea::Border).x - 80) < .1f);
        assert(runtime.projected_elements.at(select.value).element == raw);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Select layout fixture: %s\n", error.what());
    return 1;
}
