#include "recovery.hpp"
#include <cassert>
#include <cstdio>

namespace bbl::pal { std::string environment_variable(const char*) { return {}; } }

template <typename F> void must_throw(F function) {
    bool threw = false;
    try { function(); } catch (const std::exception&) { threw = true; }
    assert(threw);
}

int main() {
    bbl::Engine engine;
    must_throw([&] { bbl::force_device_loss(engine); });
    must_throw([&] { bbl::fallback_texture_identity(engine); });
    const auto old_device = bbl::gpu_device_identity(engine);
    auto first = bbl::enable_device_lost_scene_recovery(engine);
    auto disabled = bbl::enable_device_lost_scene_recovery(engine);
    int lost = 0, recovered = 0, failed = 0, errors = 0;
    disabled->on_lost = [] { assert(false); };
    bbl::disable_device_recovery(disabled);
    bbl::disable_device_recovery(disabled);
    assert(engine.device_recovery->registrations.size() == 1);
    first->on_lost = [&] { ++lost; bbl::disable_device_recovery(first); };
    first->on_recovered = [&] { ++recovered; };
    bbl::add_gpu_error_listener(old_device, [&](const std::string& error) { assert(error == "old"); ++errors; });
    bbl::report_gpu_error(engine, "old");
    assert(errors == 1);
    bbl::force_device_loss(engine);
    bbl::begin_device_recovery(engine);
    assert(lost == 1 && recovered == 0 && !engine.stopped);
    assert(old_device != bbl::gpu_device_identity(engine));
    bbl::report_gpu_error(engine, "new");
    assert(errors == 1);
    bbl::complete_device_recovery(engine);
    assert(recovered == 0);
    engine.device_recovery->resources_ready = true;
    bbl::complete_device_recovery(engine);
    bbl::complete_device_recovery(engine);
    assert(recovered == 1);
    must_throw([&] { bbl::force_device_loss(engine); });

    auto next = bbl::enable_device_lost_scene_recovery(engine);
    next->on_failed = [&](const std::string& error) { assert(error == "rebuild failed"); ++failed; };
    next->on_lost = [&] { engine.stopped = true; };
    bbl::force_device_loss(engine);
    bbl::begin_device_recovery(engine);
    assert(engine.stopped);
    bbl::fail_device_recovery(engine, "rebuild failed");
    assert(failed == 1 && engine.stopped && !engine.device_recovery->recovering);
    bbl::set_canvas_dataset(engine, "flag", "true");
    assert(bbl::canvas_dataset(engine, "flag") == "true");
    bbl::set_global_callback(engine, "dispose", [&] { bbl::dispose_engine(engine); });
    engine.device_recovery->globals.at("dispose")();
    assert(engine.stopped && !engine.renderer_restart_requested);
    must_throw([&] { bbl::enable_device_lost_scene_recovery(engine); });
    std::puts("device-recovery: ok");
}
