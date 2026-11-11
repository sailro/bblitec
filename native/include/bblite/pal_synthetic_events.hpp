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
        /** A constructed KeyboardEvent's keys; `event` then carries the DOM state they share. */
        std::optional<PlatformKeyboardEvent> keyboard{};
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
    /** This event carrying a constructed KeyboardEvent's keys. */
    [[nodiscard]] OwnedDomEvent with_keyboard(PlatformKeyboardEvent keyboard) const {
        static_cast<void>(event());
        keyboard.dom = dom;
        payload_->keyboard = std::move(keyboard);
        return *this;
    }
    /** The keys of a constructed KeyboardEvent, else null. */
    [[nodiscard]] const PlatformKeyboardEvent* keyboard() const {
        static_cast<void>(event());
        return payload_->keyboard ? &*payload_->keyboard : nullptr;
    }
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

/**
 * An init holding members its event's dictionary declares but the native event does not
 * represent (`unrepresented`): one present refuses, as generation refuses one it sees.
 */
[[nodiscard]] inline js::JsonValue
require_event_options(js::JsonValue options, std::string_view event,
                      std::initializer_list<std::string_view> unrepresented) {
    if (options.is_null() || options.is_undefined())
        return options;
    for (const auto key : unrepresented)
        if (!options.get(key).is_undefined())
            throw std::runtime_error(std::string(event) + " option '" + std::string(key) +
                                     "' is not represented.");
    return options;
}

/** The modifier keys an event's init dictionary gives. */
inline void read_modifier_keys(PlatformModifierKeys& keys, const js::JsonValue& options) {
    keys.shift_key = options.get("shiftKey").truthy();
    keys.ctrl_key = options.get("ctrlKey").truthy();
    keys.alt_key = options.get("altKey").truthy();
    keys.meta_key = options.get("metaKey").truthy();
}

/** A string member of an event's init dictionary; one it does not give is the empty string. */
[[nodiscard]] inline std::string init_text(const js::JsonValue& options, const char* name) {
    const auto value = options.get(name);
    return value.is_undefined() ? std::string{} : value.to_string();
}

[[nodiscard]] inline OwnedDomEvent synthetic_event_from_options(std::string type,
                                                                OwnedDomEvent::Kind kind,
                                                                const js::JsonValue& options) {
    PlatformMouseEvent event;
    event.payload_kind = kind;
    event.dom = new_dom_event_state();
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
        // The target the pointer left or entered, as the options document boxes it.
        const auto related = options.get("relatedTarget");
        if (related.instance_of<DomEventTargetValue>())
            event.dom->related_target = related.asserted_instance<DomEventTargetValue>().target;
        else if (!related.is_null() && !related.is_undefined())
            throw js::NamedError("TypeError", "relatedTarget requires an EventTarget or null.");
        event.button = js::to_int16(number("button"));
        event.buttons = js::to_uint16(number("buttons"));
        event.client_x = number("clientX");
        event.client_y = number("clientY");
        event.screen_x = number("screenX");
        event.screen_y = number("screenY");
        event.movement_x = js::to_int32(number("movementX"));
        event.movement_y = js::to_int32(number("movementY"));
        read_modifier_keys(event, options);
    }
    if (kind == OwnedDomEvent::Kind::Pointer) {
        event.pointer_id = js::to_int32(number("pointerId"));
        event.pointer_type = init_text(options, "pointerType");
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
        event.input_type = init_text(options, "inputType");
        event.is_composing = options.get("isComposing").truthy();
    }
    return OwnedDomEvent(std::move(event));
}

/** `new KeyboardEvent(type, init)`: the base event with the keys its init dictionary gives. */
[[nodiscard]] inline OwnedDomEvent
synthetic_keyboard_event_from_options(std::string type, const js::JsonValue& options) {
    PlatformKeyboardEvent keyboard;
    keyboard.key = init_text(options, "key");
    keyboard.code = init_text(options, "code");
    const auto location = options.get("location");
    keyboard.location = location.is_undefined() ? 0u : js::to_uint32(location.to_number());
    keyboard.repeat = options.get("repeat").truthy();
    keyboard.is_composing = options.get("isComposing").truthy();
    read_modifier_keys(keyboard, options);
    return synthetic_event_from_options(std::move(type), OwnedDomEvent::Kind::Event, options)
        .with_keyboard(std::move(keyboard));
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
    // A constructed KeyboardEvent reaches the key listeners, any other event the pointer family's.
    static constexpr std::string_view keys[] = {"keydown", "keyup"};
    const PlatformKeyboardEvent* keyboard = event.keyboard();
    if (keyboard ? std::find(std::begin(keys), std::end(keys), event.dom->type) == std::end(keys)
                 : std::find(std::begin(represented), std::end(represented), event.dom->type) ==
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
    const auto invoke = [](auto& callback, const auto& value) {
#if BBLITE_WORKERS
        pal::EventLoop::current().dispatch_synchronous_callback([&] { callback(value); });
#else
        callback(value);
#endif
    };
    if (keyboard)
        dom_input(engine).keyboard.dispatch(*keyboard, invoke, &engine);
    else
        dom_input(engine).pointer.dispatch(event.event(), invoke, &engine);
    return !event.is_default_prevented();
}

} // namespace bbl
