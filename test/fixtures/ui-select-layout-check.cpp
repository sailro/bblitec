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
        // Chromium centers the arrow on the rounded-down middle.
        assert(std::abs(arrow_position.y + arrow_size.y * .5f - 20 - std::floor(size.y * .5f)) <
               .1f);
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
    {
        // An open select's list is Chromium's top layer: a later panel with
        // the same z-index neither covers it nor takes the pointer over it,
        // and the panels' z-index reads as authored.
        Engine engine;
        const auto panel = [&](const char* style) {
            const auto element = ui_create_element(engine, "div");
            ui_set_attribute(engine, element, "style", style);
            ui_append_to_root(engine, element);
            return element;
        };
        const auto controls = panel("position:absolute;left:20px;top:20px;width:200px;height:60px;"
                                    "z-index:9000;overflow-y:auto;background-color:#202020;");
        const auto legend = panel("position:absolute;left:20px;top:84px;width:200px;height:200px;"
                                  "z-index:9000;background-color:#404040;pointer-events:auto;");
        const auto select = ui_create_element(engine, "select");
        ui_set_attribute(engine, select, "style", "display:block;width:180px;");
        for (const char* value : {"a", "b", "c", "d", "e", "f"}) {
            auto option = ui_create_element(engine, "option");
            ui_set_text(engine, option, value);
            ui_set_form_value(engine, option, value);
            ui_append_child(engine, select, option);
        }
        ui_append_child(engine, controls, select);
        static_cast<void>(ui_computed_style(engine, controls, "z-index"));
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = rmlui_dynamic_cast<Rml::ElementFormControlSelect*>(
            runtime.projected_elements.at(select.value).element);
        auto* legend_element = runtime.projected_elements.at(legend.value).element;
        const auto render = [&] {
            pal::update_ui_rml_runtime(runtime, 640, 480);
            static_cast<void>(pal::record_ui_rml_frame(runtime, 640, 480));
        };
        const auto click = [&](float x, float y) {
            runtime.context->ProcessMouseMove(static_cast<int>(x), static_cast<int>(y), 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
            render();
        };
        // The demo's change handler rewrites the legend, as its debug view does.
        ui_on_event(engine, select, "change", [&](const PlatformMouseEvent&) {
            ui_set_text(engine, legend, "legend for " + ui_get_form_value(engine, select));
        });
        render();
        const auto origin = raw->GetAbsoluteOffset(Rml::BoxArea::Border);
        const auto size = raw->GetBox().GetSize(Rml::BoxArea::Border);
        // A first selection rewrites the legend, then the list opens again.
        click(origin.x + size.x * .5f, origin.y + size.y * .5f);
        assert(raw->IsSelectBoxVisible());
        const auto second = raw->GetOption(1)->GetAbsoluteOffset(Rml::BoxArea::Border) +
                            raw->GetOption(1)->GetBox().GetSize(Rml::BoxArea::Border) * .5f;
        click(second.x, second.y);
        assert(!raw->IsSelectBoxVisible() && ui_get_form_value(engine, select) == "b");
        render();
        click(origin.x + size.x * .5f, origin.y + size.y * .5f);
        assert(raw->IsSelectBoxVisible());
        // The last option lies over the legend.
        auto* last = raw->GetOption(5);
        const auto at = last->GetAbsoluteOffset(Rml::BoxArea::Border) +
                        last->GetBox().GetSize(Rml::BoxArea::Border) * .5f;
        if (at.y <= 84)
            throw std::runtime_error("The fixture's last option does not reach the legend");
        const auto in_box = [&](Rml::Element* element) {
            for (; element; element = element->GetParentNode())
                if (element->GetTagName() == "selectbox")
                    return true;
            return false;
        };
        if (!in_box(runtime.context->GetElementAtPoint(at)))
            throw std::runtime_error("A later panel takes the pointer over an open select's list");
        assert(ui_computed_style(engine, controls, "z-index") == "9000");
        // The pointer crosses the options to the last, a frame per move, as a
        // user's does: each hover re-projects the tree.
        for (int index = 0; index <= 5; ++index) {
            const auto over = raw->GetOption(index)->GetAbsoluteOffset(Rml::BoxArea::Border) +
                              raw->GetOption(index)->GetBox().GetSize(Rml::BoxArea::Border) * .5f;
            runtime.context->ProcessMouseMove(static_cast<int>(over.x), static_cast<int>(over.y), 0);
            render();
            if (!in_box(runtime.context->GetElementAtPoint(at)))
                throw std::runtime_error("A hovered option hands the list to a later panel");
        }
        // A user's press lasts frames: the pressed option takes the focus
        // before the release selects it.
        runtime.context->ProcessMouseMove(static_cast<int>(at.x), static_cast<int>(at.y), 0);
        render();
        runtime.context->ProcessMouseButtonDown(0, 0);
        render();
        render();
        if (!in_box(runtime.context->GetElementAtPoint(at)))
            throw std::runtime_error("A pressed option hands the list to a later panel");
        runtime.context->ProcessMouseButtonUp(0, 0);
        render();
        assert(!raw->IsSelectBoxVisible() && ui_get_form_value(engine, select) == "f");
        if (auto* hit = runtime.context->GetElementAtPoint(at); hit != legend_element) {
            std::fprintf(stderr, "closed hit: %s\n", hit ? hit->GetAddress().c_str() : "none");
            throw std::runtime_error("A closed select's list keeps the pointer");
        }
        assert(ui_computed_style(engine, controls, "z-index") == "9000");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
} catch (const std::exception& error) {
    std::fprintf(stderr, "Select layout fixture: %s\n", error.what());
    return 1;
}
