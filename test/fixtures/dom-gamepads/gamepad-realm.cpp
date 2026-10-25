// A Window realm whose display announces one gamepad connecting, then
// leaving: the realm's document fires gamepadconnected and
// gamepaddisconnected at the Window, and getGamepads reports the pad between.
#include <bblite/pal_async_engine.hpp>
#include <bblite/pal_dom_gamepads.hpp>
#include <bblite/pal_window_realm.hpp>

namespace {
bbl::Engine document;
std::shared_ptr<bbl::Engine> renderer;
bool connected = false;
constexpr bbl::GamepadHandle pad{7, 0};
} // namespace

namespace bbl {
js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine) {
    if (&engine != renderer.get())
        throw std::logic_error("Gamepads belong to the entry engine.");
    js::Array<js::Nullable<GamepadHandle>> pads;
    if (connected)
        pads.push_back(pad);
    return pads;
}
double gamepad_index(Engine&, GamepadHandle gamepad) { return gamepad.index; }
} // namespace bbl

namespace bbl::pal {
Engine& window_document_engine() { return document; }

std::shared_ptr<Engine> create_realm_engine(EngineOptions,
                                            const std::shared_ptr<OffscreenCanvas>&) {
    renderer = std::make_shared<Engine>();
    return renderer;
}

int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.on_error([](std::exception_ptr error) { std::rethrow_exception(error); });
    // The display's announcements, as its device events post them to the document.
    const auto announce = [](bool now) {
        connected = now;
        if (const auto batch = dom_gamepad_input(document, {GamepadConnection{pad, now}}))
            dispatch_dom_batch(document, batch);
    };
    loop.run([&] {
        initialize(realm);
        loop.set_timeout([&] { announce(true); }, 50);
        loop.set_timeout([&] { announce(false); }, 100);
    });
    renderer.reset();
    return 0;
}
} // namespace bbl::pal
