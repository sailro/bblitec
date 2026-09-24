#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iostream>

namespace bbl::pal {
PhysicsDebugShapeDescriptor observed;
PhysicsDebugGeometry
materialized_physics_debug_geometry(const PhysicsDebugShapeDescriptor& descriptor) {
    observed = descriptor;
    return {};
}
} // namespace bbl::pal

int main() {
    using namespace bbl::pal;
    auto sphere = physics_shape_create_sphere({1, 2, 3}, 0.75);
    assert((shape_at(sphere).debug_descriptor ==
            PhysicsDebugShapeDescriptor{"SPHERE", {1, 2, 3, 0.75f}, {}, {}}));
    auto box = physics_shape_create_box({2, 3, 4}, {0, 0, 0, 1}, {2, 0, 4});
    assert((shape_at(box).debug_descriptor.parameters ==
            std::vector<float>{2, 3, 4, 0, 0, 0, 1, 2, 0, 4}));
    auto capsule = physics_shape_create_capsule({0, -1, 0}, {0, 1, 0}, 0.5);
    auto cylinder = physics_shape_create_cylinder({0, -1, 0}, {0, 1, 0}, 0.5);
    assert(shape_at(capsule).debug_descriptor.type == "CAPSULE");
    assert(shape_at(cylinder).debug_descriptor.type == "CYLINDER");
    assert(shape_at(capsule).debug_descriptor.parameters ==
           shape_at(cylinder).debug_descriptor.parameters);
    auto mesh = physics_shape_create_mesh({{0, 0, 0}, {1, 0, 0}, {0, 1, 0}}, {0, 1, 2});
    assert((shape_at(mesh).debug_descriptor ==
            PhysicsDebugShapeDescriptor{"MESH", {0, 0, 0, 1, 0, 0, 0, 1, 0}, {0, 1, 2}, {}}));
    auto hull = physics_shape_create_convex_hull({{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}});
    assert((shape_at(hull).debug_descriptor.parameters ==
            std::vector<float>{0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1}));
    auto container = physics_shape_create_container();
    physics_shape_add_child(container, sphere, {{4, 5, 6}, {0, 0, 0, 1}}, {2, 3, 4});
    physics_shape_add_child(container, box, {{-1, -2, -3}, {0, 0, 0, 1}}, {1, 1, 1});
    assert((shape_at(container).debug_descriptor ==
            PhysicsDebugShapeDescriptor{
                "CONTAINER",
                {4, 5, 6, 0, 0, 0, 1, 2, 3, 4, -1, -2, -3, 0, 0, 0, 1, 1, 1, 1},
                {},
                {shape_at(sphere).debug_descriptor, shape_at(box).debug_descriptor}}));
    assert((shape_at(sphere).debug_descriptor.parameters == std::vector<float>{1, 2, 3, 0.75f}));
    auto body = physics_body_create();
    physics_body_set_shape(body, sphere);
    physics_body_set_transform(body, {{7, 8, 9}, {0, 0, 0, 1}});
    static_cast<void>(physics_body_debug_geometry(body));
    assert(observed == shape_at(sphere).debug_descriptor);
    physics_body_set_shape(body, box);
    static_cast<void>(physics_body_debug_geometry(body));
    assert(observed == shape_at(box).debug_descriptor);
    observed.parameters[0] = 99;
    assert(shape_at(box).debug_descriptor.parameters[0] == 2);
    const auto world = physics_world_create();
    extracting_constructor_inputs = true;
    bool refused = false;
    try {
        physics_world_step(world, 1.0 / 60.0);
    } catch (const std::runtime_error&) {
        refused = true;
    }
    extracting_constructor_inputs = false;
    assert(refused);
    physics_world_step(world, 1.0 / 60.0);
    std::cout << "physics-debug-inputs: ok\n";
}
