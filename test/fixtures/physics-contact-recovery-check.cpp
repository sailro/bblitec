#include "pal_physics_bullet.cpp"
#include <iomanip>
#include <iostream>
using namespace bbl::pal;

int main() {
    std::cout << std::setprecision(17) << '[';
    bool first = true;
    for (int motion = 0; motion < 3; ++motion) {
        for (double mass : {0.1, 1.0, 10.0}) {
            for (double dt : {1.0 / 60, 1.0 / 120, 1.0 / 240}) {
                for (double depth : {0.02, 0.04, 0.1, 0.3, 0.5}) {
                    const auto world = physics_world_create();
                    physics_world_set_gravity(world, {0, 0, 0});
                    const auto shape = physics_shape_create_box({0,0,0}, {0,0,0,1}, {1,1,1});
                    std::vector<PhysicsBodyHandle> bodies;
                    for (int i = 0; i < 2; ++i) {
                        const auto body = physics_body_create();
                        physics_body_set_shape(body, shape);
                        physics_body_set_transform(body, {{i ? 1-depth : 0,0,0}, {0,0,0,1}});
                        physics_body_set_motion_type(body, i ? PhysicsMotionType::simulated : static_cast<PhysicsMotionType>(motion));
                        if (i || motion == 2) physics_body_set_mass_properties(body, physics_shape_build_mass_properties(shape, mass));
                        physics_world_add_body(world, body, false);
                        bodies.push_back(body);
                    }
                    if (!first) std::cout << ',';
                    first = false;
                    std::cout << '[';
                    for (int step = 0; step < 4; ++step) {
                        physics_world_step(world, dt);
                        if (step) std::cout << ',';
                        std::cout << '[' << physics_body_get_transform(bodies[0]).position[0] << ','
                            << physics_body_get_transform(bodies[1]).position[0] << ']';
                    }
                    std::cout << ']';
                    for (auto body : bodies) { physics_world_remove_body(world, body); physics_body_release(body); }
                    physics_world_release(world);
                }
            }
        }
    }
    std::cout << ']';
}
