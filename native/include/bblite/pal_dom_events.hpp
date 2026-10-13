#pragma once

#include <bblite/features/has_ui.hpp>
#include <bblite/features/workers.hpp>

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>

#include <cmath>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <tuple>
#include <atomic>
#include <variant>

namespace bbl {

/** Target/type/capture identity and phase traversal share the ordinary registry's
 * mutation and once rules. The owning realm supplies callback cleanup/reporting. */
template <typename Event> class DomEventListeners {
    struct RestorePassive {
        DomEventState& state;
        bool previous;
        ~RestorePassive() { state.passive_listener = previous; }
    };

public:
    using Listeners = PlatformEventListeners<void(const Event&)>;
    using Callback = Listeners::Callback;

    /** False for a duplicate (target, type, callback, capture) listener. */
    bool add(DomEventTarget target, std::string type, std::size_t identity, Callback callback,
             bool capture = false, bool once = false, bool passive = false,
             ListenerLeasePtr lease = {}) {
        return listeners_[key(target, std::move(type), capture)].add(
            identity, wrap(std::move(callback), passive), once, std::move(lease));
    }

    /** The target's `on<type>` handler: a non-capture listener at its first position. */
    void set_handler(DomEventTarget target, std::string type, Callback callback) {
        listeners_[key(target, std::move(type), false)].set_handler(
            callback ? wrap(std::move(callback), false) : Callback{});
    }

    void remove(DomEventTarget target, std::string type, std::size_t identity,
                bool capture = false) {
        const auto found = listeners_.find(key(target, std::move(type), capture));
        if (found != listeners_.end())
            found->second.remove(identity);
    }

    template <typename Invoke>
    void dispatch(const Event& event, Invoke&& invoke, Engine* owner = nullptr) {
        if (!event.dom)
            throw std::logic_error("DOM dispatch requires an owned event path.");
        auto& state = *event.dom;
        if (state.dispatching)
            throw std::logic_error("The same event is already being dispatched.");
        state.dispatching = true;
        state.dispatch_engine = owner;
        struct Reset {
            DomEventState& state;
            const Event& event;
            ~Reset() {
                if constexpr (requires { event.default_prevented = true; })
                    event.default_prevented = event.default_prevented || state.default_prevented;
                state.phase = 0;
                state.current_target.reset();
                state.path.clear();
                state.propagation_stopped = false;
                state.immediate_propagation_stopped = false;
                state.dispatching = false;
                state.dispatch_engine = nullptr;
            }
        } reset{state, event};
        const auto path = state.path;
        const auto deliver = [&](DomEventTarget target, bool capture, double phase) {
            if (state.propagation_stopped)
                return;
            state.phase = phase;
            state.current_target = target;
            const auto found = listeners_.find(key(target, state.type, capture));
            if (found == listeners_.end())
                return;
            found->second.dispatch_while([&] { return !state.immediate_propagation_stopped; },
                                         invoke, event);
        };
        for (auto item = path.rbegin(); item != path.rend(); ++item)
            deliver(*item, true, *item == state.target ? 2 : 1);
        for (const auto& item : path)
            if (item == state.target || state.bubbles)
                deliver(item, false, item == state.target ? 2 : 3);
    }

    void dispatch(const Event& event) {
        dispatch(event, [](Callback& callback, const Event& value) { callback(value); });
    }

#if BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        for (const auto& [identity, listeners] : listeners_) {
            (void)identity;
            listeners.gc_trace(visitor);
        }
    }
#endif

private:
    struct Listener {
        Listener(Callback callback, bool passive)
            : callback(std::move(callback)), passive(passive) {}
        Callback callback;
        bool passive;
#if BBLITE_WORKERS
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(callback); }
#endif
    };
    static Callback wrap(Callback callback, bool passive) {
        const auto entry = js::make_gc_shared<Listener>(std::move(callback), passive);
        return js::make_closure(std::tuple{entry}, [](auto& captures, const Event& event) {
            const auto& listener = std::get<0>(captures);
            auto& state = *event.dom;
            const bool previous = state.passive_listener;
            state.passive_listener = listener->passive;
            RestorePassive restore{state, previous};
            listener->callback(event);
        });
    }
    using Key = std::tuple<DomEventTargetKind, std::uint32_t, std::string, bool>;
    static Key key(DomEventTarget target, std::string type, bool capture) {
        return {target.kind, target.element, std::move(type), capture};
    }
    std::map<Key, Listeners> listeners_;
};

/** Script listeners stay with their Engine/realm. A display Engine installs only
 * native mailbox sinks; no script callback is copied to its rendering thread. */
struct DomEventBatch;
struct DomTouchContact {
    PlatformMouseEvent pointer;
    /** The hit path of the contact's press. */
    std::vector<DomEventTarget> path;
    /** The path its events last targeted: its capture target's while captured. */
    std::vector<DomEventTarget> target_path;
    bool gesture = false;
};

inline double touch_wheel_delta_y(double previous, double current) {
    return previous > 0 && current > 0 ? -300 * std::log(current / previous) : 0;
}

/** The mouse's PointerEvent.pointerId; touch contacts number from 2. */
inline constexpr double dom_mouse_pointer_id = 1;

/**
 * Pointer Events capture state where script runs: each pointer's pending
 * capture target override, and the active pointers with whether each is in
 * the active buttons state. The mouse is always active. A Window display shares
 * this record to target the input it prepares, hence the lock.
 */
