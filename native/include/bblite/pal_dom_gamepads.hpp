#pragma once

#include <bblite/features/has_gamepad.hpp>
#include <bblite/features/workers.hpp>
#include <bblite/pal_dom_events.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_event_loop.hpp>
#endif

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>

namespace bbl {

/** A GamepadEvent: the gamepad that connected or disconnected. */
struct PlatformGamepadEvent {
    GamepadHandle gamepad{};
    mutable bool default_prevented = false;
    std::shared_ptr<DomEventState> dom{};

    void prevent_default() const noexcept {
        if (dom && !dom->can_prevent_default())
            return;
        default_prevented = true;
    }
    void stop_propagation() const { dom_event_state(*this).stop_propagation(); }
    void stop_immediate_propagation() const { dom_event_state(*this).stop_immediate_propagation(); }
};

#if BBLITE_WORKERS && BBLITE_HAS_GAMEPAD
inline bool on_dom_gamepad(Engine& engine, DomEventTarget target, std::string type,
                           std::size_t identity,
                           DomEventListeners<PlatformGamepadEvent>::Callback callback,
                           bool capture = false, bool once = false, bool passive = false,
                           ListenerLeasePtr lease = {}) {
    return dom_input(engine).gamepad.add(target, std::move(type), identity, std::move(callback),
                                         capture, once, passive, std::move(lease));
}

inline void off_dom_gamepad(Engine& engine, DomEventTarget target, std::string type,
                            std::size_t identity, bool capture = false) {
    if (engine.dom_input)
        engine.dom_input->gamepad.remove(target, std::move(type), identity, capture);
}

/**
 * The document's gamepad task source, started once: every 16 ms a task fires
 * each change in the gamepads `navigator.getGamepads()` reads from `gamepads`
 * at the Window, disconnections first. It ends with that engine.
 */
inline void watch_dom_gamepads(Engine& document, Engine& gamepads) {
    auto& input = dom_input(document);
    if (input.gamepads_watched)
        return;
    input.gamepads_watched = true;
    struct Source {
        std::weak_ptr<const int> lifetime;
        std::vector<GamepadHandle> announced;
        pal::EventLoop::TimerId timer = 0;
    };
    const auto source = std::make_shared<Source>();
    source->lifetime = gamepads.lifetime.token();
    auto& loop = pal::EventLoop::current();
    source->timer = loop.set_timeout(
        [&document, &gamepads, source] {
            auto& input = dom_input(document);
            if (source->lifetime.expired()) {
                input.gamepads_watched = false;
                pal::EventLoop::current().clear_timer(source->timer);
                return;
            }
            std::vector<GamepadHandle> present;
            for (const auto& pad : platform_gamepads(gamepads))
                if (pad)
                    present.push_back(*pad);
            const auto previous = std::exchange(source->announced, present);
            const auto fire = [&](GamepadHandle pad, const char* type) {
                const auto event = dom_event(PlatformGamepadEvent{.gamepad = pad}, type,
                                             {DomEventTarget::window()}, false, false);
                input.gamepad.dispatch(
                    event,
                    [](auto& callback, const auto& payload) {
                        pal::EventLoop::current().dispatch_callback([&] { callback(payload); });
                    },
                    &document);
            };
            for (const auto pad : previous)
                if (std::ranges::find(present, pad) == present.end())
                    fire(pad, "gamepaddisconnected");
            for (const auto pad : present)
                if (std::ranges::find(previous, pad) == previous.end())
                    fire(pad, "gamepadconnected");
        },
        16, true);
}
#endif

} // namespace bbl
