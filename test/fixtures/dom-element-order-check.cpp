#define main generated_main
#include "../../artifacts/dom-element-order/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>
#include <cmath>

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
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    loop.run([&] { initialize(realm); });
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    assert(SDL_Init(SDL_INIT_VIDEO));
    SDL_Window* window = SDL_CreateWindow("DOM element order fixture", 640, 480, SDL_WINDOW_HIDDEN);
    assert(window);
    {
        auto& engine = pal::window_document_engine();
        assert(generated_main() == 0);
        const auto log = ui_get_element_by_id(engine, "log");
        // Each insertion, refusal, tabIndex and scroll-option outcome, in program order.
        assert(ui_element(engine, log).text == "RANSHDWQOT");
        std::string order;
        for (const auto child : ui_element(engine, ui_get_element_by_id(engine, "list")).children)
            order += ui_get_attribute(engine, child, "id") + ";";
        assert(order == "f;d;a;e;c;x;kept;g;");
        const auto first = ui_get_element_by_id(engine, "first");
        const auto panel = ui_get_element_by_id(engine, "panel");
        const auto skipped = ui_get_element_by_id(engine, "skipped");
        const auto last = ui_get_element_by_id(engine, "last");
        assert(ui_get_attribute(engine, panel, "tabindex") == "0");
        assert(ui_tab_index(engine, skipped) == -1 && ui_tab_index(engine, first) == 0);
        assert(ui_active_element(engine) == first);

        pal::UiRmlRuntime runtime(engine, window, 640, 480);
        pal::update_ui_rml_runtime(runtime, 640, 480);
        const auto rml = [&](UiElementHandle element) {
            auto* projected = runtime.projected_elements.at(element.value).element;
            assert(projected);
            return projected;
        };
        // A negative tabindex leaves Tab navigation; zero joins it.
        assert(rml(panel)->GetComputedValues().tab_index() == Rml::Style::TabIndex::Auto);
        assert(rml(skipped)->GetComputedValues().tab_index() == Rml::Style::TabIndex::None);
        // The later request on the same container wins: row3's bottom edge ends the box.
        const auto scroller = ui_get_element_by_id(engine, "scroller");
        assert(std::abs(rml(scroller)->GetScrollTop() - 80.0f) < 0.5f);
        assert(!ui_element(engine, ui_get_element_by_id(engine, "row2")).scroll_into_view->smooth);
        const auto scroll = [&](const char* id, std::string_view block) {
            ui_scroll_into_view(engine, ui_get_element_by_id(engine, id), block, "nearest",
                                "instant");
            pal::update_ui_rml_runtime(runtime, 640, 480);
            return rml(scroller)->GetScrollTop();
        };
        assert(std::abs(scroll("row1", "start") - 30.0f) < 0.5f);
        assert(std::abs(scroll("row2", "center") - 55.0f) < 0.5f);
        assert(std::abs(scroll("row4", "nearest") - 110.0f) < 0.5f);
        assert(std::abs(scroll("row4", "nearest") - 110.0f) < 0.5f);
        // The client rectangle reports the scrolled box.
        assert(std::abs(ui_element(engine, ui_get_element_by_id(engine, "row4")).client_rect.top -
                        10.0) < 0.5);

        const auto send = [&](SDL_Event event) {
            const auto batch = pal::prepare_dom_platform_input(engine, event);
            assert(batch);
            dispatch_dom_batch(engine, batch);
            assert(batch->ready());
            if (!batch->default_prevented)
                static_cast<void>(pal::handle_ui_rml_event(runtime, event));
            pal::update_ui_rml_runtime(runtime, 640, 480);
        };
        const auto tab = [&] {
            SDL_Event key{};
            key.type = SDL_EVENT_KEY_DOWN;
            key.key.windowID = SDL_GetWindowID(window);
            key.key.scancode = SDL_SCANCODE_TAB;
            key.key.key = SDLK_TAB;
            key.key.down = true;
            send(key);
            key.type = SDL_EVENT_KEY_UP;
            key.key.down = false;
            send(key);
        };
        // The capture listener sees each keydown's composed path from the focused element.
        tab();
        assert(ui_active_element(engine) == panel);
        tab();
        assert(ui_active_element(engine) == last);
        tab();
        assert(ui_active_element(engine) == first);
        assert(ui_element(engine, log).text == "RANSHDWQOTpPp");
    }
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