struct DomPointerCaptures {
    mutable std::mutex mutex;
    std::map<double, DomEventTarget> pending;
    std::map<double, bool> active{{dom_mouse_pointer_id, false}};

    [[nodiscard]] std::optional<DomEventTarget> pending_target(double pointer_id) const {
        const std::lock_guard lock(mutex);
        const auto found = pending.find(pointer_id);
        return found == pending.end() ? std::nullopt : std::optional{found->second};
    }
};

struct DomInput {
    DomEventListeners<PlatformMouseEvent> pointer;
    DomEventListeners<PlatformKeyboardEvent> keyboard;
    DomEventListeners<PlatformCustomEvent> custom;
    DomEventListeners<PlatformTransitionEvent> transition;
    DomEventListeners<PlatformDragEvent> drag;
    DomEventListeners<PlatformStorageEvent> storage;
    std::set<std::string> event_types;
    std::set<std::uint32_t> pointer_elements;
    std::uint64_t revision = 0;
    std::function<void(const PlatformMouseEvent&)> pointer_sink;
    std::function<void(std::shared_ptr<DomEventBatch>)> batch_sink;
    std::function<std::vector<DomEventTarget>(double, double)> hit_path;
    std::function<std::vector<DomEventTarget>()> focus_path;
    std::function<bool(DomEventTarget)> can_activate;
    std::function<void()> end_withheld_press;
    std::vector<DomEventTarget> hover_path;
    std::vector<DomEventTarget> pressed_path;
    std::shared_ptr<DomPointerCaptures> pointer_captures = std::make_shared<DomPointerCaptures>();
    /** The pointer capture target override per pointer: where prepared input is targeted. */
    std::map<double, DomEventTarget> capture_overrides;
    /** The platform holds the mouse for a captured pointer (pal_platform_events). */
    bool platform_mouse_capture = false;
    std::set<double> suppress_compatibility_mouse;
    std::map<std::pair<std::uint64_t, std::uint64_t>, DomTouchContact> touches;
    bool native_pointer_default = false;
    bool canvas_background = true;
    bool pending_resize = false;
    /** The path under an active file drag and the files its drop carries. */
    std::vector<DomEventTarget> drag_path;
    DroppedFiles dropped_files;
    std::shared_ptr<std::atomic<bool>> drag_acceptance;
    double drag_x = 0, drag_y = 0;

#if BBLITE_WORKERS
    void gc_trace(const js::TraceVisitor& visitor) const {
        pointer.gc_trace(visitor);
        keyboard.gc_trace(visitor);
        custom.gc_trace(visitor);
        transition.gc_trace(visitor);
        drag.gc_trace(visitor);
        storage.gc_trace(visitor);
    }
#endif
};

inline DomInput& dom_input(Engine& engine) {
    if (!engine.dom_input)
        engine.dom_input = js::make_gc_shared<DomInput>();
    return *engine.dom_input;
}

/** Native hit testing and the Window display learn which types and elements have listeners. */
inline DomInput& listen_dom_pointer(Engine& engine, DomEventTarget target,
                                    const std::string& type) {
    auto& input = dom_input(engine);
    const bool new_type = input.event_types.insert(type).second;
    const bool new_element = target.kind == DomEventTargetKind::Element &&
                             input.pointer_elements.insert(target.element).second;
    if (new_type || new_element) {
        ++input.revision;
#if BBLITE_HAS_UI
        ++engine.ui_revision;
#endif
    }
    return input;
}

/** The display learns a listened type it sources natively, such as a key or a transition end. */
inline DomInput& listen_dom_type(Engine& engine, const std::string& type) {
    auto& input = dom_input(engine);
    if (input.event_types.insert(type).second)
        ++input.revision;
    return input;
}

inline DomInput& listen_dom_keyboard(Engine& engine, const std::string& type) {
    return listen_dom_type(engine, type);
}

/** `on_dom_<family>` adds one listener; false for a duplicate. */
inline bool on_dom_pointer(Engine& engine, DomEventTarget target, std::string type,
                           std::size_t identity,
                           DomEventListeners<PlatformMouseEvent>::Callback callback,
                           bool capture = false, bool once = false, bool passive = false,
                           ListenerLeasePtr lease = {}) {
    return listen_dom_pointer(engine, target, type)
        .pointer.add(target, std::move(type), identity, std::move(callback), capture, once, passive,
                     std::move(lease));
}

inline bool on_dom_keyboard(Engine& engine, DomEventTarget target, std::string type,
                            std::size_t identity,
                            DomEventListeners<PlatformKeyboardEvent>::Callback callback,
                            bool capture = false, bool once = false, bool passive = false,
                            ListenerLeasePtr lease = {}) {
    return listen_dom_keyboard(engine, type)
        .keyboard.add(target, std::move(type), identity, std::move(callback), capture, once,
                      passive, std::move(lease));
}

/** `target.on<type> = callback`; an empty callback removes the handler. */
inline void set_dom_pointer_handler(Engine& engine, DomEventTarget target, std::string type,
                                    DomEventListeners<PlatformMouseEvent>::Callback callback) {
    if (callback)
        listen_dom_pointer(engine, target, type);
    else if (!engine.dom_input)
        return;
    engine.dom_input->pointer.set_handler(target, std::move(type), std::move(callback));
}

inline void set_dom_keyboard_handler(Engine& engine, DomEventTarget target, std::string type,
                                     DomEventListeners<PlatformKeyboardEvent>::Callback callback) {
    if (callback)
        listen_dom_keyboard(engine, type);
    else if (!engine.dom_input)
        return;
    engine.dom_input->keyboard.set_handler(target, std::move(type), std::move(callback));
}

