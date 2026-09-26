#pragma once

#include <bblite/js_json.hpp>
#include <bblite/features/workers.hpp>
#include <bblite/pal_dom_events.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_event_loop.hpp>
#endif

namespace bbl {

/** An explicitly constructed DOM event owns its payload and dispatch identity.
 * JSON views retain the source record/array; copying an event does not clone detail. */
struct PlatformCustomEvent {
    struct Payload {
        js::JsonValue detail = js::JsonValue::null_value();
        bool canceled = false;
        Engine* owner = nullptr;
        std::weak_ptr<const int> owner_lifetime;
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(detail); }
    };
    std::shared_ptr<DomEventState> dom = std::make_shared<DomEventState>();
    std::shared_ptr<Payload> payload = js::make_gc_shared<Payload>();

    [[nodiscard]] js::JsonValue detail() const { return payload->detail; }
    [[nodiscard]] bool is_default_prevented() const noexcept { return payload->canceled; }
    void prevent_default() const noexcept {
        if (dom->can_prevent_default()) payload->canceled = true;
    }
    void stop_propagation() const { dom->stop_propagation(); }
    void stop_immediate_propagation() const { dom->stop_immediate_propagation(); }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(payload); }
    [[nodiscard]] bool operator==(const PlatformCustomEvent& other) const {
        return payload == other.payload;
    }
};

[[nodiscard]] inline PlatformCustomEvent create_custom_event(
    std::string type, js::JsonValue detail = js::JsonValue::null_value(),
    bool bubbles = false, bool cancelable = false, bool composed = false) {
    PlatformCustomEvent event;
    event.dom->type = std::move(type);
    event.dom->bubbles = bubbles;
    event.dom->cancelable = cancelable;
    event.dom->composed = composed;
    event.dom->trusted = false;
    event.payload->detail = std::move(detail);
    return event;
}

[[nodiscard]] inline PlatformCustomEvent custom_event_from_options(std::string type,
                                                                  const js::JsonValue& options) {
    if (options.is_null() || options.is_undefined()) return create_custom_event(std::move(type));
    auto detail = options.get("detail");
    if (detail.is_undefined()) detail = js::JsonValue::null_value();
    return create_custom_event(std::move(type), std::move(detail), options.get("bubbles").truthy(),
                               options.get("cancelable").truthy(), options.get("composed").truthy());
}

inline void on_dom_custom(Engine& engine, DomEventTarget target, std::string type,
                         std::size_t identity,
                         DomEventListeners<PlatformCustomEvent>::Callback callback,
                         bool capture = false, bool once = false, bool passive = false) {
    dom_input(engine).custom.add(target, std::move(type), identity, std::move(callback),
                                capture, once, passive);
}

inline void off_dom_custom(Engine& engine, DomEventTarget target, std::string type,
                          std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->custom.remove(target, std::move(type), identity, capture);
}

[[nodiscard]] inline js::Nullable<DomEventTargetValue> custom_event_target(
    const PlatformCustomEvent& event, bool current = false) {
    if (!event.payload->owner) return std::nullopt;
    if (current && !event.dom->current_target) return std::nullopt;
    if (event.payload->owner_lifetime.expired())
        throw std::logic_error("The custom event's owning document has expired.");
    if (current) return dom_target_value(*event.payload->owner, event.dom->current_target);
    return dom_target_value(*event.payload->owner, event.dom->exposed_target());
}

[[nodiscard]] inline bool dispatch_custom_event(Engine& engine, DomEventTarget target,
                                               const PlatformCustomEvent& event) {
    if (event.dom->dispatching)
        throw std::logic_error("The same event is already being dispatched.");
    if (target.kind != DomEventTargetKind::Document && target.kind != DomEventTargetKind::Window)
        throw std::logic_error("Custom event dispatch requires a Document or Window target.");
    event.payload->owner = &engine;
    event.payload->owner_lifetime = engine.lifetime.token();
    event.dom->target = target;
    event.dom->path = target.kind == DomEventTargetKind::Document
        ? std::vector<DomEventTarget>{target, DomEventTarget::window()}
        : std::vector<DomEventTarget>{target};
    dom_input(engine).custom.dispatch(event, [](auto& callback, const auto& value) {
#if BBLITE_WORKERS
        pal::EventLoop::current().dispatch_synchronous_callback([&] { callback(value); });
#else
        callback(value);
#endif
    }, &engine);
    return !event.is_default_prevented();
}

} // namespace bbl
