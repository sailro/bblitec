#include <bblite/pal_custom_events.hpp>
#include <cassert>

int main() {
    using namespace bbl;
    const js::RealmScope scope;
    Engine engine;
    pal::EventLoop loop;
    std::string order;
    unsigned errors = 0;
    loop.on_error([&](std::exception_ptr) { ++errors; });
    loop.run([&] {
        auto event = create_custom_event("update", js::JsonValue::null_value(), true, true);
        auto copy = event;
        on_dom_custom(engine, DomEventTarget::window(), "update", 1,
            [&](const auto& value) {
                assert(value.dom->phase == 1);
                assert(value.dom->target == DomEventTarget::document());
                assert(value.dom->current_target == DomEventTarget::window());
                order += "C";
            }, true);
        on_dom_custom(engine, DomEventTarget::document(), "update", 2,
            [&](const auto& value) {
                order += "A";
                value.prevent_default();
                assert(copy.is_default_prevented());
                off_dom_custom(engine, DomEventTarget::document(), "update", 3);
                on_dom_custom(engine, DomEventTarget::document(), "update", 4,
                    [&](const auto&) { order += "L"; });
                bool rejected = false;
                try { static_cast<void>(dispatch_custom_event(engine, DomEventTarget::window(), copy)); }
                catch (const std::logic_error&) { rejected = true; }
                assert(rejected);
                loop.queue_microtask([&] { order += "M"; });
                throw std::runtime_error("listener failure");
            }, false, true);
        on_dom_custom(engine, DomEventTarget::document(), "update", 3,
            [&](const auto&) { assert(false); });
        on_dom_custom(engine, DomEventTarget::window(), "update", 5,
            [&](const auto&) { order += "B"; });
        assert(!dispatch_custom_event(engine, DomEventTarget::document(), event));
        assert(order == "CAB" && errors == 1);
        assert(!event.dom->dispatching && !event.dom->current_target && event.dom->path.empty());
        assert(custom_event_target(copy).value().target == DomEventTarget::document());
        order.clear();
        assert(!dispatch_custom_event(engine, DomEventTarget::document(), copy));
        assert(order == "CLB");
        loop.close();
    });
    assert(order == "CLBM");

    auto retained = create_custom_event("retained");
    DomEventTargetValue target;
    {
        Engine owner;
        assert(dispatch_custom_event(owner, DomEventTarget::document(), retained));
        target = *custom_event_target(retained);
        assert(&dom_target_owner(target) == &owner);
    }
    const auto refuses = [](auto operation) {
        try { operation(); } catch (const std::logic_error&) { return true; }
        return false;
    };
    assert(refuses([&] { static_cast<void>(custom_event_target(retained)); }));
    assert(refuses([&] { static_cast<void>(dom_target_owner(target)); }));
    assert(!custom_event_target(retained, true));
    assert(dispatch_custom_event(engine, DomEventTarget::window(), retained));
    assert(custom_event_target(retained)->engine == &engine);
    auto old_target = *custom_event_target(retained);
    Engine moved = std::move(engine);
    assert(refuses([&] { static_cast<void>(custom_event_target(retained)); }));
    assert(refuses([&] { static_cast<void>(dom_target_owner(old_target)); }));
    assert(dispatch_custom_event(moved, DomEventTarget::document(), retained));
    assert(custom_event_target(retained)->engine == &moved);
}