inline void off_dom_pointer(Engine& engine, DomEventTarget target, std::string type,
                            std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->pointer.remove(target, std::move(type), identity, capture);
}

inline void off_dom_keyboard(Engine& engine, DomEventTarget target, std::string type,
                             std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->keyboard.remove(target, std::move(type), identity, capture);
}

inline bool on_dom_transition(Engine& engine, DomEventTarget target, std::string type,
                              std::size_t identity,
                              DomEventListeners<PlatformTransitionEvent>::Callback callback,
                              bool capture = false, bool once = false, bool passive = false,
                              ListenerLeasePtr lease = {}) {
    return listen_dom_type(engine, type)
        .transition.add(target, std::move(type), identity, std::move(callback), capture, once,
                        passive, std::move(lease));
}

inline void off_dom_transition(Engine& engine, DomEventTarget target, std::string type,
                               std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->transition.remove(target, std::move(type), identity, capture);
}

/** The platform sources file drags while a listened type names them. */
inline bool on_dom_drag(Engine& engine, DomEventTarget target, std::string type,
                        std::size_t identity,
                        DomEventListeners<PlatformDragEvent>::Callback callback,
                        bool capture = false, bool once = false, bool passive = false,
                        ListenerLeasePtr lease = {}) {
    return listen_dom_pointer(engine, target, type)
        .drag.add(target, std::move(type), identity, std::move(callback), capture, once, passive,
                  std::move(lease));
}

inline void off_dom_drag(Engine& engine, DomEventTarget target, std::string type,
                         std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->drag.remove(target, std::move(type), identity, capture);
}

inline void set_dom_drag_handler(Engine& engine, DomEventTarget target, std::string type,
                                 DomEventListeners<PlatformDragEvent>::Callback callback) {
    if (callback)
        listen_dom_pointer(engine, target, type);
    else if (!engine.dom_input)
        return;
    engine.dom_input->drag.set_handler(target, std::move(type), std::move(callback));
}

inline bool on_dom_storage(Engine& engine, DomEventTarget target, std::string type,
                           std::size_t identity,
                           DomEventListeners<PlatformStorageEvent>::Callback callback,
                           bool capture = false, bool once = false, bool passive = false,
                           ListenerLeasePtr lease = {}) {
    return dom_input(engine).storage.add(target, std::move(type), identity, std::move(callback),
                                         capture, once, passive, std::move(lease));
}

inline void off_dom_storage(Engine& engine, DomEventTarget target, std::string type,
                            std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->storage.remove(target, std::move(type), identity, capture);
}

inline void dispatch_dom_storage(Engine& engine, const PlatformStorageEvent& event) {
    if (engine.dom_input)
        engine.dom_input->storage.dispatch(
            event, [](auto& callback, const auto& payload) { callback(payload); }, &engine);
}

template <typename Event>
[[nodiscard]] Event dom_event(Event payload, std::string type, std::vector<DomEventTarget> path,
                              bool bubbles = true, bool cancelable = true,
                              std::optional<DomEventTarget> related = std::nullopt) {
    if (path.empty())
        throw std::logic_error("DOM events require a target.");
    payload.dom = std::make_shared<DomEventState>();
    payload.dom->type = std::move(type);
    payload.dom->target = path.front();
    payload.dom->path = std::move(path);
    payload.dom->bubbles = bubbles;
    payload.dom->cancelable = cancelable;
    payload.dom->related_target = related;
    return payload;
}

/** HTML page-transition dispatch uses the legacy Document target override.
 * Native Window teardown discards the page; no session-history cache retains it. */
[[nodiscard]] inline PlatformMouseEvent window_pagehide_event() {
    auto event = dom_event(PlatformMouseEvent{}, "pagehide", {DomEventTarget::window()});
    event.dom->target_override = DomEventTarget::document();
    event.dom->persisted = false;
    event.dom->composed = false;
    return event;
}

/** HTML's beforeunload shares the override; it does not bubble, and native close has no prompt to cancel. */
[[nodiscard]] inline PlatformMouseEvent window_beforeunload_event() {
    auto event = dom_event(PlatformMouseEvent{}, "beforeunload", {DomEventTarget::window()}, false);
    event.dom->target_override = DomEventTarget::document();
    event.dom->composed = false;
    return event;
}

/** HTML unloads a document with beforeunload, then pagehide; `invoke` runs each listener. */
template <typename Invoke> void dispatch_page_lifecycle(Engine& engine, Invoke&& invoke) {
    if (!engine.dom_input)
        return;
    for (const auto& event : {window_beforeunload_event(), window_pagehide_event()})
        engine.dom_input->pointer.dispatch(event, invoke, &engine);
}

template <typename Event> [[nodiscard]] js::Nullable<bool> dom_event_persisted(const Event& event) {
    const auto persisted = dom_event_state(event).persisted;
    if (!persisted.has_value())
        return std::nullopt;
    return *persisted;
}

inline void dispatch_dom_pointer(Engine& engine, const PlatformMouseEvent& event) {
    if (!engine.dom_input)
        return;
    if (engine.dom_input->pointer_sink)
        engine.dom_input->pointer_sink(event);
    else
        engine.dom_input->pointer.dispatch(
            event, [](auto& callback, const auto& payload) { callback(payload); }, &engine);
}

/** Trusted pointer input records its pointer before listeners run: the mouse's
 * active buttons state, or a touch contact, whose pointerdown implicitly
 * captures it to its target element. */
