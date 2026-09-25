#include "recovery.hpp"
#include <cassert>
#include <cstdio>

namespace bbl::pal {
std::string environment_variable(const char*) { return {}; }
} // namespace bbl::pal

template <typename F> void must_throw(F function) {
    bool threw = false;
    try {
        function();
    } catch (const std::exception&) {
        threw = true;
    }
    assert(threw);
}

void mixed_contexts() {
    using namespace bbl;
    Engine engine;
    auto scene = std::make_shared<Scene>();
    std::weak_ptr<Scene> lifetime = scene;
    FrameGraphContext graph;
    engine.rendering_contexts.push_back("effect-renderer", EffectRendererHandle{7});
    engine.rendering_contexts.push_back("scene", scene);
    engine.rendering_contexts.push_back("text-renderer", TextRenderer{});
    engine.rendering_contexts.push_back("sprite-renderer", SpriteRendererHandle{7});
    engine.rendering_contexts.push_back("frame-graph-context", &graph);
    assert(engine.rendering_contexts.size() == 5);
    assert(engine.rendering_contexts[0].kind == "effect-renderer");
    assert(engine.rendering_contexts[2].kind == "text-renderer");
    assert(engine.rendering_contexts.index_of(SpriteRendererHandle{7}) == 3);
    assert(engine.rendering_contexts.index_of(EffectRendererHandle{7}) == 0);
    assert(engine.rendering_contexts.index_of(EffectRendererHandle{8}) == -1);
    assert(engine.scenes().front() == scene);
    assert(engine.text_renderer_contexts().size() == 1);
    assert(engine.frame_graph_contexts().front() == &graph);
    std::vector<std::shared_ptr<DeviceRecoveryRegistration>> handlers;
    for (const auto& entry : engine.rendering_contexts) {
        auto registration = std::make_shared<DeviceRecoveryRegistration>();
        registration->kind = entry.kind;
        handlers.push_back(registration);
    }
    assert_every_active_context_kind_is_recoverable(engine, handlers);
    handlers.erase(handlers.begin() + 2);
    must_throw([&] { assert_every_active_context_kind_is_recoverable(engine, handlers); });
    engine.rendering_contexts.erase_at(2);
    assert_every_active_context_kind_is_recoverable(engine, handlers);
    {
        const auto scenes = engine.scenes();
        const auto contexts = engine.rendering_contexts;
        engine.rendering_contexts.erase_if<std::shared_ptr<Scene>>(
            [&](const auto& candidate) { return candidate == scene; });
        assert(engine.scenes().empty());
        assert(scenes.size() == 1 && scenes.front() == scene);
        assert(contexts.size() == 4 && contexts[1].kind == "scene");
        scene.reset();
        assert(!lifetime.expired());
    }
    assert(lifetime.expired());
    engine.rendering_contexts.push_back("custom-scene-kind", std::make_shared<Scene>());
    must_throw([&] { assert_every_active_context_kind_is_recoverable(engine, handlers); });
    pal::unconfigure_engine_surfaces(engine);
    assert(engine.rendering_contexts.empty());
}

int main() {
    mixed_contexts();
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
    first->on_lost = [&] {
        ++lost;
        bbl::disable_device_recovery(first);
    };
    first->on_recovered = [&] { ++recovered; };
    bbl::add_gpu_error_listener(old_device, [&](const std::string& error) {
        assert(error == "old");
        ++errors;
    });
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
    next->on_failed = [&](const std::string& error) {
        assert(error == "rebuild failed");
        ++failed;
    };
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
