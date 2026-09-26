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
    double phase = 0;
    bool passive_listener = false;
    bool propagation_stopped = false;
    bool immediate_propagation_stopped = false;
    bool dispatching = false;
    /** Set only while the owning realm invokes listeners; never transported. */
    Engine* dispatch_engine = nullptr;

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

template <typename Event> DomEventState& dom_event_state(const Event& event) {
    if (!event.dom)
        throw std::logic_error("This platform callback has no DOM dispatch state.");
    return *event.dom;
}

template <typename Event> Engine& dom_event_owner(const Event& event) {
    const auto* owner = dom_event_state(event).dispatch_engine;
    if (!owner)
        throw std::logic_error("The event has no active owning document.");
    return *dom_event_state(event).dispatch_engine;
}

} // namespace bbl

template <> struct std::hash<bbl::DomEventTargetValue> {
    std::size_t operator()(const bbl::DomEventTargetValue& value) const noexcept {
        return std::hash<bbl::Engine*>{}(value.engine) ^
               (static_cast<std::size_t>(value.target.kind) << 32) ^ value.target.element;
    }
};