inline void dom_pointer_dispatching(DomPointerCaptures& captures, const PlatformMouseEvent& event) {
    const auto& state = *event.dom;
    if (!state.type.starts_with("pointer"))
        return;
    const std::lock_guard lock(captures.mutex);
    if (event.pointer_type == "mouse") {
        captures.active[event.pointer_id] = event.buttons != 0;
        return;
    }
    if (state.type != "pointerdown")
        return;
    captures.active[event.pointer_id] = true;
    if (state.target.kind == DomEventTargetKind::Element ||
        state.target.kind == DomEventTargetKind::Canvas)
        captures.pending[event.pointer_id] = state.target;
}

/** Implicit release: a pointer's pending capture ends after its pointerup or
 * pointercancel, and a touch contact stops being an active pointer. */
inline void dom_pointer_dispatched(DomPointerCaptures& captures, const PlatformMouseEvent& event) {
    const auto& type = event.dom->type;
    if (type != "pointerup" && type != "pointercancel")
        return;
    const std::lock_guard lock(captures.mutex);
    captures.pending.erase(event.pointer_id);
    if (event.pointer_type != "mouse")
        captures.active.erase(event.pointer_id);
}

/** One physical input transaction. Only native payloads cross threads. The
 * display checks completion between frames, so callbacks can request layout
 * without deadlocking behind a synchronous input acknowledgement. */
struct DomEventBatch {
    using Payload = std::variant<PlatformMouseEvent, PlatformKeyboardEvent, PlatformTransitionEvent,
                                 PlatformDragEvent>;
    struct Entry {
        Payload payload;
        bool controls_default = false;
    };
    std::vector<Entry> events;
    bool default_prevented = false;
    std::vector<double> released_pointers;
    bool primary_touch = false;
    std::atomic<bool> completed = false;

    template <typename Event> void add(Event event, bool controls_default = false) {
        events.push_back({std::move(event), controls_default});
    }
    template <typename Invoke> void dispatch(Engine& engine, Invoke&& invoke) {
        struct Complete {
            DomEventBatch& batch;
            ~Complete() { batch.completed.store(true, std::memory_order_release); }
        } complete{*this};
        for (auto& entry : events)
            std::visit(
                [&](const auto& event) {
                    if (engine.dom_input) {
                        using PayloadType = std::decay_t<decltype(event)>;
                        if constexpr (std::is_same_v<PayloadType, PlatformMouseEvent>) {
                            const auto& type = event.dom->type;
                            auto& suppressed = engine.dom_input->suppress_compatibility_mouse;
                            if (primary_touch && suppressed.contains(event.pointer_id))
                                default_prevented = true;
                            if (suppressed.contains(event.pointer_id) &&
                                (type == "mousedown" || type == "mouseup" || type == "mousemove"))
                                return;
                            struct Dispatched {
                                std::shared_ptr<DomPointerCaptures> captures;
                                const PlatformMouseEvent& event;
                                ~Dispatched() { dom_pointer_dispatched(*captures, event); }
                            } dispatched{engine.dom_input->pointer_captures, event};
                            dom_pointer_dispatching(*dispatched.captures, event);
                            engine.dom_input->pointer.dispatch(event, invoke, &engine);
                            if (type == "pointerdown" && event.default_prevented)
                                suppressed.insert(event.pointer_id);
                        } else if constexpr (std::is_same_v<PayloadType, PlatformTransitionEvent>)
                            engine.dom_input->transition.dispatch(event, invoke, &engine);
                        else if constexpr (std::is_same_v<PayloadType, PlatformDragEvent>) {
                            engine.dom_input->drag.dispatch(event, invoke, &engine);
                            if (event.acceptance)
                                event.acceptance->store(event.default_prevented,
                                                        std::memory_order_release);
                        } else
                            engine.dom_input->keyboard.dispatch(event, invoke, &engine);
                    }
                    if (entry.controls_default && event.default_prevented)
                        default_prevented = true;
                },
                entry.payload);
        if (engine.dom_input)
            for (const auto id : released_pointers)
                engine.dom_input->suppress_compatibility_mouse.erase(id);
    }
    void dispatch(Engine& engine) {
        dispatch(engine, [](auto& callback, const auto& event) { callback(event); });
    }
    [[nodiscard]] bool ready() const { return completed.load(std::memory_order_acquire); }
};

inline void dispatch_dom_batch(Engine& engine, const std::shared_ptr<DomEventBatch>& batch) {
    if (engine.dom_input && engine.dom_input->batch_sink)
        engine.dom_input->batch_sink(batch);
    else
        batch->dispatch(engine);
}

inline std::vector<DomEventTarget> dom_canvas_path() {
    return {DomEventTarget::canvas(), DomEventTarget::document(), DomEventTarget::window()};
}

inline js::Nullable<DomEventTargetValue> dom_target_value(Engine& engine,
                                                          std::optional<DomEventTarget> target) {
    if (!target)
        return std::nullopt;
    return dom_target_value(engine, *target);
}

inline Engine& dom_target_owner(DomEventTargetValue value) {
    if (!value.engine)
        throw std::logic_error("An event target has no owning document.");
    if (value.owner_lifetime.expired())
        throw std::logic_error("The event target's owning document has expired.");
    return *value.engine;
}

