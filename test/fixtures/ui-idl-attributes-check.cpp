#define main generated_main
#include "../../artifacts/ui-idl-attributes/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cstdio>

namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected fixture asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine document;
    return document;
}
} // namespace bbl::pal
#include "realm-application-fixture.hpp"

int main() try {
    using namespace bbl;
    const auto check = [](bool pass, const char* message) {
        if (!pass)
            throw std::runtime_error(message);
    };
    check(SDL_Init(SDL_INIT_VIDEO), "SDL initialization");
    SDL_Window* window = SDL_CreateWindow("UI IDL attributes fixture", 640, 480, SDL_WINDOW_HIDDEN);
    check(window != nullptr, "Window creation");
    {
        auto& engine = pal::window_document_engine();
        check(generated_main() == 0, "program");
        const auto& log = ui_element(engine, ui_get_element_by_id(engine, "log")).text;
        if (log != "123-1M5Name[a-z]+offinumericbdcCcheck")
            std::fprintf(stderr, "log: %s\n", log.c_str());
        check(log == "123-1M5Name[a-z]+offinumericbdcCcheck", "reflected reads");
        const auto link = ui_create_element(engine, "a");
        check(!ui_get_draggable(engine, link), "a link without href");
        ui_set_attribute(engine, link, "href", "#top");
        check(ui_get_draggable(engine, link), "a link with an href drags by default");
        const auto name = ui_get_element_by_id(engine, "name");
        const auto box = ui_get_element_by_id(engine, "box");
        const auto label = ui_get_element_by_id(engine, "label");
        const auto checkbox = ui_get_element_by_id(engine, "check");
        static_cast<void>(ui_get_client_rect(engine, label));
        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        auto* input = runtime.projected_elements.at(name.value).element;

        // The scroll writes applied at layout, clamped to the scroll range.
        auto* scroller = runtime.projected_elements.at(box.value).element;
        check(ui_scroll_offset(engine, box, false) == 50, "scrollTop");
        const double range = scroller->GetScrollWidth() - scroller->GetClientWidth();
        check(range > 0 && ui_scroll_offset(engine, box, true) == range, "clamped scrollLeft");

        // The placeholder shows in the empty control; maxlength limits typed text.
        check(input->IsPseudoClassSet("placeholder-shown"), "placeholder");
        input->Focus();
        runtime.context->ProcessTextInput("abcdefgh");
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(ui_get_form_value(engine, name) == "abcde", "maxlength");
        check(!input->IsPseudoClassSet("placeholder-shown"), "placeholder hidden by text");

        // inputmode and the inherited spellcheck select the platform text input.
        const auto properties = pal::ui_text_input_properties(*input);
        check(properties.type == SDL_TEXTINPUT_TYPE_NUMBER && !properties.autocorrect,
              "text input properties");

        // A label activates the control its htmlFor names.
        const auto& rect = ui_element(engine, label).client_rect;
        const float x = static_cast<float>(rect.left + rect.width / 2);
        const float y = static_cast<float>(rect.top + rect.height / 2);
        runtime.context->ProcessMouseMove(static_cast<int>(x), static_cast<int>(y), 0);
        runtime.context->ProcessMouseButtonDown(0, 0);
        runtime.context->ProcessMouseButtonUp(0, 0);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        check(ui_get_checked(engine, checkbox), "label activation");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
} catch (const std::exception& error) {
    std::fprintf(stderr, "UI IDL attributes failure: %s\n", error.what());
    return 1;
}
