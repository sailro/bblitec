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
    SDL_Window* window = SDL_CreateWindow("UI checkbox fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        int clicks = 0;
        bool prevent_activation = false;
        on_dom_pointer(engine, DomEventTarget::document(), "click", 1,
                       [&](const PlatformMouseEvent& event) {
                           ++clicks;
                           if (prevent_activation)
                               event.prevent_default();
                       });
        const auto input = ui_create_element(engine, "input");
        ui_set_attribute(engine, input, "type", "checkbox");
        ui_set_attribute(engine, input, "style",
                         "position:absolute;left:20px;top:20px;width:30px;height:30px;margin:0;");
        ui_set_attribute(engine, input, "checked", "");
        assert(ui_get_checked(engine, input));
        ui_set_checked(engine, input, false);
        assert(ui_has_attribute(engine, input, "checked") && !ui_get_checked(engine, input));
        std::string events;
        ui_on_event(engine, input, "change", [&](const PlatformMouseEvent&) {
            events += ui_get_checked(engine, input) ? "change:true;" : "change:false;";
        });
        ui_on_event(engine, input, "input", [&](const PlatformMouseEvent&) {
            events += ui_get_checked(engine, input) ? "input:true;" : "input:false;";
        });
        ui_append_to_root(engine, input);
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        auto* raw = runtime.projected_elements.at(input.value).element;
        assert(!raw->HasAttribute("checked") && events.empty());
        const auto click = [&] {
            runtime.context->ProcessMouseMove(30, 30, 0);
            runtime.context->ProcessMouseButtonDown(0, 0);
            runtime.context->ProcessMouseButtonUp(0, 0);
        };
        click();
        assert(clicks == 1);
        assert(events == "input:true;change:true;");
        prevent_activation = true;
        click();
        assert(clicks == 2 && ui_get_checked(engine, input));
        assert(events == "input:true;change:true;");
        prevent_activation = false;
        assert(ui_get_checked(engine, input));
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(raw->HasAttribute("checked"));
        assert(events == "input:true;change:true;");
        ui_set_checked(engine, input, false);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        assert(!raw->HasAttribute("checked"));
        assert(events == "input:true;change:true;");
        ui_set_boolean_attribute(engine, input, "disabled", true);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        click();
        assert(!ui_get_checked(engine, input));
        ui_set_boolean_attribute(engine, input, "disabled", false);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        click();
        click();
        assert(events == "input:true;change:true;input:true;change:true;input:false;change:false;");
        // An edit remains observable through a later property read even when
        // no source listener was attached at the time of activation.
        ui_element(engine, input).event_callbacks.clear();
        click();
        assert(ui_get_checked(engine, input));
        assert(ui_has_attribute(engine, input, "checked"));
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
}