/** Weak collections distinguish targets without extending their document's lifetime. */
inline js::WeakIdentity dom_target_weak_identity(DomEventTargetValue value) {
    auto& engine = dom_target_owner(value);
    const auto key = (static_cast<std::uint64_t>(value.target.kind) << 32) | value.target.element;
    auto& identity = engine.dom_targets.identities[key];
    if (!identity)
        identity = std::make_shared<const int>(0);
    return identity;
}

inline Engine& dom_window_owner(DomEventTargetValue value) {
    auto& engine = dom_target_owner(value);
    if (value.target.kind != DomEventTargetKind::Window)
        throw std::runtime_error("This property requires a Window target.");
    return engine;
}

template <typename Storage> Storage& dom_window_property(DomEventTargetValue value) {
    static const int key = 0;
    auto& storage = dom_window_owner(value).dom_targets.properties[&key];
    if (!storage)
        storage = std::make_shared<Storage>();
    return *static_cast<Storage*>(storage.get());
}

inline js::Nullable<DomEventTargetValue> dom_owner_document(DomEventTargetValue value) {
    auto& engine = dom_target_owner(value);
    if (value.target.kind == DomEventTargetKind::Window)
        throw std::runtime_error("ownerDocument requires a Node target.");
    if (value.target.kind == DomEventTargetKind::Document)
        return {};
    return dom_target_value(engine, DomEventTarget::document());
}

inline Engine& dom_document_owner(DomEventTargetValue value) {
    auto& engine = dom_target_owner(value);
    if (value.target.kind != DomEventTargetKind::Document)
        throw std::runtime_error("This property requires a Document target.");
    return engine;
}

inline DomEventTargetValue dom_document_window(DomEventTargetValue value) {
    return dom_target_value(dom_document_owner(value), DomEventTarget::window());
}

inline DomEventTargetValue dom_window_document(DomEventTargetValue value) {
    return dom_target_value(dom_window_owner(value), DomEventTarget::document());
}

/** Event.composedPath(): the dispatch path while listeners run, else empty. */
template <typename Event>
[[nodiscard]] js::Array<DomEventTargetValue> dom_event_composed_path(const Event& event) {
    const auto& state = dom_event_state(event);
    Engine* owner = state.dispatch_engine;
    if constexpr (requires { event.payload->owner; })
        if (!owner && !event.payload->owner_lifetime.expired())
            owner = event.payload->owner;
    js::Array<DomEventTargetValue> path;
    if (!state.dispatching || !owner)
        return path;
    for (const auto& target : state.path)
        path.push_back(dom_target_value(*owner, target));
    return path;
}

/** The retained element a target names, invalid for Document, Window and text targets. */
inline UiElementHandle dom_target_retained_element(DomEventTargetValue value) {
    const auto& engine = dom_target_owner(value);
    const auto element = value.target.kind == DomEventTargetKind::Element
                             ? UiElementHandle{value.target.element}
                         : value.target.kind == DomEventTargetKind::Canvas ? engine.primary_canvas
                                                                           : UiElementHandle{};
    if (element.value >= engine.ui_elements.size())
        return {};
    const auto& tag = engine.ui_elements[element.value].tag;
    return tag.empty() || tag.front() == '#' ? UiElementHandle{} : element;
}

inline UiElementHandle dom_target_element(DomEventTargetValue value) {
    const auto element = dom_target_retained_element(value);
    if (element.value == invalid_handle)
        throw std::runtime_error("The event target is not an Element of its owning document.");
    return element;
}

#if BBLITE_HAS_UI
inline bool dom_target_has_tag(DomEventTargetValue value, std::string_view tag) {
    if (value.target.kind == DomEventTargetKind::Canvas)
        return tag == "canvas";
    const auto element = dom_target_retained_element(value);
    return element.value != invalid_handle &&
           dom_target_owner(value).ui_elements[element.value].tag == tag;
}

inline bool dom_target_has_tag(const js::Nullable<DomEventTargetValue>& value,
                               std::string_view tag) {
    return value.has_value() && dom_target_has_tag(*value, tag);
}

/** `instanceof Element`, or `HTMLElement` when `html`: static SVG markup is in the SVG namespace. */
inline bool dom_target_is_element(DomEventTargetValue value, bool html) {
    if (value.target.kind == DomEventTargetKind::Canvas)
        return true;
    const auto element = dom_target_retained_element(value);
    if (element.value == invalid_handle)
        return false;
    const auto& record = dom_target_owner(value).ui_elements[element.value];
    return !html || (!record.svg_namespace &&
                     (record.markup_owner.value == invalid_handle ||
                      (record.tag != "svg" && record.tag != "path" && record.tag != "rect")));
}

inline bool dom_target_is_element(const js::Nullable<DomEventTargetValue>& value, bool html) {
    return value.has_value() && dom_target_is_element(*value, html);
}

inline bool dom_target_is_svg(DomEventTargetValue value) {
    return dom_target_is_element(value, false) && !dom_target_is_element(value, true);
}

inline bool dom_target_is_svg(const js::Nullable<DomEventTargetValue>& value) {
    return value.has_value() && dom_target_is_svg(*value);
}

/** isContentEditable of an element target; the render canvas a page does not retain has no
 * contenteditable state. */
inline bool dom_target_is_content_editable(DomEventTargetValue value) {
    if (value.target.kind == DomEventTargetKind::Canvas &&
        dom_target_retained_element(value).value == invalid_handle)
        return false;
    return ui_is_content_editable(dom_target_owner(value), dom_target_element(value));
}

