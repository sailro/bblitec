#define main generated_main
#include "../../artifacts/dom-event-values/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include "pal_platform_events.hpp"
#include <cassert>

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
    std::exception_ptr failure;
    loop.on_error([&](std::exception_ptr error) {
        failure = error;
        loop.close();
    });
    loop.run([&] { initialize(realm); });
    if (failure)
        std::rethrow_exception(failure);
    return 0;
}
} // namespace bbl::pal

int main() {
    using namespace bbl;
    try {
        assert(SDL_Init(SDL_INIT_VIDEO));
        auto* window = SDL_CreateWindow("DOM event value fixture", 640, 480, SDL_WINDOW_HIDDEN);
        assert(window);
        {
            assert(generated_main() == 0);
            auto& engine = pal::window_document_engine();
            pal::UiRmlRuntime runtime(engine, window, 640, 480);
            pal::update_ui_rml_runtime(runtime, 640, 480);
            const auto physical = ui_get_element_by_id(engine, "physical");
            auto* control = rmlui_dynamic_cast<Rml::ElementFormControl*>(
                runtime.projected_elements.at(physical.value).element);
            assert(control);
            control->SetValue("native");
            control->DispatchEvent("change", {});
            assert(ui_get_attribute(engine, physical, "data-order") == "DIC");
            const auto moved = dom_event(PlatformMouseEvent{.client_x = 77, .pointer_id = 15},
                                         "pointermove", dom_ui_path(engine, physical));
            dispatch_dom_pointer(engine, moved);
            pal::EventLoop loop;
            std::exception_ptr failure;
            loop.on_error([&](std::exception_ptr error) {
                failure = error;
                loop.close();
            });
            loop.run([&] {
                dispatch_dom_pointer(engine, dom_event(PlatformMouseEvent{}, "pointerup",
                                                       dom_ui_path(engine, physical)));
                loop.close();
            });
            if (failure)
                std::rethrow_exception(failure);
            assert(ui_get_attribute(engine, physical, "data-retained") == "yes");
            std::optional<OwnedDomEvent> expired;
            {
                Engine temporary;
                on_dom_pointer(temporary, DomEventTarget::document(), "pointermove", 1,
                               [&](const PlatformMouseEvent& event) { expired.emplace(event); });
                dispatch_dom_pointer(temporary,
                                     dom_event(PlatformMouseEvent{.client_x = 42}, "pointermove",
                                               {DomEventTarget::document()}));
            }
            assert(expired->mouse().client_x == 42);
            bool owner_refused = false;
            try {
                static_cast<void>(expired->target());
            } catch (const std::logic_error&) {
                owner_refused = true;
            }
            assert(owner_refused);
            bool redispatch_refused = false;
            try {
                static_cast<void>(
                    dispatch_synthetic_event(engine, DomEventTarget::document(), *expired));
            } catch (const std::logic_error&) {
                redispatch_refused = true;
            }
            assert(redispatch_refused);
            bool empty_refused = false;
            try {
                static_cast<void>(
                    dispatch_synthetic_event(engine, DomEventTarget::document(), OwnedDomEvent{}));
            } catch (const std::logic_error&) {
                empty_refused = true;
            }
            assert(empty_refused);
            const auto empty = js::JsonValue::null_value();
            for (auto kind : {OwnedDomEvent::Kind::Event, OwnedDomEvent::Kind::Input}) {
                auto event = synthetic_event_from_options("input", kind, empty);
                bool refused = false;
                try {
                    static_cast<void>(event.borrowed_event().as<PlatformMouseEvent>());
                } catch (const std::runtime_error&) {
                    refused = true;
                }
                assert(refused);
            }
            for (const char* type : {"", "keydown", "custom"}) {
                auto event = synthetic_event_from_options(type, OwnedDomEvent::Kind::Event, empty);
                bool refused = false;
                try {
                    static_cast<void>(
                        dispatch_synthetic_event(engine, DomEventTarget::document(), event));
                } catch (const std::runtime_error&) {
                    refused = true;
                }
                assert(refused);
            }
        }
        SDL_DestroyWindow(window);
        SDL_Quit();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
