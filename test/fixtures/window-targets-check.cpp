#define main generated_main
#include "../../artifacts/window-targets/program.hpp"
#undef main
#include "pal_ui_rml.cpp"
#include <cassert>

struct WindowCycle {
    bbl::js::Ref<WindowCycle> self;
    bbl::js::Callback<void()> callback;
    void gc_trace(const bbl::js::TraceVisitor& visitor) const {
        visitor(self);
        visitor(callback);
    }
};

namespace bbl::pal {
std::string asset_path(std::string_view) { throw std::runtime_error("Unexpected asset read"); }
std::string environment_variable(const char*) { return {}; }
double performance_milliseconds() { return 0; }
Engine& window_document_engine() {
    static Engine engine;
    return engine;
}
const void* window_document_identity() {
    static const int identity = 0;
    return &identity;
}
std::optional<std::string> read_local_storage(const std::string&) { return std::nullopt; }
void write_local_storage(const std::string&, const std::string&) {}
void remove_local_storage(const std::string&) {}
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
    try {
        using namespace bbl;
        assert(generated_main() == 0);
        auto& engine = pal::window_document_engine();
        auto panel = ui_get_element_by_id(engine, "target");
        auto resize = [&] {
            dispatch_dom_pointer(engine, dom_event(PlatformMouseEvent{}, "resize",
                                                   {DomEventTarget::window()}, false, false));
        };
        auto storage = [&] {
            dispatch_dom_storage(engine,
                                 dom_event(PlatformStorageEvent{.key = "setting",
                                                                .old_value = "before",
                                                                .new_value = "next",
                                                                .url = "native://example/"},
                                           "storage", {DomEventTarget::window()}, false, false));
        };
        resize();
        storage();
        assert(ui_get_attribute(engine, panel, "data-resizes") == "1");
        assert(ui_get_attribute(engine, panel, "data-optional") == "1");
        assert(ui_get_attribute(engine, panel, "data-storage") == "1");
        assert(ui_get_attribute(engine, panel, "data-storage-typed") == "yes");
        dispatch_dom_pointer(engine, dom_event(PlatformMouseEvent{}, "pagehide",
                                               {DomEventTarget::window()}, false, false));
        assert(ui_get_attribute(engine, panel, "data-pagehide") == "yes");
        dispatch_dom_pointer(
            engine, dom_event(PlatformMouseEvent{}, "click", {DomEventTarget::node(panel.value)}));
        resize();
        storage();
        assert(ui_get_attribute(engine, panel, "data-resizes") == "1");
        assert(ui_get_attribute(engine, panel, "data-optional") == "1");
        assert(ui_get_attribute(engine, panel, "data-storage") == "1");
        const auto first = dom_target_value(engine, DomEventTarget::window());
        const auto document = dom_target_value(engine, DomEventTarget::document());
        const auto element = dom_target_value(engine, DomEventTarget::node(panel.value));
        assert(dom_owner_document(element).has_value() && *dom_owner_document(element) == document);
        assert(!dom_owner_document(document).has_value());
        assert(dom_document_window(document) == first);
        assert(dom_window_document(first) == document);
        const auto key = dom_target_weak_identity(first);
        assert(!key.owner_before(dom_target_weak_identity(first)) &&
               !dom_target_weak_identity(first).owner_before(key));
        assert(key.owner_before(dom_target_weak_identity(document)) ||
               dom_target_weak_identity(document).owner_before(key));
        const auto element_key = dom_target_weak_identity(element);
        ui_remove(engine, panel);
        const auto replacement = ui_create_element(engine, "div");
        assert(replacement.value != panel.value);
        assert(!element_key.expired());
        const auto replacement_key = dom_target_weak_identity(
            dom_target_value(engine, DomEventTarget::node(replacement.value)));
        assert(element_key.owner_before(replacement_key) ||
               replacement_key.owner_before(element_key));
        struct Property {
            int value = 0;
        };
        dom_window_property<Property>(first).value = 42;
        {
            const DomTargetState copied_state = engine.dom_targets;
            assert(copied_state.identities.empty() && copied_state.properties.empty());
            Engine copied;
            const auto copied_target = dom_target_value(copied, DomEventTarget::window());
            const auto copied_key = dom_target_weak_identity(copied_target);
            assert(key.owner_before(copied_key) || copied_key.owner_before(key));
            assert(dom_window_property<Property>(copied_target).value == 0);
            Engine moved = std::move(copied);
            assert(copied_key.expired() && copied_target.owner_lifetime.expired());
            const auto moved_target = dom_target_value(moved, DomEventTarget::window());
            assert(dom_window_property<Property>(moved_target).value == 0);
            const auto assigned_key = dom_target_weak_identity(moved_target);
            moved = Engine{};
            assert(assigned_key.expired() && moved_target.owner_lifetime.expired());
        }
        js::WeakIdentity expired;
        DomEventTargetValue expired_target;
        {
            const js::RealmScope other_realm;
            Engine other;
            const auto second = dom_target_value(other, DomEventTarget::window());
            expired_target = second;
            expired = dom_target_weak_identity(second);
            assert(second != first);
            assert(dom_window_property<Property>(second).value == 0);
            dom_window_property<Property>(second).value = 7;
            assert(dom_window_property<Property>(first).value == 42);
            int calls = 0;
            on_dom_pointer(other, DomEventTarget::window(), "resize", 123,
                           [&](const auto&) { ++calls; });
            resize();
            assert(calls == 0);
            dispatch_dom_pointer(other, dom_event(PlatformMouseEvent{}, "resize",
                                                  {DomEventTarget::window()}, false, false));
            assert(calls == 1);
        }
        assert(expired.expired());
        bool expired_refused = false, document_refused = false;
        try {
            static_cast<void>(dom_target_weak_identity(expired_target));
        } catch (const std::logic_error&) {
            expired_refused = true;
        }
        try {
            static_cast<void>(dom_window_property<Property>(document));
        } catch (const std::runtime_error&) {
            document_refused = true;
        }
        assert(expired_refused && document_refused);
        struct CycleProperty {
            js::Ref<WindowCycle> value;
        };
        auto cycle = js::make_ref<WindowCycle>();
        cycle->self = cycle;
        cycle->callback = js::make_closure(std::tuple{cycle, first}, [](auto& captures) {
            assert(std::get<0>(captures)->self);
            static_cast<void>(dom_window_owner(std::get<1>(captures)));
        });
        const auto cycle_identity = cycle.weak_identity();
        dom_window_property<CycleProperty>(first).value = cycle;
        cycle.reset();
        js::collect_cycles();
        assert(!cycle_identity.expired());
        dom_window_property<CycleProperty>(first).value->callback();
        dom_window_property<CycleProperty>(first).value.reset();
        js::collect_cycles();
        assert(cycle_identity.expired());
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
