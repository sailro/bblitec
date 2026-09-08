#include <bblite/runtime.hpp>
#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>
#include <iostream>

namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
}

int main() {
    using namespace bbl;
    namespace p = bbl::pal;
    namespace u = bbl::upstream;
    #include "constraint-axis-cases.inc"
    auto source_world = std::make_shared<u::PhysicsWorld>();
    source_world->handle = p::physics_world_create();
    const auto world = source_world->handle;
    const u::PhysicsWorldHandle source_handle{world.value, source_world};
    p::physics_world_set_gravity(world, {0, -9.8, 0});
    const auto shape = p::physics_shape_create_box({0.1, 0.2, 0}, {0,0,0,1}, {1, 0.2, 1});
    auto a = p::physics_body_create();
    auto b = p::physics_body_create();
    p::physics_body_set_shape(a, shape);
    p::physics_body_set_shape(b, shape);
    p::physics_body_set_motion_type(b, p::PhysicsMotionType::simulated);
    auto mass = p::physics_shape_build_mass_properties(shape, 1);
    p::physics_body_set_mass_properties(b, mass);
    p::physics_body_set_transform(a, {{0, 1, 0}});
    p::physics_body_set_transform(b, {{0, 1, -1}});
    p::physics_world_add_body(world, a, false);
    p::physics_world_add_body(world, b, false);
    u::PhysicsBody source_a; source_a.handle = a;
    u::PhysicsBody source_b; source_b.handle = b;
    u::create_physics_constraint(source_handle, source_a, source_b, hinge_type, {
        .pivot_a = Vec3d{0,0,-0.5}, .pivot_b = Vec3d{0,0,0.5},
        .axis_a = Vec3d{1,0,0}, .axis_b = Vec3d{1,0,0}});
    assert(world.ownership->hinges.size() == 1);
    assert(world.ownership->world->getNumConstraints() == 0); // Pending body insertion.
    double maximum_pivot_error = 0;
    const auto pivot_error = [&]() {
        const auto& hinge = world.ownership->hinges.front();
        const auto& joint = static_cast<const btHingeConstraint&>(*hinge.joint);
        const auto aw = a.ownership->body->getWorldTransform() * joint.getAFrame();
        const auto bw = b.ownership->body->getWorldTransform() * joint.getBFrame();
        maximum_pivot_error = std::max(maximum_pivot_error, static_cast<double>((aw.getOrigin() - bw.getOrigin()).length()));
        assert(aw.getBasis().getColumn(2).dot(bw.getBasis().getColumn(2)) > 0.9999);
    };
    for (int i = 0; i < 120; ++i) { p::physics_world_step(world, 1.0 / 60); pivot_error(); }
    assert(world.ownership->world->getNumConstraints() == 1);
    assert(maximum_pivot_error < 0.001);
    assert(std::abs(p::physics_body_get_transform(b).rotation[0]) > 0.1);
    assert(!a.ownership->body->checkCollideWith(b.ownership->body.get()));
    // Changed mass frames keep the authored node-local pivots.
    mass.center_of_mass = {0.3, -0.1, 0.2};
    p::physics_body_set_mass_properties(b, mass);
    p::physics_world_step(world, 1.0 / 60); pivot_error();
    assert(maximum_pivot_error < 0.001);
    p::physics_world_remove_body(world, b);
    assert(world.ownership->world->getNumConstraints() == 0);
    p::physics_world_add_body(world, b, false);
    p::physics_world_step(world, 1.0 / 60);
    assert(world.ownership->world->getNumConstraints() == 1);
    std::weak_ptr<p::PhysicsBodyState> retained_a = a.ownership;
    std::weak_ptr<p::PhysicsBodyState> retained_b = b.ownership;
    source_a = {}; source_b = {}; a = {}; b = {};
    assert(!retained_a.expired() && !retained_b.expired());
    p::physics_world_release(world);
    assert(retained_a.expired() && retained_b.expired());
    assert(world.ownership->hinges.empty());
    const auto other_world = p::physics_world_create();
    a = p::physics_body_create(); b = p::physics_body_create();
    p::physics_body_set_shape(a, shape); p::physics_body_set_shape(b, shape);
    p::physics_world_add_body(other_world, a, false); p::physics_world_add_body(other_world, b, false);
    const p::PhysicsConstraintAnchor anchor{{0,0,0}, {0,0,1}, {0,1,0}};
    p::physics_world_create_hinge(other_world, a, b, anchor, anchor, true);
    p::physics_world_step(other_world, 1.0 / 60);
    assert(a.ownership->body->checkCollideWith(b.ownership->body.get()));
    bool same_body_refused = false;
    try { p::physics_world_create_hinge(other_world, a, a, anchor, anchor, false); }
    catch (const std::runtime_error&) { same_body_refused = true; }
    assert(same_body_refused);
    const auto different_world = p::physics_world_create();
    bool foreign_body_refused = false;
    try { p::physics_world_create_hinge(different_world, a, b, anchor, anchor, false); }
    catch (const std::runtime_error&) { foreign_body_refused = true; }
    assert(foreign_body_refused);
    // A removed/released body invalidates its joint before the remaining
    // body's changed mass frame can access the joint's rigid-body references.
    p::physics_world_remove_body(other_world, a);
    assert(other_world.ownership->world->getNumConstraints() == 0);
    p::physics_body_release(a);
    assert(other_world.ownership->hinges.size() == 1);
    mass.center_of_mass = {0.4, 0.2, -0.3};
    p::physics_body_set_mass_properties(b, mass);
    p::physics_world_step(other_world, 1.0 / 60);
    assert(other_world.ownership->hinges.empty());
    assert(other_world.ownership->world->getNumConstraints() == 0);
    p::physics_world_release(other_world);
    std::cout << "physics-hinge: ok pivotError=" << maximum_pivot_error << '\n';
}
