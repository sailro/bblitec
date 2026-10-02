#pragma once

#include <bblite/features/has_ui.hpp>
#include <bblite/features/workers.hpp>
#include <bblite/pal_custom_events.hpp>

namespace bbl {

template <typename Event>
[[nodiscard]] std::shared_ptr<DomEventState> dom_event_identity(const Event& event) {
    static_cast<void>(dom_event_state(event));
    return event.dom;
}

[[nodiscard]] inline js::Nullable<std::string> input_event_data(const PlatformMouseEvent& event) {
    const auto& data = event.input_payload().input_data;
    return data ? js::Nullable<std::string>{*data} : js::Nullable<std::string>{};
}

/** Constructed input events retain their payload and identity across copies and dispatches. */
class OwnedDomEvent {
public:
    using Kind = DomInputEventKind;
    struct Payload {
        PlatformMouseEvent event;
        Engine* owner = nullptr;
        std::weak_ptr<const int> owner_lifetime;
    };
    OwnedDomEvent() = default;
    explicit OwnedDomEvent(PlatformMouseEvent event)
        : payload_(std::make_shared<Payload>(Payload{std::move(event), nullptr, {}})),
          dom(payload_->event.dom) {
        if (!dom)
            throw std::logic_error("An owned event requires DOM dispatch state.");
        if (dom->dispatch_engine)
            set_owner(*dom->dispatch_engine);
    }
    [[nodiscard]] const PlatformMouseEvent& event() const {
        if (!payload_)
            throw std::logic_error("The event has not been initialized.");
        return payload_->event;
    }
    [[nodiscard]] const PlatformMouseEvent& mouse() const { return event().mouse_payload(); }
    [[nodiscard]] js::BorrowedEvent borrowed_event() const {
        return js::BorrowedEvent(event()).retaining(payload_);
    }
    void prevent_default() const { event().prevent_default(); }
    void stop_propagation() const { event().stop_propagation(); }
    void stop_immediate_propagation() const { event().stop_immediate_propagation(); }
    [[nodiscard]] bool is_default_prevented() const { return event().is_default_prevented(); }
    [[nodiscard]] const void* identity() const { return dom.get(); }
    [[nodiscard]] bool operator==(const OwnedDomEvent& other) const {
        return identity() == other.identity();
    }
    [[nodiscard]] bool operator==(const PlatformMouseEvent& other) const {
        return dom == other.dom;
    }
    [[nodiscard]] bool operator==(const js::BorrowedEvent& other) const { return dom == other.dom; }
    void set_owner(Engine& engine) const {
        static_cast<void>(event());
        if (payload_->owner && (payload_->owner != &engine || payload_->owner_lifetime.expired()))
            throw std::logic_error("Redispatch requires the event's live owning document.");
        payload_->owner = &engine;
        payload_->owner_lifetime = engine.lifetime.token();
    }
    [[nodiscard]] js::Nullable<DomEventTargetValue> target(bool current = false) const {
        static_cast<void>(event());
        if (!payload_->owner || (current && !dom->current_target))
            return std::nullopt;
        if (payload_->owner_lifetime.expired())
            throw std::logic_error("The event's owning document has expired.");
        return dom_target_value(*payload_->owner,
                                current ? *dom->current_target : dom->exposed_target());
    }

private:
    std::shared_ptr<Payload> payload_;

public:
    std::shared_ptr<DomEventState> dom;
};

[[nodiscard]] inline OwnedDomEvent synthetic_event_from_options(std::string type,
                                                                OwnedDomEvent::Kind kind,
                                                                const js::JsonValue& options) {
    PlatformMouseEvent event;
    event.payload_kind = kind;
    event.dom = std::make_shared<DomEventState>();
    event.dom->type = std::move(type);
    event.dom->trusted = false;
    event.dom->bubbles = options.get("bubbles").truthy();
    event.dom->cancelable = options.get("cancelable").truthy();
    event.dom->composed = options.get("composed").truthy();
    const auto number = [&](const char* name, double fallback = 0) {
        const auto value = options.get(name);
        return value.is_undefined() ? fallback : value.to_number();
    };
    if (kind == OwnedDomEvent::Kind::Mouse || kind == OwnedDomEvent::Kind::Pointer) {
        event.button = js::to_int16(number("button"));
        event.buttons = js::to_uint16(number("buttons"));
        event.client_x = number("clientX");
        event.client_y = number("clientY");
        event.screen_x = number("screenX");
        event.screen_y = number("screenY");
        event.movement_x = js::to_int32(number("movementX"));
        event.movement_y = js::to_int32(number("movementY"));
        event.shift_key = options.get("shiftKey").truthy();
        event.ctrl_key = options.get("ctrlKey").truthy();
        event.alt_key = options.get("altKey").truthy();
        event.meta_key = options.get("metaKey").truthy();
    }
    if (kind == OwnedDomEvent::Kind::Pointer) {
        event.pointer_id = js::to_int32(number("pointerId"));
        const auto pointer_type = options.get("pointerType");
        event.pointer_type = pointer_type.is_undefined() ? "" : pointer_type.to_string();
        event.is_primary = options.get("isPrimary").truthy();
        const auto pressure = number("pressure");
        if (!std::isfinite(pressure) || !std::isfinite(static_cast<float>(pressure)))
            throw std::runtime_error("Pointer pressure requires a finite float.");
        event.pressure = static_cast<float>(pressure);
    }
    if (kind == OwnedDomEvent::Kind::Input) {
        const auto data = options.get("data");
        if (!data.is_null() && !data.is_undefined())
            event.input_data = data.to_string();
        const auto input_type = options.get("inputType");
        event.input_type = input_type.is_undefined() ? "" : input_type.to_string();
        event.is_composing = options.get("isComposing").truthy();
    }
    return OwnedDomEvent(std::move(event));
}

[[nodiscard]] inline bool dispatch_synthetic_event(Engine& engine, DomEventTarget target,
                                                   const OwnedDomEvent& event) {
    static_cast<void>(event.event());
    if (event.dom->dispatching)
        throw std::logic_error("The same event is already being dispatched.");
    static constexpr std::string_view represented[] = {"click",
                                                       "dblclick",
                                                       "mousedown",
                                                       "mouseup",
                                                       "mousemove",
                                                       "mouseover",
                                                       "mouseout",
                                                       "mouseenter",
                                                       "mouseleave",
                                                       "pointerdown",
                                                       "pointerup",
                                                       "pointermove",
                                                       "pointerover",
                                                       "pointerout",
                                                       "pointerenter",
                                                       "pointerleave",
                                                       "pointercancel",
                                                       "gotpointercapture",
                                                       "lostpointercapture",
                                                       "wheel",
                                                       "focus",
                                                       "blur",
                                                       "contextmenu",
                                                       "resize",
                                                       "beforeinput",
                                                       "input",
                                                       "change"};
    if (std::find(std::begin(represented), std::end(represented), event.dom->type) ==
        std::end(represented))
        throw std::runtime_error("Synthetic dispatch does not represent this event channel.");
    event.dom->trusted = false;
    event.set_owner(engine);
    event.dom->target = target;
    switch (target.kind) {
    case DomEventTargetKind::Window:
        event.dom->path = {target};
        break;
    case DomEventTargetKind::Document:
        event.dom->path = {target, DomEventTarget::window()};
        break;
    case DomEventTargetKind::Canvas:
        event.dom->path = dom_canvas_path();
        break;
    case DomEventTargetKind::Element:
#if BBLITE_HAS_UI
        event.dom->path = dom_ui_path(engine, UiElementHandle{target.element});
        break;
#else
        throw std::logic_error("Element dispatch requires retained UI.");
#endif
    }
    dom_input(engine).pointer.dispatch(
        event.event(),
        [](auto& callback, const auto& value) {
#if BBLITE_WORKERS
            pal::EventLoop::current().dispatch_synchronous_callback([&] { callback(value); });
#else
            callback(value);
#endif
        },
        &engine);
    return !event.is_default_prevented();
}

} // namespace bbl
