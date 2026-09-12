#pragma once

#include <bblite/runtime.hpp>

#include <map>
#include <set>
#include <tuple>
#include <atomic>
#include <variant>

namespace bbl {

/** Target/type/capture identity and phase traversal share the ordinary registry's
 * mutation and once rules. The owning realm supplies callback cleanup/reporting. */
template <typename Event>
class DomEventListeners {
  public:
    using Listeners = PlatformEventListeners<void(const Event&)>;
    using Callback = Listeners::Callback;

    void add(DomEventTarget target, std::string type, std::size_t identity,
        Callback callback, bool capture = false, bool once = false, bool passive = false) {
        const auto entry = js::make_gc_shared<Listener>(std::move(callback), passive);
        auto wrapper = js::make_closure(std::tuple{entry}, [](auto& captures, const Event& event) {
            const auto& listener = std::get<0>(captures);
            auto& state = *event.dom;
            const bool previous = state.passive_listener;
            state.passive_listener = listener->passive;
            struct Restore {
                DomEventState& state;
                bool previous;
                ~Restore() { state.passive_listener = previous; }
            } restore{state, previous};
            listener->callback(event);
        });
        listeners_[key(target, std::move(type), capture)].add(identity, std::move(wrapper), once);
    }

    void remove(DomEventTarget target, std::string type, std::size_t identity, bool capture = false) {
        const auto found = listeners_.find(key(target, std::move(type), capture));
        if (found != listeners_.end()) found->second.remove(identity);
    }

    template <typename Invoke>
    void dispatch(const Event& event, Invoke&& invoke) {
        if (!event.dom) throw std::logic_error("DOM dispatch requires an owned event path.");
        auto& state = *event.dom;
        if (state.dispatching) throw std::logic_error("The same event is already being dispatched.");
        state.dispatching = true;
        struct Reset {
            DomEventState& state;
            ~Reset() {
                state.phase = 0;
                state.current_target.reset();
                state.path.clear();
                state.propagation_stopped = false;
                state.immediate_propagation_stopped = false;
                state.dispatching = false;
            }
        } reset{state};
        const auto path = state.path;
        const auto deliver = [&](DomEventTarget target, bool capture, double phase) {
            if (state.propagation_stopped) return;
            state.phase = phase;
            state.current_target = target;
            const auto found = listeners_.find(key(target, state.type, capture));
            if (found == listeners_.end()) return;
            found->second.dispatch_while([&] { return !state.immediate_propagation_stopped; }, invoke, event);
        };
        for (auto item = path.rbegin(); item != path.rend(); ++item)
            deliver(*item, true, *item == state.target ? 2 : 1);
        for (const auto& item : path)
            if (item == state.target || state.bubbles) deliver(item, false, item == state.target ? 2 : 3);
    }

    void dispatch(const Event& event) {
        dispatch(event, [](Callback& callback, const Event& value) { callback(value); });
    }

#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        for (const auto& [identity, listeners] : listeners_) {
            (void)identity;
            listeners.gc_trace(visitor);
        }
    }
#endif

  private:
    struct Listener {
        Listener(Callback callback, bool passive) : callback(std::move(callback)), passive(passive) {}
        Callback callback;
        bool passive;
#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback); }
#endif
    };
    using Key = std::tuple<DomEventTargetKind, std::uint32_t, std::string, bool>;
    static Key key(DomEventTarget target, std::string type, bool capture) {
        return {target.kind, target.element, std::move(type), capture};
    }
    std::map<Key, Listeners> listeners_;
};

/** Script listeners stay with their Engine/realm. A display Engine installs only
 * native mailbox sinks; no script callback is copied to its rendering thread. */
struct DomEventBatch;
struct DomInput {
    DomEventListeners<PlatformMouseEvent> pointer;
    DomEventListeners<PlatformKeyboardEvent> keyboard;
    std::set<std::string> event_types;
    std::uint64_t revision = 0;
    std::function<void(const PlatformMouseEvent&)> pointer_sink;
    std::function<void(const PlatformKeyboardEvent&)> keyboard_sink;
    std::function<void(std::shared_ptr<DomEventBatch>)> batch_sink;
    std::function<std::vector<DomEventTarget>(double, double)> hit_path;
    std::function<std::vector<DomEventTarget>()> focus_path;
    std::function<bool(DomEventTarget)> can_activate;
    std::vector<DomEventTarget> hover_path;
    std::vector<DomEventTarget> pressed_path;
    bool suppress_compatibility_mouse = false;
    bool native_pointer_default = false;

#if defined(BBLITE_WORKERS) && BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        pointer.gc_trace(visitor);
        keyboard.gc_trace(visitor);
    }
#endif
};

inline DomInput& dom_input(Engine& engine) {
    if (!engine.dom_input) engine.dom_input = js::make_gc_shared<DomInput>();
    return *engine.dom_input;
}

