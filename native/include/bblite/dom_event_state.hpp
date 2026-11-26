#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <stdexcept>
#include <functional>
#include <memory>
#include <vector>

namespace bbl {

struct Engine;

enum class DomEventTargetKind { Window, Document, Canvas, Element };

/** Native identities only: event paths can cross the Window mailbox. */
struct DomEventTarget {
    DomEventTargetKind kind = DomEventTargetKind::Window;
    std::uint32_t element = 0;
    static DomEventTarget window() { return {}; }
    static DomEventTarget document() { return {DomEventTargetKind::Document, {}}; }
    static DomEventTarget canvas() { return {DomEventTargetKind::Canvas, {}}; }
    static DomEventTarget node(std::uint32_t element) {
        return {DomEventTargetKind::Element, element};
    }
    [[nodiscard]] bool operator==(const DomEventTarget&) const = default;
};

/** Source-visible identity belongs to the owning document. The transport uses
 * DomEventTarget alone and reconstructs this value on the receiving realm. */
struct DomEventTargetValue {
    Engine* engine = nullptr;
    DomEventTarget target{};
    std::weak_ptr<const int> owner_lifetime;
    [[nodiscard]] bool operator==(const DomEventTargetValue& other) const {
        return engine == other.engine && target == other.target &&
               !owner_lifetime.owner_before(other.owner_lifetime) &&
               !other.owner_lifetime.owner_before(owner_lifetime);
    }
};

DomEventTargetValue dom_target_value(Engine& engine, DomEventTarget target);

struct DomEventState {
    std::string type;
    DomEventTarget target;
    /** Window page-transition events expose the associated Document as target. */
    std::optional<DomEventTarget> target_override;
    std::optional<bool> persisted;
    std::optional<DomEventTarget> related_target;
    std::optional<DomEventTarget> current_target;
    /** Target first; detached nodes have no Document or Window ancestors. */
    std::vector<DomEventTarget> path;
    bool bubbles = true;
    bool cancelable = true;
    bool composed = true;
    bool trusted = true;
    /** `Event.timeStamp`: `performance.now()` when the event was created. */
    double time_stamp = 0.0;
    double phase = 0;
    bool passive_listener = false;
    bool propagation_stopped = false;
    bool immediate_propagation_stopped = false;
    bool dispatching = false;
    bool default_prevented = false;
    /** Set only while the owning realm invokes listeners; never transported. */
    Engine* dispatch_engine = nullptr;
    /** The realm that last dispatched the event, whose targets it keeps naming
     * once the dispatch ends (`Event.target`), while that realm lives. */
    Engine* owner_engine = nullptr;
    std::weak_ptr<const int> owner_lifetime;

    [[nodiscard]] DomEventTarget exposed_target() const { return target_override.value_or(target); }
    void stop_propagation() noexcept { propagation_stopped = true; }
    void stop_immediate_propagation() noexcept {
        propagation_stopped = true;
        immediate_propagation_stopped = true;
    }
    [[nodiscard]] bool can_prevent_default() const noexcept {
        return cancelable && !passive_listener;
    }
};

/** The clock a new event is stamped with (`Event.timeStamp`). */
using DomEventClock = double (*)();

/**
 * The platform that owns `performance.now()` installs its clock here; an
 * event created without one is stamped 0.
 */
inline DomEventClock& dom_event_clock() {
    static DomEventClock clock = nullptr;
    return clock;
}

/** The dispatch state of an event created now. */
[[nodiscard]] inline std::shared_ptr<DomEventState> new_dom_event_state() {
    auto state = std::make_shared<DomEventState>();
    if (const DomEventClock clock = dom_event_clock())
        state->time_stamp = clock();
    return state;
}

template <typename Event> DomEventState& dom_event_state(const Event& event) {
    if (!event.dom)
        throw std::logic_error("This platform callback has no DOM dispatch state.");
    return *event.dom;
}

/**
 * A payload's canceled flag. Every copy of the payload shares it, as every
 * reference to one JavaScript event does; an event made from a payload takes
 * its own (`detached`).
 */
class SharedEventFlag {
public:
    operator bool() const noexcept { return *value_; }
    SharedEventFlag& operator=(bool value) noexcept {
        *value_ = value;
        return *this;
    }
    [[nodiscard]] SharedEventFlag detached() const {
        SharedEventFlag flag;
        *flag.value_ = *value_;
        return flag;
    }
    [[nodiscard]] const void* identity() const noexcept { return value_.get(); }

private:
    std::shared_ptr<bool> value_ = std::make_shared<bool>(false);
};

/**
 * What every platform event payload carries: its DOM dispatch state while it
 * travels a DOM path, and its canceled flag. Copies of a payload share both,
 * so a copy a closure or a data structure keeps is the same event: it acts on
 * and reads the state of the dispatch, and its final state once that ends.
 */
struct PlatformEventFlags {
    mutable SharedEventFlag default_prevented;
    std::shared_ptr<DomEventState> dom{};

    void prevent_default() const noexcept {
        if (dom && !dom->can_prevent_default())
            return;
        default_prevented = true;
        if (dom)
            dom->default_prevented = true;
    }
    [[nodiscard]] bool is_default_prevented() const noexcept {
        return default_prevented || (dom && dom->default_prevented);
    }
    void stop_propagation() const { dom_event_state(*this).stop_propagation(); }
    void stop_immediate_propagation() const { dom_event_state(*this).stop_immediate_propagation(); }
    /** Event identity (`===`): the dispatch state every copy of a payload shares, else its flag. */
    [[nodiscard]] const void* identity() const noexcept {
        return dom ? static_cast<const void*>(dom.get()) : default_prevented.identity();
    }
};

[[nodiscard]] inline bool operator==(const PlatformEventFlags& left,
                                     const PlatformEventFlags& right) noexcept {
    return left.identity() == right.identity();
}

template <typename Event> Engine& dom_event_owner(const Event& event) {
    const auto& state = dom_event_state(event);
    if (state.dispatch_engine)
        return *state.dispatch_engine;
    if (!state.owner_engine || state.owner_lifetime.expired())
        throw std::logic_error("The event has no live owning document.");
    return *state.owner_engine;
}

/**
 * One dispatch of an event by the realm of `owner`, whose targets the event
 * keeps naming once the dispatch ends. Its end clears what only a dispatch
 * has: the phase, current target, path and stop flags.
 */
class DomDispatchScope {
public:
    DomDispatchScope(DomEventState& state, Engine* owner, std::weak_ptr<const int> owner_lifetime)
        : state_(state) {
        if (state.dispatching)
            throw std::logic_error("The same event is already being dispatched.");
        state.dispatching = true;
        state.dispatch_engine = owner;
        if (owner) {
            state.owner_engine = owner;
            state.owner_lifetime = std::move(owner_lifetime);
        }
    }
    DomDispatchScope(const DomDispatchScope&) = delete;
    DomDispatchScope& operator=(const DomDispatchScope&) = delete;
    ~DomDispatchScope() {
        state_.phase = 0;
        state_.current_target.reset();
        state_.path.clear();
        state_.propagation_stopped = false;
        state_.immediate_propagation_stopped = false;
        state_.dispatching = false;
        state_.dispatch_engine = nullptr;
    }

private:
    DomEventState& state_;
};

} // namespace bbl

template <> struct std::hash<bbl::DomEventTargetValue> {
    std::size_t operator()(const bbl::DomEventTargetValue& value) const noexcept {
        return std::hash<bbl::Engine*>{}(value.engine) ^
               (static_cast<std::size_t>(value.target.kind) << 32) ^ value.target.element;
    }
};
