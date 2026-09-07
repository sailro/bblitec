#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>
#include <iomanip>
#include <iostream>

// This timing fixture never needs mesh geometry aggregation.
namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
}

int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    for (const bool fixed : {true, false}) {
        for (const int fps : {60, 240}) {
            Engine engine;
            Scene scene;
            scene.engine = &engine;
            scene.fixed_delta_ms = fixed ? 1000.0 / 60 : 0;
            const auto world = create_havok_world(scene, {0, 0, 0});
            set_physics_timestep_ms(world, fixed ? (1000.0 / 60 / 8) * 6 : 0);
            const auto native_world = world.ownership.lock()->handle;
            const auto shape = pal::physics_shape_create_sphere({0, 0, 0}, 0.5);
            const auto body = pal::physics_body_create();
            pal::physics_body_set_shape(body, shape);
            pal::physics_body_set_motion_type(body, pal::PhysicsMotionType::simulated);
            pal::physics_body_set_mass_properties(body, pal::physics_shape_build_mass_properties(shape, 1));
            pal::physics_world_add_body(native_world, body, false);
            pal::physics_body_set_linear_velocity(body, {1, 0, 0});
            double simulated_seconds = 0;
            int calls = 0;
            on_physics_after_step(world, [&](float seconds) {
                simulated_seconds += seconds;
                ++calls;
            });
            for (int frame = 0; frame < fps; ++frame) {
                const double delta = scene.fixed_delta_ms > 0 ? scene.fixed_delta_ms : 1000.0 / fps;
                for (const auto& callback : scene.before_render) callback(static_cast<float>(delta));
            }
            const double distance = pal::physics_body_get_transform(body).position[0];
            const double expected = fixed ? fps * 0.0125 : 1;
            assert(calls == fps);
            assert(std::abs(simulated_seconds - expected) < 1e-6);
            assert(std::abs(distance - expected) < 1e-5);
            std::cout << (fixed ? "fixed" : "variable") << ' ' << fps << ' '
                      << calls << ' ' << std::setprecision(12)
                      << simulated_seconds << ' ' << distance << '\n';
        }
    }
}