inline void on_dom_pointer(Engine& engine, DomEventTarget target, std::string type,
    std::size_t identity, DomEventListeners<PlatformMouseEvent>::Callback callback,
    bool capture = false, bool once = false, bool passive = false) {
    auto& input = dom_input(engine);
    if (input.event_types.insert(type).second) ++input.revision;
    input.pointer.add(target, std::move(type), identity, std::move(callback), capture, once, passive);
}

inline void on_dom_keyboard(Engine& engine, DomEventTarget target, std::string type,
    std::size_t identity, DomEventListeners<PlatformKeyboardEvent>::Callback callback,
    bool capture = false, bool once = false, bool passive = false) {
    auto& input = dom_input(engine);
    if (input.event_types.insert(type).second) ++input.revision;
    input.keyboard.add(target, std::move(type), identity, std::move(callback), capture, once, passive);
}

inline void off_dom_pointer(Engine& engine, DomEventTarget target, std::string type,
    std::size_t identity, bool capture = false) {
    if (engine.dom_input) engine.dom_input->pointer.remove(target, std::move(type), identity, capture);
}

inline void off_dom_keyboard(Engine& engine, DomEventTarget target, std::string type,
    std::size_t identity, bool capture = false) {
    if (engine.dom_input) engine.dom_input->keyboard.remove(target, std::move(type), identity, capture);
}

template <typename Event>
[[nodiscard]] Event dom_event(Event payload, std::string type, std::vector<DomEventTarget> path,
    bool bubbles = true, bool cancelable = true, std::optional<DomEventTarget> related = std::nullopt) {
    if (path.empty()) throw std::logic_error("DOM events require a target.");
    payload.dom = std::make_shared<DomEventState>();
    payload.dom->type = std::move(type);
    payload.dom->target = path.front();
    payload.dom->path = std::move(path);
    payload.dom->bubbles = bubbles;
    payload.dom->cancelable = cancelable;
    payload.dom->related_target = related;
    return payload;
}

inline void dispatch_dom_pointer(Engine& engine, const PlatformMouseEvent& event) {
    if (!engine.dom_input) return;
    if (engine.dom_input->pointer_sink) engine.dom_input->pointer_sink(event);
    else engine.dom_input->pointer.dispatch(event);
}

inline void dispatch_dom_keyboard(Engine& engine, const PlatformKeyboardEvent& event) {
    if (!engine.dom_input) return;
    if (engine.dom_input->keyboard_sink) engine.dom_input->keyboard_sink(event);
    else engine.dom_input->keyboard.dispatch(event);
}

/** One physical input transaction. Only native payloads cross threads. The
 * display checks completion between frames, so callbacks can request layout
 * without deadlocking behind a synchronous input acknowledgement. */
struct DomEventBatch {
    using Payload = std::variant<PlatformMouseEvent, PlatformKeyboardEvent>;
    struct Entry {
        Payload payload;
        bool controls_default = false;
    };
    std::vector<Entry> events;
    bool default_prevented = false;
    bool releases_pointer = false;
    std::atomic<bool> completed = false;

    template <typename Event> void add(Event event, bool controls_default = false) {
        events.push_back({std::move(event), controls_default});
    }
    template <typename Invoke> void dispatch(Engine& engine, Invoke&& invoke) {
        struct Complete {
            DomEventBatch& batch;
            ~Complete() { batch.completed.store(true, std::memory_order_release); }
        } complete{*this};
        for (auto& entry : events) std::visit([&](const auto& event) {
            if (engine.dom_input) {
                using PayloadType = std::decay_t<decltype(event)>;
                if constexpr (std::is_same_v<PayloadType, PlatformMouseEvent>) {
                    const auto& type = event.dom->type;
                    if (engine.dom_input->suppress_compatibility_mouse &&
                        (type == "mousedown" || type == "mouseup" || type == "mousemove")) return;
                    engine.dom_input->pointer.dispatch(event, invoke);
                    if (type == "pointerdown" && event.default_prevented) engine.dom_input->suppress_compatibility_mouse = true;
                }
                else engine.dom_input->keyboard.dispatch(event, invoke);
            }
            if (entry.controls_default && event.default_prevented) default_prevented = true;
        }, entry.payload);
        if (releases_pointer && engine.dom_input) engine.dom_input->suppress_compatibility_mouse = false;
    }
    void dispatch(Engine& engine) {
        dispatch(engine, [](auto& callback, const auto& event) { callback(event); });
    }
    [[nodiscard]] bool ready() const { return completed.load(std::memory_order_acquire); }
};

inline void dispatch_dom_batch(Engine& engine, const std::shared_ptr<DomEventBatch>& batch) {
    if (engine.dom_input && engine.dom_input->batch_sink) engine.dom_input->batch_sink(batch);
    else batch->dispatch(engine);
}

