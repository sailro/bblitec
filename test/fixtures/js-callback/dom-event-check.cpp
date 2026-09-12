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

void engine_ownership() {
    bbl::Engine application, display;
    int calls = 0;
    bbl::on_dom_pointer(application, child, "pointermove", 1, [&](const Event&) { ++calls; });
    bbl::on_dom_pointer(application, window, "pointermove", 1, [&](const Event&) { ++calls; });
    require(application.dom_input->revision == 1, "transport types change only when needed");
    std::optional<Event> mailbox;
    bbl::dom_input(display).pointer_sink = [&](const Event& event) { mailbox = event; };
    bbl::dispatch_dom_pointer(display, bbl::dom_event(Event{}, "pointermove", {child, document, window}));
    require(calls == 0 && mailbox.has_value(), "display queues native payload without invoking script");
    bbl::dispatch_dom_pointer(application, *mailbox);
    require(calls == 2, "application dispatches its own listeners");
    bbl::off_dom_pointer(application, child, "pointermove", 1);
    bbl::dispatch_dom_pointer(application, pointer());
    require(calls == 3, "engine-owned removal");
}

void physical_input_transactions() {
    bbl::Engine application, display;
    const auto sibling = bbl::DomEventTarget::node(8);
    std::vector<std::string> visits;
    bbl::on_dom_pointer(application, child, "pointerout", 1, [&](const Event& event) {
        require(&bbl::dom_event_owner(event) == &application, "target values use the receiving realm's document");
        require(event.dom->related_target == sibling, "out carries the new hit target");
        visits.push_back("out");
    });
    bbl::on_dom_pointer(application, parent, "pointerleave", 2, [&](const Event&) { visits.push_back("parent-leave"); });
    bbl::on_dom_pointer(application, sibling, "pointerenter", 3, [&](const Event& event) {
        require(event.dom->related_target == child && !event.dom->bubbles, "enter carries the previous hit target");
        visits.push_back("enter");
    });
    bbl::dom_input(display).hover_path = {child, parent, document, window};
    auto move = bbl::dom_pointer_input(display, bbl::DomPointerAction::Move, Event{}, {sibling, parent, document, window});
    std::shared_ptr<bbl::DomEventBatch> mailbox;
    display.dom_input->batch_sink = [&](auto batch) { mailbox = std::move(batch); };
    bbl::dispatch_dom_batch(display, move);
    require(!move->ready() && visits.empty(), "display never runs application listeners or waits for completion");
    mailbox->dispatch(application);
    require(move->ready() && visits == std::vector<std::string>{"out", "enter"}, "sibling crossing preserves the common parent's hover");
    for (const auto& entry : move->events) std::visit([](const auto& event) {
        require(event.dom->dispatch_engine == nullptr, "completed packets retain no realm pointer");
    }, entry.payload);

    int mouse_down = 0, mouse_up = 0, clicks = 0;
    bbl::on_dom_pointer(application, sibling, "pointerdown", 4, [](const Event& event) { event.prevent_default(); });
    bbl::on_dom_pointer(application, sibling, "mousedown", 5, [&](const Event&) { ++mouse_down; });
    bbl::on_dom_pointer(application, sibling, "mouseup", 6, [&](const Event&) { ++mouse_up; });
    bbl::on_dom_pointer(application, sibling, "click", 7, [&](const Event&) { ++clicks; });
    const std::vector path{sibling, parent, document, window};
    auto down = bbl::dom_pointer_input(display, bbl::DomPointerAction::Down, Event{.button = 0, .buttons = 1}, path);
    down->dispatch(application);
    require(down->ready() && down->default_prevented && mouse_down == 0, "pointerdown cancellation suppresses native default and compatibility mousedown");
    auto up = bbl::dom_pointer_input(display, bbl::DomPointerAction::Up, Event{.button = 0, .buttons = 0}, path);
    up->dispatch(application);
    require(mouse_up == 0 && clicks == 1, "compatibility suppression does not suppress click");
    bbl::off_dom_pointer(application, sibling, "pointerdown", 4);
    bbl::dom_pointer_input(display, bbl::DomPointerAction::Down, Event{.button = 0, .buttons = 1}, path)->dispatch(application);
    require(mouse_down == 1, "released pointer clears compatibility suppression");

    bbl::on_dom_keyboard(application, window, "keydown", 8, [](const bbl::PlatformKeyboardEvent& event) { event.prevent_default(); });
    bbl::DomEventBatch keys;
    keys.add(bbl::dom_event(bbl::PlatformKeyboardEvent{}, "keydown", path), true);
    keys.dispatch(application);
    require(keys.ready() && keys.default_prevented, "keyboard native default waits for source cancellation");
}
}

int main() {
    phases(); mutation(); stopping(); cancellation(); keyboard(); engine_ownership(); physical_input_transactions();
    std::cout << "dom-event-check: ok\n";
}
