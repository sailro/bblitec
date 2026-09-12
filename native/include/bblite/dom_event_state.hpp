#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace bbl {

enum class DomEventTargetKind { Window, Document, Canvas, Element };

/** Native identities only: event paths can cross the Window mailbox. */
struct DomEventTarget {
    DomEventTargetKind kind = DomEventTargetKind::Window;
    std::uint32_t element = 0;
    static DomEventTarget window() { return {}; }
    static DomEventTarget document() { return {DomEventTargetKind::Document, {}}; }
    static DomEventTarget canvas() { return {DomEventTargetKind::Canvas, {}}; }
    static DomEventTarget node(std::uint32_t element) { return {DomEventTargetKind::Element, element}; }
    [[nodiscard]] bool operator==(const DomEventTarget&) const = default;
};

struct DomEventState {
    std::string type;
    DomEventTarget target;
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

    void stop_propagation() noexcept { propagation_stopped = true; }
    void stop_immediate_propagation() noexcept {
        propagation_stopped = true;
        immediate_propagation_stopped = true;
    }
    [[nodiscard]] bool can_prevent_default() const noexcept { return cancelable && !passive_listener; }
};

} // namespace bbl
