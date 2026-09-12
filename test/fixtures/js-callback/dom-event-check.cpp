#include <bblite/pal_dom_events.hpp>
#include <iostream>

namespace {
using Target = bbl::DomEventTarget;
using Event = bbl::PlatformMouseEvent;
using Registry = bbl::DomEventListeners<Event>;
const auto window = Target::window(), document = Target::document();
const auto parent = Target::node(1), child = Target::node(2);

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

Event pointer(std::string type = "pointermove", bool bubbles = true) {
    Event event;
    event.dom = std::make_shared<bbl::DomEventState>();
    event.dom->type = std::move(type);
    event.dom->target = child;
    event.dom->path = {child, parent, document, window};
    event.dom->bubbles = bubbles;
    return event;
}

void phases() {
    Registry registry;
    std::string calls;
    const auto listen = [&](Target target, bool capture, double phase, char label) {
        registry.add(target, "pointermove", 1, [&, target, phase, label](const Event& event) {
            require(event.dom->target == child && event.dom->current_target == target, "target identities");
            require(event.dom->phase == phase, "event phase");
            calls += label;
        }, capture);
    };
    listen(window, true, 1, 'A'); listen(document, true, 1, 'B');
    listen(parent, true, 1, 'C'); listen(child, true, 2, 'D');
    listen(child, false, 2, 'E'); listen(parent, false, 3, 'F');
    listen(document, false, 3, 'G'); listen(window, false, 3, 'H');
    auto event = pointer();
    registry.dispatch(event);
    require(calls == "ABCDEFGH", "capture, target and bubble order");
    require(event.dom->phase == 0 && !event.dom->current_target && event.dom->path.empty(), "dispatch cleanup");
    calls.clear();
    registry.dispatch(pointer("pointermove", false));
    require(calls == "ABCDE", "non-bubbling event still captures");
    registry.remove(child, "pointermove", 1);
    calls.clear();
    registry.dispatch(pointer());
    require(calls == "ABCDFGH", "capture participates in removal identity");
}

void mutation() {
    Registry registry;
    std::string calls;
    registry.add(child, "pointermove", 1, [&](const Event&) {
        calls += 'A';
        registry.remove(child, "pointermove", 2);
        registry.add(child, "pointermove", 3, [&](const Event&) { calls += 'C'; });
    });
    registry.add(child, "pointermove", 2, [&](const Event&) { calls += 'B'; });
    registry.add(child, "pointermove", 1, [&](const Event&) { calls += 'X'; }, false, true);
    registry.dispatch(pointer());
    require(calls == "A", "same-phase additions wait, removals apply, duplicate ignored");
    calls.clear();
    registry.dispatch(pointer());
    require(calls == "AC", "later dispatch sees new registration");
    Registry once;
    int visits = 0;
    once.add(child, "pointermove", 1, [&](const Event&) { ++visits; once.dispatch(pointer()); }, false, true);
    once.dispatch(pointer());
    require(visits == 1, "once removed before reentrant event");
    Registry later_phase;
    later_phase.add(child, "pointermove", 1, [&](const Event&) {
        later_phase.add(child, "pointermove", 2, [&](const Event&) { ++visits; });
    }, true);
    later_phase.dispatch(pointer());
    require(visits == 2, "later phase takes its own listener snapshot");
}

void stopping() {
    Registry registry;
    std::string calls;
    registry.add(parent, "pointermove", 1, [&](const Event& event) { calls += 'A'; event.stop_propagation(); }, true);
    registry.add(parent, "pointermove", 2, [&](const Event&) { calls += 'B'; }, true);
    registry.add(child, "pointermove", 3, [&](const Event&) { calls += 'C'; });
    registry.dispatch(pointer());
    require(calls == "AB", "stopPropagation preserves remaining listeners in its phase");
    Registry immediate;
    int visits = 0;
    immediate.add(child, "pointermove", 1, [](const Event& event) { event.stop_immediate_propagation(); });
    immediate.add(child, "pointermove", 2, [&](const Event&) { ++visits; }, false, true);
    immediate.dispatch(pointer());
    immediate.remove(child, "pointermove", 1);
    immediate.dispatch(pointer());
    immediate.dispatch(pointer());
    require(visits == 1, "stopImmediatePropagation does not consume uncalled once-listeners");
}

void cancellation() {
    Registry registry;
    registry.add(child, "pointermove", 1, [](const Event& event) { event.prevent_default(); }, false, false, true);
    auto passive = pointer();
    registry.dispatch(passive);
    require(!passive.default_prevented, "passive listener cannot cancel");
    registry.add(child, "pointermove", 2, [](const Event& event) { event.prevent_default(); });
    auto active = pointer();
    registry.dispatch(active);
    require(active.default_prevented, "active listener cancels");
    auto noncancelable = pointer();
    noncancelable.dom->cancelable = false;
    registry.dispatch(noncancelable);
    require(!noncancelable.default_prevented, "noncancelable event stays uncanceled");
    Registry failures;
    int reported = 0, later = 0;
    failures.add(child, "pointermove", 1, [](const Event&) { throw std::runtime_error("listener"); }, false, false, true);
    failures.add(child, "pointermove", 2, [&](const Event& event) {
        require(!event.dom->passive_listener, "passive state restored after exception");
        ++later;
    });
    failures.dispatch(pointer(), [&](Registry::Callback& callback, const Event& event) {
        try { callback(event); } catch (const std::runtime_error&) { ++reported; }
    });
    require(reported == 1 && later == 1, "owning realm reports individual callback errors");
}

void keyboard() {
    bbl::DomEventListeners<bbl::PlatformKeyboardEvent> registry;
    bbl::PlatformKeyboardEvent event;
    event.code = "Escape"; event.key = "Escape"; event.shift_key = true;
    event.dom = pointer().dom;
    event.dom->type = "keydown";
    int calls = 0;
    registry.add(window, "keydown", 1, [&](const bbl::PlatformKeyboardEvent& key) {
        require(key.shift_key && key.code == "Escape" && key.dom->phase == 1, "keyboard uses same target traversal");
        ++calls; key.prevent_default();
    }, true);
    registry.dispatch(event);
    require(calls == 1 && event.default_prevented, "keyboard cancellation");
}
}

int main() {
    phases(); mutation(); stopping(); cancellation(); keyboard();
    std::cout << "dom-event-check: ok\n";
}
