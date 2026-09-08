#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iostream>

using namespace bbl::pal;

int main() {
    auto world = physics_world_create();
    physics_world_set_gravity(world, {0, -9.8, 0});
    auto mesh = physics_shape_create_mesh(
        {{-0.5,-0.5,-0.5}, {0.5,-0.5,-0.5}, {0.5,0.5,-0.5}, {-0.5,0.5,-0.5},
         {-0.5,-0.5,0.5}, {0.5,-0.5,0.5}, {0.5,0.5,0.5}, {-0.5,0.5,0.5}},
        {0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
         3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5});
    std::weak_ptr<PhysicsShapeState> retained = mesh.ownership;
    const auto stationary = physics_body_create();
    physics_body_set_shape(stationary, mesh);
    physics_body_set_transform(stationary, {{5, 0.5, 0}});
    physics_world_add_body(world, stationary, false);
    const auto moving = physics_body_create();
    physics_body_set_motion_type(moving, PhysicsMotionType::simulated);
    physics_body_set_shape(moving, mesh);
    auto mass = physics_shape_build_mass_properties(mesh, 1);
    for (const double inertia : mass.inertia) assert(std::isfinite(inertia) && inertia > 0);
    physics_body_set_mass_properties(moving, mass);
    physics_body_set_transform(moving, {{0, 4, 0}});
    physics_world_add_body(world, moving, false);
    const auto floor = physics_body_create();
    physics_body_set_shape(floor, physics_shape_create_box({0, -0.5, 0}, {0,0,0,1}, {20,1,20}));
    physics_world_add_body(world, floor, false);
    mesh = {};
    for (int i = 0; i < 240; ++i) physics_world_step(world, 1.0 / 60);
    const auto landed = physics_body_get_transform(moving);
    assert(landed.position[1] > 0.4 && landed.position[1] < 0.65);
    assert(physics_body_get_transform(stationary).position[1] == 0.5);
    assert(!retained.expired());

    // Motion changes preserve an authored mass frame and node pose.
    mass.center_of_mass = {0.1, 0.1, 0};
    physics_body_set_mass_properties(moving, mass);
    const auto before = physics_body_get_transform(moving);
    physics_body_set_motion_type(moving, PhysicsMotionType::immovable);
    physics_body_set_motion_type(moving, PhysicsMotionType::simulated);
    const auto after = physics_body_get_transform(moving);
    for (int i = 0; i < 3; ++i) assert(std::abs(before.position[i] - after.position[i]) < 0.00001);
    physics_world_step(world, 1.0 / 60);
    physics_world_release(world);
    assert(!retained.expired());
    std::cout << "physics-dynamic-mesh-check: ok\n";
}
