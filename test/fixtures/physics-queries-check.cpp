#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iomanip>
#include <iostream>

using namespace bbl::pal;

void print(const PhysicsShapeQueryResult& value) {
    std::cout << '[' << (value.has_hit ? 1 : 0) << ',' << value.distance_or_fraction;
    for (const auto& vector : {value.input_point, value.point, value.input_normal, value.normal}) {
        for (const double component : vector) std::cout << ',' << component;
    }
    std::cout << ']';
}

int main() {
    std::cout << std::setprecision(17);
    const auto world = physics_world_create();
    physics_world_set_gravity(world, {0, 0, 0});
    const auto cylinder = physics_shape_create_cylinder({0, -1, 0}, {0, 1, 0}, .5);
    const auto capsule = physics_shape_create_capsule({0, -.5, 0}, {0, .5, 0}, .5);
    const auto body = physics_body_create();
    physics_body_set_shape(body, capsule);
    physics_body_set_motion_type(body, PhysicsMotionType::node_driven);
    physics_body_set_transform(body, {{1, 2.5, 0}, {0, 0, 0, 1}});
    physics_world_add_body(world, body, false);
    physics_world_step(world, 1.0 / 60);
    std::cout << '[';
    bool first = true;
    for (const double angle : {0.0, .2, .6, 1.1}) {
        const std::array<double, 4> rotation{0, 0, std::sin(angle / 2), std::cos(angle / 2)};
        if (!first) std::cout << ',';
        first = false;
        std::cout << '[';
        print(physics_world_shape_proximity(world, cylinder, {{-1, 2.5, 0}, rotation}, 10, false));
        std::cout << ',';
        print(physics_world_shape_cast(world, cylinder, rotation, {-1, 2.5, 0}, {4, 2.5, 0}, false, {}));
        std::cout << ']';
    }
    std::cout << "]\n";
    const PhysicsTransform pose{{-1, 2.5, 0}, {0, 0, 0, 1}};
    assert(!physics_world_shape_proximity(world, cylinder, pose, .9, false).has_hit);
    assert(!physics_world_shape_cast(world, cylinder, pose.rotation, pose.position, {4, 2.5, 0}, false, body).has_hit);
    physics_shape_set_trigger(capsule, true);
    assert(!physics_world_shape_proximity(world, cylinder, pose, 10, false).has_hit);
    assert(physics_world_shape_proximity(world, cylinder, pose, 10, true).has_hit);
    assert(!physics_world_shape_cast(world, cylinder, pose.rotation, pose.position, {4, 2.5, 0}, false, {}).has_hit);
    assert(physics_world_shape_cast(world, cylinder, pose.rotation, pose.position, {4, 2.5, 0}, true, {}).has_hit);
    physics_shape_set_filter_membership_mask(cylinder, 2);
    physics_shape_set_filter_collide_mask(capsule, 1);
    assert(!physics_world_shape_proximity(world, cylinder, pose, 10, true).has_hit);
    assert(!physics_world_shape_cast(world, cylinder, pose.rotation, pose.position, {4, 2.5, 0}, true, {}).has_hit);
    physics_world_release(world);
}
