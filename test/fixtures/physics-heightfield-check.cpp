#define BBLITE_PHYSICS_VIEWER 1
#include <bblite/runtime.hpp>
#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <bit>
#include <cassert>
#include <iostream>

namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
}
namespace bbl::pal {
PhysicsDebugGeometry materialized_physics_debug_geometry(const PhysicsDebugShapeDescriptor&) { std::abort(); }
}

int main() {
    using namespace bbl;
    namespace p = bbl::pal;
    namespace u = bbl::upstream;
    #include "heightfield-ground-cases.inc"

    const auto ground = p::physics_shape_create_heightfield(3, 3, {2, 1, 3}, {0, 1, 2, 3, 4, 5, 6, 7, 8});
    assert((p::physics_shape_debug_descriptor(ground) == p::PhysicsDebugShapeDescriptor{
        "HEIGHTFIELD", {3, 3, 2, 1, 3, 0, 1, 2, 3, 4, 5, 6, 7, 8}, {}, {}}));
    auto body = p::physics_body_create();
    p::physics_body_set_shape(body, ground);
    const auto world = p::physics_world_create();
    p::physics_world_add_body(world, body, false);
    p::physics_world_step(world, 1.0 / 60);
    for (double x : {-1.6, -0.4, 0.4, 1.6}) for (double z : {-2.4, -0.8, 0.8, 2.4}) {
        const auto hit = p::physics_world_raycast(world, {x, 100, z}, {x, -100, z}, ~0u, ~0u, false);
        assert(hit.has_hit);
        assert(std::abs(hit.point[1] - (4 + 1.5 * x + z / 3)) < 0.0001);
        assert(hit.normal[1] > 0);
    }
    const auto saddle = p::physics_shape_create_heightfield(2, 2, {2, 1, 2}, {0, 0, 0, 2});
    const auto saddle_body = p::physics_body_create();
    p::physics_body_set_shape(saddle_body, saddle);
    p::physics_body_set_transform(saddle_body, {{10, 0, 0}});
    p::physics_world_add_body(world, saddle_body, false);
    p::physics_world_step(world, 1.0 / 60);
    for (double x : {-0.5, 0.5}) for (double z : {-0.5, 0.5}) {
        const auto hit = p::physics_world_raycast(world, {10 + x, 10, z}, {10 + x, -10, z}, ~0u, ~0u, false);
        assert(hit.has_hit && std::abs(hit.point[1] - std::max(0.0, x + z)) < 0.0001);
    }
    const auto refuses = [](auto&& action) {
        try { action(); } catch (const std::runtime_error&) { return true; }
        return false;
    };
    assert(refuses([&] { static_cast<void>(p::physics_shape_create_heightfield(3, 2, {1, 1, 1}, {0, 1, 2, 3, 4, 5})); }));
    assert(refuses([&] { static_cast<void>(p::physics_shape_create_heightfield(2, 2, {1, 1, 1}, {0, 1, 2, INFINITY})); }));
    assert(refuses([&] { static_cast<void>(p::physics_shape_create_heightfield(2, 2, {0, 1, 1}, {0, 1, 2, 3})); }));
    assert(refuses([&] { p::physics_body_set_motion_type(body, p::PhysicsMotionType::simulated); }));
    auto moving = p::physics_body_create();
    p::physics_body_set_motion_type(moving, p::PhysicsMotionType::simulated);
    assert(refuses([&] { p::physics_body_set_shape(moving, ground); }));

    const auto flat = p::physics_shape_create_heightfield(5, 5, {2, 1, 2}, std::vector<float>(25));
    const auto flat_body = p::physics_body_create();
    p::physics_body_set_shape(flat_body, flat);
    const auto fall_world = p::physics_world_create();
    p::physics_world_set_gravity(fall_world, {0, -9.8, 0});
    p::physics_world_add_body(fall_world, flat_body, false);
    const auto sphere = p::physics_shape_create_sphere({0, 0, 0}, 0.5);
    p::physics_body_set_shape(moving, sphere);
    p::physics_body_set_mass_properties(moving, p::physics_shape_build_mass_properties(sphere, 1));
    p::physics_body_set_transform(moving, {{0.3, 3, 0.7}});
    p::physics_world_add_body(fall_world, moving, false);
    for (int step = 0; step < 180; ++step) p::physics_world_step(fall_world, 1.0 / 60);
    const auto settled = p::physics_body_get_transform(moving).position;
    assert(std::abs(settled[1] - 0.5) < 0.025);

    auto source_world = std::make_shared<u::PhysicsWorld>();
    source_world->handle = p::physics_world_create();
    source_world->gravity = {0, -9.8, 0};
    const u::PhysicsWorldHandle source_handle{source_world->handle.value, source_world};
    const auto gravity = [](p::PhysicsWorldHandle handle) { return handle.ownership->world->getGravity(); };
    u::set_physics_gravity(source_handle, {1, -2, 3}, Vec3d{50, 0, 0});
    assert(gravity(source_world->handle) == btVector3(1, -2, 3));
    assert((source_world->gravity == std::array<double, 3>{0, -9.8, 0}));
    u::enable_havok_floating_origin(source_handle, 10);
    u::set_physics_gravity(source_handle, {0, 4, 0}, Vec3d{50, 0, 0});
    assert(source_world->fo->regions.size() == 2);
    assert(gravity(source_world->fo->regions[0].world) == btVector3(1, -2, 3));
    assert(gravity(source_world->fo->regions[1].world) == btVector3(0, 4, 0));
    assert(source_world->fo->gravity == source_world->gravity);
    u::set_physics_gravity(source_handle, {5, 6, 7}, {});
    assert((source_world->fo->gravity == std::array<double, 3>{5, 6, 7}));
    for (const auto& region : source_world->fo->regions) assert(gravity(region.world) == btVector3(5, 6, 7));
    assert(gravity(u::get_or_create_region(*source_world, {100, 0, 0})) == btVector3(5, 6, 7));
    std::cout << "physics-heightfield: ok; settled y=" << settled[1] << '\n';
}
