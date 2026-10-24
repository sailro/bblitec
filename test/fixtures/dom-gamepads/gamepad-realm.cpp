// A Window realm whose navigator reports one gamepad for its first three
// polls, then none: the realm's gamepad task source sees it connect and leave.
#include <bblite/pal_async_engine.hpp>
#include <bblite/pal_window_realm.hpp>

namespace {
bbl::Engine document;
std::shared_ptr<bbl::Engine> renderer;
int polls = 0;
} // namespace

namespace bbl {
js::Array<js::Nullable<GamepadHandle>> platform_gamepads(Engine& engine) {
    if (&engine != renderer.get())
        throw std::logic_error("Gamepads belong to the entry engine.");
    js::Array<js::Nullable<GamepadHandle>> pads;
    if (++polls <= 3)
        pads.push_back(GamepadHandle{7, 0});
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
    loop.run([&] { initialize(realm); });
    renderer.reset();
    return polls >= 4 ? 0 : 1;
}
} // namespace bbl::pal
