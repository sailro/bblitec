#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>

#include <cassert>
#include <iostream>

int main() {
    bbl::Engine engine;
    engine.shadow_generators.emplace_back();
    const bbl::ShadowGeneratorHandle generator{0};
    assert(!engine.shadow_generators[0].csm_receiver_callbacks);

    auto payload = std::make_shared<int>(7);
    const std::weak_ptr<int> weak_payload = payload;
    int calls = 0;
    auto dispose = bbl::on_csm_receiver_update(
        engine, generator,
        [payload, &calls](const bbl::js::F32Array&) { calls += *payload; });
    const auto registry = engine.shadow_generators[0].csm_receiver_callbacks;
    payload.reset();
    assert(!weak_payload.expired());
    const bbl::js::F32Array values(4);
    registry->dispatch(values);
    assert(calls == 7);
    dispose();
    dispose();
    assert(registry->empty());
    assert(weak_payload.expired());

    std::function<void()> dispose_self;
    dispose_self = bbl::on_csm_receiver_update(
        engine, generator, [&](const bbl::js::F32Array&) {
            ++calls;
            dispose_self();
        });
    registry->dispatch(values);
    registry->dispatch(values);
    assert(calls == 8);
    assert(registry->empty());

    auto detached = bbl::on_csm_receiver_update(
        engine, generator, [](const bbl::js::F32Array&) {});
    engine.shadow_generators.clear();
    detached();
    assert(registry->empty());

    std::function<void()> after_destruction;
    {
        bbl::Engine temporary;
        temporary.shadow_generators.emplace_back();
        after_destruction = bbl::on_csm_receiver_update(
            temporary, generator, [](const bbl::js::F32Array&) {});
    }
    after_destruction();

    std::weak_ptr<bbl::SceneState> weak_scene;
    {
        bbl::Scene scene;
        weak_scene = scene.state;
        bbl::Scene alias = bbl::Scene::from_state(weak_scene.lock());
        assert(alias.shares_identity(scene));
        alias.render_topology_version = 9;
        assert(scene.render_topology_version == 9);
    }
    assert(weak_scene.expired());
    std::cout << "csm-subscription-check: ok\n";
}