/** `instanceof Node`: the Document, the canvas and retained elements and text, not the Window. */
inline bool dom_target_is_node(DomEventTargetValue value) {
    if (value.target.kind != DomEventTargetKind::Element)
        return value.target.kind != DomEventTargetKind::Window;
    return value.target.element < dom_target_owner(value).ui_elements.size();
}

inline bool dom_target_is_node(const js::Nullable<DomEventTargetValue>& value) {
    return value.has_value() && dom_target_is_node(*value);
}

/** `ancestor.contains(target)`: Document, Window and other documents' nodes are never contained. */
inline bool dom_target_within(Engine& engine, UiElementHandle ancestor,
                              const js::Nullable<DomEventTargetValue>& value) {
    if (!value.has_value() || value->engine != &engine)
        return false;
    return ui_contains(engine, ancestor, dom_target_retained_element(*value));
}
#endif

inline std::vector<DomEventTarget> dom_ui_path(const Engine& engine, UiElementHandle target) {
    std::vector<DomEventTarget> path;
    for (; target.value != invalid_handle;
         target = ui_tree_parent(handle_at(engine.ui_elements, target)))
        path.push_back(DomEventTarget::node(target.value));
    if (!path.empty() &&
        handle_at(engine.ui_elements, UiElementHandle{path.back().element}).attached_to_root) {
        path.push_back(DomEventTarget::document());
        path.push_back(DomEventTarget::window());
    }
    return path;
}

/** WebIDL `long` conversion of a pointerId argument. */
inline double dom_pointer_id(double value) {
    if (!std::isfinite(value))
        return 0;
    constexpr double range = 4294967296.0;
    double wrapped = std::fmod(std::trunc(value), range);
    if (wrapped < 0)
        wrapped += range;
    return (wrapped >= range / 2 ? wrapped - range : wrapped) + 0.0;
}

/** Node.isConnected of an element that can hold pointer capture; the engine canvas always is. */
inline bool dom_capture_target_connected(const Engine& engine, DomEventTarget target) {
    if (target.kind == DomEventTargetKind::Canvas)
        return true;
    return target.kind == DomEventTargetKind::Element &&
           target.element < engine.ui_elements.size() &&
           ui_is_connected(engine, UiElementHandle{target.element});
}

/** The event path of a pointer capture target, or the Document's once it left the tree. */
inline std::vector<DomEventTarget> dom_capture_path(const Engine& engine, DomEventTarget target) {
    if (target.kind == DomEventTargetKind::Canvas)
        return dom_canvas_path();
    if (!dom_capture_target_connected(engine, target))
        return {DomEventTarget::document(), DomEventTarget::window()};
    return dom_ui_path(engine, UiElementHandle{target.element});
}

namespace detail {
/** The capture state of an element's document, with the pointer named by `pointer_id`. */
struct PointerCaptureCall {
    Engine& engine;
    DomPointerCaptures& captures;
    std::unique_lock<std::mutex> lock;
    DomEventTarget target;
    double pointer_id;
    bool active_buttons;
};

inline PointerCaptureCall pointer_capture_call(DomEventTargetValue value, double pointer_id,
                                               std::string_view method) {
    auto& engine = dom_target_owner(value);
    if (value.target.kind != DomEventTargetKind::Element &&
        value.target.kind != DomEventTargetKind::Canvas)
        std::rethrow_exception(js::make_error("TypeError", "Illegal invocation"));
    auto& captures = *dom_input(engine).pointer_captures;
    std::unique_lock lock(captures.mutex);
    const auto id = dom_pointer_id(pointer_id);
    const auto pointer = captures.active.find(id);
    if (pointer == captures.active.end())
        throw js::make_dom_exception("Failed to execute '" + std::string(method) +
                                         "' on 'Element': No active pointer with the given id "
                                         "is found.",
                                     "NotFoundError");
    // A pending target that left the tree no longer holds the pointer.
    if (const auto pending = captures.pending.find(id);
        pending != captures.pending.end() && !dom_capture_target_connected(engine, pending->second))
        captures.pending.erase(pending);
    return {engine, captures, std::move(lock), value.target, id, pointer->second};
}
} // namespace detail

/**
 * Element.setPointerCapture: NotFoundError for an inactive pointer,
 * InvalidStateError for a disconnected element or while the pointer is locked;
 * a pointer without pressed buttons is left uncaptured. The capture targets the
 * pointer's events from its next one (`dom_process_pointer_capture`).
 */
inline void dom_set_pointer_capture(DomEventTargetValue value, double pointer_id) {
    auto call = detail::pointer_capture_call(value, pointer_id, "setPointerCapture");
    if (!dom_capture_target_connected(call.engine, call.target))
        throw js::make_dom_exception("Failed to execute 'setPointerCapture' on 'Element': The "
                                     "element is not connected.",
                                     "InvalidStateError");
    if (call.engine.pointer_locked)
        throw js::make_dom_exception("Failed to execute 'setPointerCapture' on 'Element': The "
                                     "pointer is locked.",
                                     "InvalidStateError");
    if (call.active_buttons)
        call.captures.pending[call.pointer_id] = call.target;
}

/** Element.releasePointerCapture: NotFoundError for an inactive pointer; another element's capture stays. */
inline void dom_release_pointer_capture(DomEventTargetValue value, double pointer_id) {
    auto call = detail::pointer_capture_call(value, pointer_id, "releasePointerCapture");
    const auto pending = call.captures.pending.find(call.pointer_id);
    if (pending != call.captures.pending.end() && pending->second == call.target)
        call.captures.pending.erase(pending);
}

