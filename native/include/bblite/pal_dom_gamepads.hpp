#pragma once

#include <bblite/features/has_gamepad.hpp>
#include <bblite/pal_dom_events.hpp>

#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace bbl {

#if BBLITE_HAS_GAMEPAD
/** The display learns the type, so the gamepads it announces reach the document. */
inline bool on_dom_gamepad(Engine& engine, DomEventTarget target, std::string type,
                           std::size_t identity,
                           DomEventListeners<PlatformGamepadEvent>::Callback callback,
                           bool capture = false, bool once = false, bool passive = false,
                           ListenerLeasePtr lease = {}) {
    return listen_dom_type(engine, type)
        .gamepad.add(target, std::move(type), identity, std::move(callback), capture, once, passive,
                     std::move(lease));
}

inline void off_dom_gamepad(Engine& engine, DomEventTarget target, std::string type,
                            std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->gamepad.remove(target, std::move(type), identity, capture);
}

/**
 * The document's gamepad task source: gamepadconnected or gamepaddisconnected
 * at the Window for each connection the platform announces
 * (pal_platform_events.hpp) whose type the document listens to; empty when
 * none is.
 */
[[nodiscard]] inline std::shared_ptr<DomEventBatch>
dom_gamepad_input(Engine& document, const std::vector<GamepadConnection>& connections) {
    std::shared_ptr<DomEventBatch> batch;
    for (const auto& connection : connections) {
        const char* type = connection.connected ? "gamepadconnected" : "gamepaddisconnected";
        if (!document.dom_input || !document.dom_input->event_types.contains(type))
            continue;
        if (!batch)
            batch = std::make_shared<DomEventBatch>();
        batch->add(dom_event(PlatformGamepadEvent{.gamepad = connection.gamepad}, type,
                             {DomEventTarget::window()}, false, false));
    }
    return batch;
}
#endif

} // namespace bbl
