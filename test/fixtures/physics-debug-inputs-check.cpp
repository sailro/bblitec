#define BBLITE_PHYSICS_VIEWER 1
#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iostream>

namespace bbl::pal {
PhysicsDebugShapeDescriptor observed;
PhysicsDebugGeometry materialized_physics_debug_geometry(const PhysicsDebugShapeDescriptor& descriptor) {
    observed = descriptor;
    return {};
}
}

int main() {
    using namespace bbl::pal;
    auto sphere = physics_shape_create_sphere({1, 2, 3}, 0.75);
    assert((physics_shape_debug_descriptor(sphere) == PhysicsDebugShapeDescriptor{"SPHERE", {1, 2, 3, 0.75f}, {}, {}}));
    auto box = physics_shape_create_box({2, 3, 4}, {0, 0, 0, 1}, {2, 0, 4});
    assert((physics_shape_debug_descriptor(box).parameters == std::vector<float>{2, 3, 4, 0, 0, 0, 1, 2, 0, 4}));
    auto capsule = physics_shape_create_capsule({0, -1, 0}, {0, 1, 0}, 0.5);
    auto cylinder = physics_shape_create_cylinder({0, -1, 0}, {0, 1, 0}, 0.5);
    assert(physics_shape_debug_descriptor(capsule).type == "CAPSULE");
    assert(physics_shape_debug_descriptor(cylinder).type == "CYLINDER");
    assert(physics_shape_debug_descriptor(capsule).parameters == physics_shape_debug_descriptor(cylinder).parameters);
    auto mesh = physics_shape_create_mesh({{0, 0, 0}, {1, 0, 0}, {0, 1, 0}}, {0, 1, 2});
    assert((physics_shape_debug_descriptor(mesh) == PhysicsDebugShapeDescriptor{"MESH", {0, 0, 0, 1, 0, 0, 0, 1, 0}, {0, 1, 2}, {}}));
    auto hull = physics_shape_create_convex_hull({{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}});
    assert((physics_shape_debug_descriptor(hull).parameters == std::vector<float>{0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1}));
    auto container = physics_shape_create_container();
    physics_shape_add_child(container, sphere, {{4, 5, 6}, {0, 0, 0, 1}}, {2, 3, 4});
    physics_shape_add_child(container, box, {{-1, -2, -3}, {0, 0, 0, 1}}, {1, 1, 1});
    assert((physics_shape_debug_descriptor(container) == PhysicsDebugShapeDescriptor{
        "CONTAINER", {4, 5, 6, 0, 0, 0, 1, 2, 3, 4, -1, -2, -3, 0, 0, 0, 1, 1, 1, 1}, {},
        {physics_shape_debug_descriptor(sphere), physics_shape_debug_descriptor(box)}}));
    assert((physics_shape_debug_descriptor(sphere).parameters == std::vector<float>{1, 2, 3, 0.75f}));
    auto body = physics_body_create();
    physics_body_set_shape(body, sphere);
    physics_body_set_transform(body, {{7, 8, 9}, {0, 0, 0, 1}});
    static_cast<void>(physics_body_debug_geometry(body));
    assert(observed == physics_shape_debug_descriptor(sphere));
    physics_body_set_shape(body, box);
    static_cast<void>(physics_body_debug_geometry(body));
    assert(observed == physics_shape_debug_descriptor(box));
    observed.parameters[0] = 99;
    assert(physics_shape_debug_descriptor(box).parameters[0] == 2);
    const auto world = physics_world_create();
    extracting_constructor_inputs = true;
    bool refused = false;
    try { physics_world_step(world, 1.0 / 60.0); } catch (const std::runtime_error&) { refused = true; }
    extracting_constructor_inputs = false;
    assert(refused);
    physics_world_step(world, 1.0 / 60.0);
    std::cout << "physics-debug-inputs: ok\n";
}