/** Element.hasPointerCapture: whether the element is the pointer's pending capture target. */
inline bool dom_has_pointer_capture(DomEventTargetValue value, double pointer_id) {
    auto& engine = dom_target_owner(value);
    const auto pending =
        dom_input(engine).pointer_captures->pending_target(dom_pointer_id(pointer_id));
    return pending == value.target && dom_capture_target_connected(engine, *pending);
}

/** A boundary event has its own target and path. Sharing a parent does not
 * create a second parent enter/leave event, while over/out still bubble. */
inline void append_dom_pointer_boundary(DomEventBatch& batch, const PlatformMouseEvent& payload,
                                        const std::vector<DomEventTarget>& previous,
                                        const std::vector<DomEventTarget>& next) {
    if (previous == next)
        return;
    const auto previous_target = previous.empty() ? std::nullopt : std::optional{previous.front()};
    const auto next_target = next.empty() ? std::nullopt : std::optional{next.front()};
    std::size_t old_count = previous.size(), new_count = next.size();
    while (old_count && new_count && previous[old_count - 1] == next[new_count - 1]) {
        --old_count;
        --new_count;
    }
    if (previous_target) {
        batch.add(dom_event(payload, "pointerout", previous, true, true, next_target));
        if (payload.is_primary)
            batch.add(dom_event(payload, "mouseout", previous, true, true, next_target));
        for (std::size_t index = 0; index < old_count; ++index) {
            if (previous[index].kind == DomEventTargetKind::Document ||
                previous[index].kind == DomEventTargetKind::Window)
                continue;
            const std::vector<DomEventTarget> path(
                previous.begin() + static_cast<std::ptrdiff_t>(index), previous.end());
            batch.add(dom_event(payload, "pointerleave", path, false, false, next_target));
            if (payload.is_primary)
                batch.add(dom_event(payload, "mouseleave", path, false, false, next_target));
        }
    }
    if (next_target) {
        batch.add(dom_event(payload, "pointerover", next, true, true, previous_target));
        if (payload.is_primary)
            batch.add(dom_event(payload, "mouseover", next, true, true, previous_target));
        for (std::size_t index = new_count; index > 0; --index) {
            if (next[index - 1].kind == DomEventTargetKind::Document ||
                next[index - 1].kind == DomEventTargetKind::Window)
                continue;
            const std::vector<DomEventTarget> path(
                next.begin() + static_cast<std::ptrdiff_t>(index - 1), next.end());
            batch.add(dom_event(payload, "pointerenter", path, false, false, previous_target));
            if (payload.is_primary)
                batch.add(dom_event(payload, "mouseenter", path, false, false, previous_target));
        }
    }
}

/** gotpointercapture and lostpointercapture bubble and cannot be canceled. */
inline void append_dom_capture_event(const Engine& engine, DomEventBatch& batch,
                                     const PlatformMouseEvent& payload, std::string type,
                                     DomEventTarget target) {
    batch.add(dom_event(payload, std::move(type), dom_capture_path(engine, target), true, false));
}

/**
 * Pointer Events' "process pending pointer capture" ahead of a pointer's
 * event: lostpointercapture at the previous override (the Document once it
 * left the tree), then gotpointercapture at the pending target, which becomes
 * the override. Returns the override's path, which the event then targets.
 */
inline std::optional<std::vector<DomEventTarget>>
dom_process_pointer_capture(Engine& engine, DomEventBatch& batch,
                            const PlatformMouseEvent& payload) {
    auto& input = dom_input(engine);
    auto pending = input.pointer_captures->pending_target(payload.pointer_id);
    if (pending && !dom_capture_target_connected(engine, *pending))
        pending.reset();
    const auto found = input.capture_overrides.find(payload.pointer_id);
    const auto current =
        found == input.capture_overrides.end() ? std::nullopt : std::optional{found->second};
    if (current && current != pending)
        append_dom_capture_event(engine, batch, payload, "lostpointercapture", *current);
    if (pending && pending != current)
        append_dom_capture_event(engine, batch, payload, "gotpointercapture", *pending);
    if (!pending) {
        if (found != input.capture_overrides.end())
            input.capture_overrides.erase(found);
        return std::nullopt;
    }
    input.capture_overrides.insert_or_assign(payload.pointer_id, *pending);
    return dom_capture_path(engine, *pending);
}

/** Implicit release after pointerup or pointercancel: the realm clears the
 * pending capture once that event ran, and lostpointercapture follows it. */
inline bool dom_release_pointer_capture_after(Engine& engine, DomEventBatch& batch,
                                              const PlatformMouseEvent& payload) {
    auto& input = dom_input(engine);
    const auto found = input.capture_overrides.find(payload.pointer_id);
    if (found == input.capture_overrides.end())
        return false;
    const auto target = found->second;
    input.capture_overrides.erase(found);
    append_dom_capture_event(engine, batch, payload, "lostpointercapture", target);
    return true;
}

enum class DomPointerAction { Move, Down, Up, Wheel, Leave, Cancel };

/** Mouse input over `path` (the hit test). A captured pointer's events, its
 * compatibility mouse events and its hover follow the capture target until the
 * capture ends; boundary events then reach the pointer's position. */
