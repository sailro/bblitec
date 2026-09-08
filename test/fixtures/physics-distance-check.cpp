#include <bblite/runtime.hpp>
#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iostream>
#include <iomanip>
namespace p = bbl::pal;
struct Pair { p::PhysicsWorldHandle world; p::PhysicsBodyHandle a, b; };
Pair pair(double parent, double child, double y, bool dynamic_parent = false, bool cartesian = false,
    const btTransform& placement = btTransform::getIdentity()) {
    const auto world = p::physics_world_create(); p::physics_world_set_gravity(world, {0,0,0});
    const auto shape = p::physics_shape_create_box({0,0,0}, {0,0,0,1}, {1,1,1});
    const auto a = p::physics_body_create(), b = p::physics_body_create();
    p::physics_body_set_shape(a, shape); p::physics_body_set_shape(b, shape);
    p::physics_body_set_mass_properties(b, p::physics_shape_build_mass_properties(shape, 1));
    p::physics_body_set_motion_type(b, p::PhysicsMotionType::simulated);
    if (dynamic_parent) {
        p::physics_body_set_mass_properties(a, p::physics_shape_build_mass_properties(shape, 1));
        p::physics_body_set_motion_type(a, p::PhysicsMotionType::simulated);
    }
    const auto pose = [&](const btVector3& position) {
        const auto point = placement * position; const auto q = placement.getRotation();
        return p::PhysicsTransform{{point.x(),point.y(),point.z()}, {q.x(),q.y(),q.z(),q.w()}};
    };
    p::physics_body_set_transform(a, pose({0,0,0})); p::physics_body_set_transform(b, pose({0,btScalar(y),-.2f}));
    p::physics_world_add_body(world, a, false); p::physics_world_add_body(world, b, false);
    p::PhysicsConstraintAxes axes{}; axes[6] = {p::PhysicsConstraintAxisMode::limited, 1, 2};
    if (cartesian) axes[0] = {p::PhysicsConstraintAxisMode::locked};
    p::physics_world_create_constraint(world, a, b, {{0,parent,0},{1,0,0},{0,1,0}}, {{0,child,0},{1,0,0},{0,1,0}}, axes, false);
    return {world,a,b};
}
void check(double parent, double child, double y, double dt, const p::PhysicsTransform& expected, const std::array<double,3>& expected_velocity) {
    auto fixture = pair(parent, child, y); p::physics_world_step(fixture.world, dt);
    const auto actual = p::physics_body_get_transform(fixture.b);
    double position_error = 0, rotation_error = 0;
    for (int axis = 0; axis < 3; ++axis) position_error = std::max(position_error, std::abs(actual.position[axis] - expected.position[axis]));
    for (int axis = 0; axis < 4; ++axis) rotation_error = std::max(rotation_error, std::abs(actual.rotation[axis] - expected.rotation[axis]));
    assert(position_error < .025 && rotation_error < .012);
    if (child == 0) {
        assert(position_error < .000005);
        const auto velocity = p::physics_body_get_linear_velocity(fixture.b);
        for (int axis = 0; axis < 3; ++axis) assert(std::abs(velocity[axis] - expected_velocity[axis]) < .001);
    }
    std::cout << parent << ' ' << child << ' ' << y << ' ' << dt << " positionError=" << position_error << " rotationError=" << rotation_error << '\n';
}
int main() {
    std::cout << std::setprecision(12);
    #include "radial-cases.inc"
    const btTransform placement(btQuaternion(btVector3(1,2,3).normalized(), .7f), {3,-2,5});
    auto base = pair(.5,.5,2.5), rotated = pair(.5,.5,2.5,false,false,placement);
    p::physics_world_step(base.world,1./60); p::physics_world_step(rotated.world,1./60);
    const auto relative = placement.inverse() * rotated.b.ownership->body->getWorldTransform();
    const auto original = base.b.ownership->body->getWorldTransform();
    assert((relative.getOrigin()-original.getOrigin()).length() < .0001f);
    assert(btFabs(relative.getRotation().dot(original.getRotation())) > .99999f);
    auto mixed = pair(.5,.5,2.5,false,true);
    p::physics_body_set_linear_velocity(mixed.b,{4,0,0});
    for(int step=0;step<120;++step) p::physics_world_step(mixed.world,1./60);
    const auto& joint = static_cast<btGeneric6DofSpring2Constraint&>(*mixed.world.ownership->hinges.front().joint);
    const auto a = mixed.a.ownership->body->getWorldTransform() * joint.getFrameOffsetA();
    const auto b = mixed.b.ownership->body->getWorldTransform() * joint.getFrameOffsetB();
    const auto relative_pivot = a.inverse() * b.getOrigin();
    assert(btFabs(relative_pivot.x()) < .002f);
    assert(relative_pivot.length() > .99f && relative_pivot.length() < 2.01f);
    auto dynamic = pair(.5,.5,2.5,true);
    for(int step=0;step<120;++step) p::physics_world_step(dynamic.world,1./60);
    const auto sum = dynamic.a.ownership->body->getWorldTransform().getOrigin() + dynamic.b.ownership->body->getWorldTransform().getOrigin();
    assert(btFabs(sum.y()-2.5f)<.001f && btFabs(sum.z()+.2f)<.001f);
    p::physics_world_remove_body(mixed.world,mixed.b);
    assert(mixed.world.ownership->world->getNumConstraints()==0);
    p::physics_world_add_body(mixed.world,mixed.b,false); p::physics_world_step(mixed.world,1./60);
    assert(mixed.world.ownership->world->getNumConstraints()==1);
    std::cout << "physics-distance: ok; mixed Cartesian/radial, rigid-frame invariance, momentum and membership\n";
}