inline std::vector<DomEventTarget> dom_canvas_path() {
    return {DomEventTarget::canvas(), DomEventTarget::document(), DomEventTarget::window()};
}

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
inline std::vector<DomEventTarget> dom_ui_path(const Engine& engine, UiElementHandle target) {
    std::vector<DomEventTarget> path;
    while (target.value != invalid_handle) {
        const auto& record = handle_at(engine.ui_elements, target);
        path.push_back(DomEventTarget::node(target.value));
        if (record.attached_to_root) {
            path.push_back(DomEventTarget::document()); path.push_back(DomEventTarget::window());
            break;
        }
        target = record.parent.value != invalid_handle ? record.parent : record.markup_owner;
    }
    return path;
}
#endif

/** A boundary event has its own target and path. Sharing a parent does not
 * create a second parent enter/leave event, while over/out still bubble. */
inline void append_dom_pointer_boundary(DomEventBatch& batch, const PlatformMouseEvent& payload,
    const std::vector<DomEventTarget>& previous, const std::vector<DomEventTarget>& next) {
    if (previous == next) return;
    const auto previous_target = previous.empty() ? std::nullopt : std::optional{previous.front()};
    const auto next_target = next.empty() ? std::nullopt : std::optional{next.front()};
    std::size_t old_count = previous.size(), new_count = next.size();
    while (old_count && new_count && previous[old_count - 1] == next[new_count - 1]) { --old_count; --new_count; }
    if (previous_target) {
        batch.add(dom_event(payload, "pointerout", previous, true, true, next_target));
        batch.add(dom_event(payload, "mouseout", previous, true, true, next_target));
        for (std::size_t index = 0; index < old_count; ++index) {
            if (previous[index].kind == DomEventTargetKind::Document || previous[index].kind == DomEventTargetKind::Window) continue;
            const std::vector<DomEventTarget> path(previous.begin() + static_cast<std::ptrdiff_t>(index), previous.end());
            batch.add(dom_event(payload, "pointerleave", path, false, false, next_target));
            batch.add(dom_event(payload, "mouseleave", path, false, false, next_target));
        }
    }
    if (next_target) {
        batch.add(dom_event(payload, "pointerover", next, true, true, previous_target));
        batch.add(dom_event(payload, "mouseover", next, true, true, previous_target));
        for (std::size_t index = new_count; index > 0; --index) {
            if (next[index - 1].kind == DomEventTargetKind::Document || next[index - 1].kind == DomEventTargetKind::Window) continue;
            const std::vector<DomEventTarget> path(next.begin() + static_cast<std::ptrdiff_t>(index - 1), next.end());
            batch.add(dom_event(payload, "pointerenter", path, false, false, previous_target));
            batch.add(dom_event(payload, "mouseenter", path, false, false, previous_target));
        }
    }
}

enum class DomPointerAction { Move, Down, Up, Wheel, Leave, Cancel };

inline std::shared_ptr<DomEventBatch> dom_pointer_input(Engine& engine, DomPointerAction action,
    PlatformMouseEvent payload, std::vector<DomEventTarget> path) {
    auto batch = std::make_shared<DomEventBatch>();
    auto& input = dom_input(engine);
    if (action == DomPointerAction::Leave) path.clear();
    if (action != DomPointerAction::Wheel && action != DomPointerAction::Cancel) {
        append_dom_pointer_boundary(*batch, payload, input.hover_path, path);
        input.hover_path = path;
    }
    if (path.empty()) return batch;
    const auto add = [&](std::string type, bool controls_default = false) {
        batch->add(dom_event(payload, std::move(type), path), controls_default);
    };
    switch (action) {
        case DomPointerAction::Move: add("pointermove"); add("mousemove"); break;
        case DomPointerAction::Down: {
            const int mask = payload.button == 1 ? 4 : payload.button == 2 ? 2 : 1 << static_cast<int>(payload.button);
            add(static_cast<int>(payload.buttons) == mask ? "pointerdown" : "pointermove", true); add("mousedown", true);
            if (payload.button == 0) input.pressed_path = path;
            break;
        }
        case DomPointerAction::Up:
            add(payload.buttons == 0 ? "pointerup" : "pointermove"); add("mouseup");
            if (payload.button == 0 && !input.pressed_path.empty()) {
                // Click targets the nearest common inclusive ancestor of down/up.
                for (std::size_t index = 0; index < path.size(); ++index) {
                    if (std::find(input.pressed_path.begin(), input.pressed_path.end(), path[index]) == input.pressed_path.end()) continue;
                    if ((path[index].kind == DomEventTargetKind::Element || path[index].kind == DomEventTargetKind::Canvas) &&
                        (!input.can_activate || input.can_activate(path[index])))
                        batch->add(dom_event(payload, "click", std::vector<DomEventTarget>(path.begin() + static_cast<std::ptrdiff_t>(index), path.end())), true);
                    break;
                }
                input.pressed_path.clear();
            }
            batch->releases_pointer = payload.buttons == 0;
            break;
        case DomPointerAction::Wheel: add("wheel", true); break;
        case DomPointerAction::Cancel:
            batch->add(dom_event(payload, "pointercancel", path, true, false));
            input.pressed_path.clear(); batch->releases_pointer = true; break;
        case DomPointerAction::Leave: break;
    }
    return batch;
}

} // namespace bbl