inline std::shared_ptr<DomEventBatch> dom_pointer_input(Engine& engine, DomPointerAction action,
                                                        PlatformMouseEvent payload,
                                                        std::vector<DomEventTarget> path) {
    auto batch = std::make_shared<DomEventBatch>();
    auto& input = dom_input(engine);
    if (action == DomPointerAction::Leave)
        path.clear();
    auto target = path;
    if (action != DomPointerAction::Wheel && action != DomPointerAction::Leave)
        if (auto captured = dom_process_pointer_capture(engine, *batch, payload))
            target = std::move(*captured);
    const bool captured_leave =
        action == DomPointerAction::Leave && input.capture_overrides.contains(payload.pointer_id);
    if (action != DomPointerAction::Wheel && action != DomPointerAction::Cancel &&
        !captured_leave) {
        append_dom_pointer_boundary(*batch, payload, input.hover_path, target);
        input.hover_path = target;
    }
    if (target.empty())
        return batch;
    const auto add = [&](std::string type, bool controls_default = false) {
        batch->add(dom_event(payload, std::move(type), target), controls_default);
    };
    switch (action) {
    case DomPointerAction::Move:
        add("pointermove");
        add("mousemove");
        break;
    case DomPointerAction::Down: {
        const int mask = payload.button == 1   ? 4
                         : payload.button == 2 ? 2
                                               : 1 << static_cast<int>(payload.button);
        add(static_cast<int>(payload.buttons) == mask ? "pointerdown" : "pointermove", true);
        add("mousedown", true);
        if (payload.button == 0)
            input.pressed_path = target;
        break;
    }
    case DomPointerAction::Up: {
        const bool released = payload.buttons == 0;
        add(released ? "pointerup" : "pointermove");
        if (released && dom_release_pointer_capture_after(engine, *batch, payload)) {
            append_dom_pointer_boundary(*batch, payload, input.hover_path, path);
            input.hover_path = path;
        }
        add("mouseup");
        if (payload.button == 0 && !input.pressed_path.empty()) {
            // Click targets the nearest common inclusive ancestor of down/up.
            for (std::size_t index = 0; index < target.size(); ++index) {
                if (std::find(input.pressed_path.begin(), input.pressed_path.end(),
                              target[index]) == input.pressed_path.end())
                    continue;
                if ((target[index].kind == DomEventTargetKind::Element ||
                     target[index].kind == DomEventTargetKind::Canvas) &&
                    (!input.can_activate || input.can_activate(target[index])))
                    batch->add(dom_event(payload, "click",
                                         std::vector<DomEventTarget>(
                                             target.begin() + static_cast<std::ptrdiff_t>(index),
                                             target.end())),
                               true);
                break;
            }
            input.pressed_path.clear();
        }
        if (released)
            batch->released_pointers.push_back(payload.pointer_id);
        break;
    }
    case DomPointerAction::Wheel:
        add("wheel", true);
        break;
    case DomPointerAction::Cancel:
        batch->add(dom_event(payload, "pointercancel", target, true, false));
        dom_release_pointer_capture_after(engine, *batch, payload);
        input.pressed_path.clear();
        batch->released_pointers.push_back(payload.pointer_id);
        break;
    case DomPointerAction::Leave:
        break;
    }
    return batch;
}

/** Direct touch: its pointerdown implicitly captures the contact to its target
 * (`dom_pointer_dispatching`), so later events follow the capture target; a
 * released capture leaves them at the element under the contact. Contact
 * identity and primary status survive motion, sibling releases and cancel. */
inline std::shared_ptr<DomEventBatch> dom_touch_input(Engine& engine, DomPointerAction action,
                                                      DomTouchContact& contact) {
    auto batch = std::make_shared<DomEventBatch>();
    const auto& pointer = contact.pointer;
    batch->primary_touch = pointer.is_primary;
    if (contact.path.empty())
        return batch;
    auto path = contact.path;
    if (action != DomPointerAction::Down) {
        const auto& input = *engine.dom_input;
        if (auto captured = dom_process_pointer_capture(engine, *batch, pointer))
            path = std::move(*captured);
        else if (input.hit_path)
            path = input.hit_path(pointer.client_x, pointer.client_y);
        if (path.empty())
            path = contact.target_path;
        append_dom_pointer_boundary(*batch, pointer, contact.target_path, path);
    }
    contact.target_path = path;
    const auto add = [&](std::string type, bool controls_default = false) {
        batch->add(dom_event(pointer, std::move(type), path), controls_default);
    };
    switch (action) {
    case DomPointerAction::Down:
        append_dom_pointer_boundary(*batch, pointer, {}, path);
        add("pointerdown", true);
        if (pointer.is_primary)
            add("mousedown", true);
        break;
    case DomPointerAction::Move:
        add("pointermove");
        if (pointer.is_primary)
            add("mousemove");
        break;
    case DomPointerAction::Up:
        add("pointerup");
        dom_release_pointer_capture_after(engine, *batch, pointer);
        if (pointer.is_primary)
            add("mouseup");
        if ((path.front().kind == DomEventTargetKind::Element ||
             path.front().kind == DomEventTargetKind::Canvas) &&
            (!engine.dom_input->can_activate || engine.dom_input->can_activate(path.front())))
            add("click", true);
        break;
    case DomPointerAction::Cancel:
        batch->add(dom_event(pointer, "pointercancel", path, true, false));
        dom_release_pointer_capture_after(engine, *batch, pointer);
        break;
    default:
        throw std::logic_error("Unsupported direct-touch action.");
    }
    if (action == DomPointerAction::Up || action == DomPointerAction::Cancel) {
        append_dom_pointer_boundary(*batch, pointer, path, {});
        batch->released_pointers.push_back(pointer.pointer_id);
    }
    return batch;
}

} // namespace bbl
