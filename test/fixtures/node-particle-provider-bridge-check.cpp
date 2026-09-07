#include <bblite/upstream/node_particles.hpp>
#include <bblite/pal_image.hpp>
#include <cassert>
#include <iostream>

// Only image I/O is stubbed. Particle sampling/simulation, the registrar,
// billboard storage and atlas construction are generated from the pin.
namespace bbl {
std::string asset_path(const std::string& path) { return path; }
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string&) { return {}; }
DecodedImage decode_image(const js::ArrayBuffer&) { return {64, 64, {}}; }
}
}

int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine;
    Scene scene;
    scene.engine = &engine;
    js::F32Array matrix{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const auto calls = js::make_gc_shared<int>(0);
    {
        js::Callback<js::F32Array()> provider = js::make_closure(std::make_tuple(matrix, calls), [](auto& env) {
            ++*std::get<1>(env);
            return std::get<0>(env);
        });
        const auto snapshot = sample_node_particle_emitter(provider);
        matrix[12] = 3.0f;
        initialize_native_node_particle_set(0, provider, snapshot);
        assert(*calls == 1);
        animate_native_node_particle_system(0, 0, 1);
        assert(*calls == 1); // Unstarted systems do not sample.
    }
    js::collect_cycles(); // Only native simulation storage retains the callback.
    if (!AUTO_START) {
        start_native_node_particle_system(0, 0);
        for (int frame = 0; frame < 120; ++frame) animate_native_node_particle_system(0, 0, 1);
        set_native_node_particle_scalar(0, 0, "updateSpeed", 0);
    }
    const auto before = native_node_particle_alive(0, 0);
    const int samples_before_registration = *calls;
    register_node_particle_set(engine, scene, 0);
    assert(*calls == samples_before_registration);
    assert(scene.billboard_systems.size() == 1 && scene.before_render.size() == 1);
    auto& billboard = engine.billboard_systems[scene.billboard_systems[0].value];
    assert(billboard.count == 0); // The pin first syncs from its frame callback.
    scene.before_render[0](0);
    assert(*calls == samples_before_registration + 1);
    assert(native_node_particle_capacity(0, 0) == 640);
    assert(billboard.count == native_node_particle_alive(0, 0));
    assert(AUTO_START ? billboard.count > before : billboard.count == before);
    assert(billboard.count > 0 && billboard.instance_data[0] > 2.0f);
    const auto frozen = billboard.instance_data;
    set_native_node_particle_scalar(0, 0, "updateSpeed", 0);
    scene.before_render[0](0);
    assert(billboard.instance_data == frozen);
    stop_native_node_particle_system(0, 0);
    scene.before_render[0](0);
    assert(*calls == samples_before_registration + 3); // Stopping prevents births, not provider sampling.
    clear_billboard_sprites(engine, scene.billboard_systems[0]);
    scene.before_render[0](0);
    assert(billboard.count == native_node_particle_alive(0, 0));
    assert(billboard.instance_data == frozen);
    std::cout << "provider-bridge-check: ok\n";
}
