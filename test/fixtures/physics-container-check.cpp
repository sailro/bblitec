#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>
#include <iostream>

// Matrix providers isolate the physics transform projection from rendering.
namespace bbl::upstream {
std::array<std::array<float, 16>, 2> fixture_worlds{};
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle node) {
    return fixture_worlds.at(node.value);
}
}

int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine;
    engine.transform_nodes.resize(2);
    Scene scene;
    scene.engine = &engine;
    const auto world = create_havok_world(scene, {0, 0, 0});
    // Parent: quarter-turn about Z at (10,20,30). Child: same rotation,
    // translated by local (2,0,0). The source must cancel the full parent.
    fixture_worlds[0] = {0,1,0,0, -1,0,0,0, 0,0,1,0, 10,20,30,1};
    fixture_worlds[1] = {0,1,0,0, -1,0,0,0, 0,0,1,0, 10,22,30,1};
    auto container = create_physics_container_shape(world);
    PhysicsShape sphere{pal::physics_shape_create_sphere({0,0,0}, 0.5)};
    std::weak_ptr<pal::PhysicsShapeState> retained = sphere.handle.ownership;
    add_physics_shape_child_from_parent(world, container, physics_node(TransformNodeHandle{0}),
        sphere, physics_node(TransformNodeHandle{1}));
    fixture_worlds[1][13] = 18;
    add_physics_shape_child_from_parent(world, container, physics_node(TransformNodeHandle{0}),
        sphere, physics_node(TransformNodeHandle{1}));
    sphere = {};
    assert(!retained.expired());
    const auto body = pal::physics_body_create();
    pal::physics_body_set_shape(body, container.handle);
    const auto solver_world = physics_world_record(world).handle;
    pal::physics_world_add_body(solver_world, body, false);
    pal::physics_world_step(solver_world, 1.0 / 60);
    const auto ray = [&](double x) {
        return pal::physics_world_raycast(solver_world, {x,0,-2}, {x,0,2}, 0xffffffffu, 0xffffffffu, false);
    };
    assert(ray(-2).has_hit && ray(2).has_hit);
    assert(!ray(0).has_hit); // Separate children must preserve the gap.
    assert(std::abs(ray(2).point[2] + 0.5) < 0.0001);
    auto scaled = create_physics_container_shape(world);
    PhysicsShape offset_sphere{pal::physics_shape_create_sphere({1,0,0}, 0.5)};
    fixture_worlds[1] = {0,2,0,0, -3,0,0,0, 0,0,4,0, 10,22,30,1};
    add_physics_shape_child_from_parent(world, scaled, physics_node(TransformNodeHandle{0}),
        offset_sphere, physics_node(TransformNodeHandle{1}));
    const auto scaled_body = pal::physics_body_create();
    pal::physics_body_set_shape(scaled_body, scaled.handle);
    pal::physics_body_set_transform(scaled_body, {{0,0,10}, {0,0,0,1}});
    pal::physics_world_add_body(solver_world, scaled_body, false);
    pal::physics_world_step(solver_world, 1.0 / 60);
    const auto scaled_hit = pal::physics_world_raycast(solver_world, {4,0,5}, {4,0,15}, 0xffffffffu, 0xffffffffu, false);
    assert(scaled_hit.has_hit && std::abs(scaled_hit.point[2] - 8) < 0.001);
    const auto scaled_miss = pal::physics_world_raycast(solver_world, {5.1,0,5}, {5.1,0,15}, 0xffffffffu, 0xffffffffu, false);
    assert(!scaled_miss.has_hit);
    // A scaled placement must not change a shared primitive's source geometry.
    const auto shared_body = pal::physics_body_create();
    pal::physics_body_set_shape(shared_body, offset_sphere.handle);
    pal::physics_body_set_transform(shared_body, {{0,0,20}, {0,0,0,1}});
    pal::physics_world_add_body(solver_world, shared_body, false);
    pal::physics_world_step(solver_world, 1.0 / 60);
    const auto shared_hit = pal::physics_world_raycast(solver_world,
        {1,0,18}, {1,0,22}, 0xffffffffu, 0xffffffffu, false);
    assert(shared_hit.has_hit && std::abs(shared_hit.point[2] - 19.5) < 0.001);
    auto empty = create_physics_container_shape(world);
    fixture_worlds[0].fill(0);
    bool singular = false;
    try {
        add_physics_shape_child_from_parent(world, empty, physics_node(TransformNodeHandle{0}),
            container, physics_node(TransformNodeHandle{1}));
    } catch (const std::runtime_error& error) {
        singular = std::string(error.what()).find("singular parent") != std::string::npos;
    }
    assert(singular && empty.handle.ownership->children.empty());
    std::cout << "physics-container-check: ok\n";
}
