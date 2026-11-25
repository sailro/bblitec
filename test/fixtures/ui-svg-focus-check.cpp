#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>

namespace bbl {
std::string asset_path(const std::string&) {
    throw std::runtime_error("Unexpected SVG focus asset read");
}
} // namespace bbl
namespace bbl::pal {
std::string asset_path(std::string_view) {
    throw std::runtime_error("Unexpected SVG focus asset read");
}
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
} // namespace bbl::pal

int run() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("SVG focus fixture", 320, 240, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        Engine engine;
        const auto button = [&](const char* text) {
            const auto element = ui_create_element(engine, "button");
            ui_set_text(engine, element, text);
            ui_append_to_root(engine, element);
            return element;
        };
        const auto before = button("Before");
        const auto svg = ui_create_svg_element(engine, "svg");
        for (const auto& [name, value] : std::array<std::pair<const char*, const char*>, 4>{
                 {{"viewBox", "0 0 100 100"},
                  {"width", "100"},
                  {"height", "100"},
                  {"style", "position:absolute;left:20px;top:60px;"}}})
            ui_set_attribute(engine, svg, name, value);
        const auto circle = [&](const char* x, const char* order) {
            const auto shape = ui_create_svg_element(engine, "circle");
            ui_set_attribute(engine, shape, "cx", x);
            ui_set_attribute(engine, shape, "cy", "50");
            ui_set_attribute(engine, shape, "r", "10");
            ui_set_attribute(engine, shape, "fill", "#00ff00");
            ui_set_attribute(engine, shape, "tabindex", order);
            ui_append_child(engine, svg, shape);
            return shape;
        };
        // A slider thumb: focusable, with its accessibility attributes, which draw nothing.
        const auto first = circle("25", "0");
        for (const auto& [name, value] :
             std::array<std::pair<const char*, const char*>, 6>{{{"class", "thumb"},
                                                                 {"role", "slider"},
                                                                 {"aria-label", "First"},
                                                                 {"aria-valuemin", "0"},
                                                                 {"aria-valuemax", "1"},
                                                                 {"aria-valuenow", "0.5"}}})
            ui_set_attribute(engine, first, name, value);
        const auto skipped = circle("50", "-1");
        const auto second = circle("75", "0");
        ui_append_to_root(engine, svg);
        const auto after = button("After");
        const auto sheet = ui_create_element(engine, "style");
        ui_add_style_rule(engine, sheet,
                          {.selector = UiStyleSelectorKind::Class,
                           .primary = "thumb",
                           .style = "stroke:#ff0000;",
                           .focus_visible = true});
        ui_append_to_root(engine, sheet);
        std::vector<std::string> log;
        std::size_t identity = 10;
        for (const auto& [shape, name] : std::array<std::pair<UiElementHandle, const char*>, 3>{
                 {{first, "first"}, {skipped, "skipped"}, {second, "second"}}})
            for (const char* type : {"focus", "blur"})
                on_dom_pointer(engine, DomEventTarget::node(shape.value), type, identity++,
                               [&log, name, type](const PlatformMouseEvent&) {
                                   log.push_back(std::string(type) + " " + name);
                               });
        int first_keys = 0;
        on_dom_keyboard(engine, DomEventTarget::node(first.value), "keydown", 1,
                        [&](const PlatformKeyboardEvent&) { ++first_keys; });
        on_dom_pointer(engine, DomEventTarget::node(skipped.value), "pointerdown", 2,
                       [](const PlatformMouseEvent&) {});
        pal::UiRmlRuntime runtime(engine, window, 320, 240);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        const auto send = [&](SDL_Event event) {
            static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 320, 240);
        };
        const auto tab = [&](bool back = false) {
            SDL_Event event{};
            event.type = SDL_EVENT_KEY_DOWN;
            event.key.which = ~0u;
            event.key.key = SDLK_TAB;
            event.key.mod = back ? SDL_KMOD_SHIFT : SDL_KMOD_NONE;
            send(event);
            event.type = SDL_EVENT_KEY_UP;
            send(event);
        };
        auto* root = runtime.projected_elements.at(svg.value).element;
        const auto expect = [&](UiElementHandle element, const char* step) {
            if (ui_active_element(engine) != element)
                throw std::runtime_error(std::string("SVG focus after ") + step + ": " +
                                         std::to_string(ui_active_element(engine).value) +
                                         " before=" + std::to_string(before.value) +
                                         " svg=" + std::to_string(svg.value) +
                                         " after=" + std::to_string(after.value) +
                                         " second=" + std::to_string(second.value));
        };
        // Tab visits the shapes whose tabindex is 0 in tree order, held by the root's element.
        ui_focus(engine, before, true);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        tab();
        expect(first, "Tab into the root");
        assert(runtime.context->GetFocusElement() == root);
        assert(!root->IsPseudoClassSet("focus") && !root->IsPseudoClassSet("focus-visible"));
        if (runtime.projected_elements.at(svg.value).svg_markup.find("stroke=\"#ff0000\"") ==
            std::string::npos)
            throw std::runtime_error("A focus-visible rule draws the focused shape: " +
                                     runtime.projected_elements.at(svg.value).svg_markup);
        // Keys reach the focused shape.
        SDL_Event arrow{};
        arrow.type = SDL_EVENT_KEY_DOWN;
        arrow.key.scancode = SDL_SCANCODE_RIGHT;
        arrow.key.key = SDLK_RIGHT;
        dispatch_dom_batch(engine, pal::prepare_dom_platform_input(engine, arrow));
        assert(first_keys == 1);
        tab();
        expect(second, "Tab within the root");
        assert(runtime.projected_elements.at(svg.value).svg_markup.find("stroke=\"#ff0000\"") ==
               std::string::npos);
        dispatch_dom_batch(engine, pal::prepare_dom_platform_input(engine, arrow));
        assert(first_keys == 1);
        tab();
        expect(after, "Tab out of the root");
        // Shift+Tab enters at the last stop and walks back.
        tab(true);
        expect(second, "Shift+Tab into the root");
        tab(true);
        expect(first, "Shift+Tab within the root");
        tab(true);
        expect(before, "Shift+Tab out of the root");
        const std::vector<std::string> order{"focus first", "blur first",   "focus second",
                                             "blur second", "focus second", "blur second",
                                             "focus first", "blur first"};
        if (log != order)
            throw std::runtime_error("SVG focus events out of order");
        // A press focuses the shape under it; a source focus reaches a negative tabindex.
        log.clear();
        SDL_Event press{};
        press.type = SDL_EVENT_MOUSE_MOTION;
        press.motion.x = 70;
        press.motion.y = 110;
        send(press);
        press = {};
        press.type = SDL_EVENT_MOUSE_BUTTON_DOWN;
        press.button.button = SDL_BUTTON_LEFT;
        press.button.x = 70;
        press.button.y = 110;
        send(press);
        press.type = SDL_EVENT_MOUSE_BUTTON_UP;
        send(press);
        expect(skipped, "a press on a focusable shape");
        ui_focus(engine, second, false);
        pal::update_ui_rml_runtime(runtime, 320, 240);
        expect(second, "a source focus");
        assert(runtime.context->GetFocusElement() == root);
        assert((log == std::vector<std::string>{"focus skipped", "blur skipped", "focus second"}));
        assert(ui_tab_index(engine, first) == 0 && ui_tab_index(engine, skipped) == -1);
        // Sequential navigation follows tree order only.
        bool refused = false;
        try {
            ui_set_attribute(engine, first, "tabindex", "2");
        } catch (...) {
            refused = true;
        }
        assert(refused && ui_tab_index(engine, first) == 0);
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}

int main() {
    try {
        return run();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
