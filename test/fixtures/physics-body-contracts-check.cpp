#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iomanip>
#include <iostream>

using namespace bbl::pal;

PhysicsBodyHandle make_body(PhysicsShapeHandle shape, PhysicsMotionType motion, std::array<double, 3> position = {}) {
    auto body = physics_body_create();
    physics_body_set_shape(body, shape);
    physics_body_set_motion_type(body, motion);
    physics_body_set_transform(body, {position});
    if (motion == PhysicsMotionType::simulated)
        physics_body_set_mass_properties(body, {{0,0,0}, 1, {1,1,1}});
    return body;
}

void check_mass_frame() {
    assert((PhysicsMassProperties{}.inertia_orientation == std::array<double, 4>{0,0,0,1}));
    std::vector<std::array<double, 3>> vertices;
    for (double x : {-1., 1.}) for (double y : {-2., 2.}) for (double z : {-3., 3.})
        vertices.push_back({3 + .28*x - .96*y, -2 + .96*x + .28*y, 5 + z});
    const auto shape = physics_shape_create_convex_hull(vertices);
    const auto mass = physics_shape_build_mass_properties(shape, 12);
    assert(mass.mass == 12);
    for (std::size_t i = 0; i < 3; ++i)
        assert(std::abs(mass.center_of_mass[i] - std::array<double,3>{3,-2,5}[i]) < 1e-5);
    const btMatrix3x3 axes(to_bt(mass.inertia_orientation));
    const btMatrix3x3 diagonal(static_cast<btScalar>(mass.inertia[0]),0,0,
        0,static_cast<btScalar>(mass.inertia[1]),0,0,0,static_cast<btScalar>(mass.inertia[2]));
    const auto tensor = axes * diagonal * axes.transpose();
    const double expected[3][3] = {{40.9408,3.2256,0}, {3.2256,51.0592,0}, {0,0,20}};
    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) {
        // Bullet constructs and diagonalizes the hull at btScalar precision.
        // Bound entry error relative to the largest principal moment (52).
        assert(std::abs(tensor[i][j] - expected[i][j]) < 52 * 1e-4);
    }

    const auto body = make_body(shape, PhysicsMotionType::simulated);
    physics_body_set_mass_properties(body, mass);
    for (const PhysicsTransform pose : {PhysicsTransform{{10,20,30}}, PhysicsTransform{{-4,7,11},{0,.6,0,.8}}}) {
        physics_body_set_transform(body, pose);
        const btTransform node(to_bt(pose.rotation), to_bt(pose.position));
        const auto& rigid = *body_at(body).body;
        assert((rigid.getCenterOfMassPosition() - node * btVector3(3,-2,5)).length() < 1e-4);
        const auto restored = physics_body_get_transform(body);
        assert((to_bt(restored.position) - to_bt(pose.position)).length() < 1e-4);
        assert(std::abs(to_bt(restored.rotation).dot(to_bt(pose.rotation))) > .99999);
        assert(rigid.getCollisionShape()->getShapeType() == CONVEX_HULL_SHAPE_PROXYTYPE);
        const auto* hull = static_cast<const btConvexHullShape*>(rigid.getCollisionShape());
        assert(hull && hull->getNumPoints() == 8);
        for (const auto& vertex : vertices) {
            btScalar nearest = BT_LARGE_FLOAT;
            for (int i = 0; i < hull->getNumPoints(); ++i)
                nearest = std::min(nearest, (rigid.getWorldTransform() * hull->getUnscaledPoints()[i] - node * to_bt(vertex)).length());
            assert(nearest < 1e-4);
        }
    }
}

void check_filters() {
    for (bool custom : {false, true}) {
        const auto world = physics_world_create();
        const auto shape = physics_shape_create_box({0,0,0}, {0,0,0,1}, {1,1,1});
        if (custom) {
            physics_shape_set_filter_membership_mask(shape, 8);
            physics_shape_set_filter_collide_mask(shape, 8);
        }
        for (int i = 0; i < 2; ++i)
            physics_world_add_body(world, make_body(shape, PhysicsMotionType::immovable), false);
        physics_world_step(world, 1.0/60);
        for (const auto& member : world_at(world).members) {
            const auto* proxy = member->body->getBroadphaseHandle();
            assert(proxy);
            assert(proxy->m_collisionFilterGroup == (custom ? 8 : btBroadphaseProxy::StaticFilter));
            assert(proxy->m_collisionFilterMask == (custom ? 8 : btBroadphaseProxy::AllFilter ^ btBroadphaseProxy::StaticFilter));
        }
        assert(world_at(world).world->getPairCache()->getNumOverlappingPairs() == 0);
    }
    for (bool collide : {false, true}) {
        const auto world = physics_world_create();
        const auto a = physics_shape_create_sphere({0,0,0}, 1);
        const auto b = physics_shape_create_sphere({0,0,0}, 1);
        physics_shape_set_filter_membership_mask(a, 2);
        physics_shape_set_filter_membership_mask(b, 4);
        physics_shape_set_filter_collide_mask(a, collide ? 4 : 2);
        physics_shape_set_filter_collide_mask(b, 2);
        physics_world_add_body(world, make_body(a, PhysicsMotionType::immovable), false);
        physics_world_add_body(world, make_body(b, PhysicsMotionType::simulated), false);
        physics_world_step(world, 1.0/60);
        assert((world_at(world).world->getPairCache()->getNumOverlappingPairs() > 0) == collide);
    }
}

void check_sleep() {
    for (const bool trigger : {false, true}) {
        const auto world = physics_world_create();
        physics_world_set_gravity(world, {0,0,0});
        const auto floor = physics_shape_create_box({0,0,0}, {0,0,0,1}, {20,1,20});
        physics_shape_set_trigger(floor, trigger);
        physics_world_add_body(world, make_body(floor, PhysicsMotionType::immovable), false);
        const auto sphere = physics_shape_create_sphere({0,0,0}, .5);
        const auto touching = make_body(sphere, PhysicsMotionType::simulated, {0,1,0});
        const auto free = make_body(sphere, PhysicsMotionType::simulated, {0,10,0});
        physics_world_add_body(world, touching, false);
        physics_world_add_body(world, free, false);
        for (int i = 0; i < 30; ++i) physics_world_step(world, 1.0/60);
        assert(body_at(free).body->isActive());
        assert(body_at(touching).body->isActive() == trigger);
        if (!trigger) {
            assert(body_at(touching).body->getActivationState() == ISLAND_SLEEPING);
            physics_body_apply_impulse(touching, {0,1,0}, {0,1,0});
            assert(body_at(touching).body->isActive());
            assert(physics_body_get_linear_velocity(touching)[1] > .9);
        }
    }
}

void velocities(PhysicsBodyHandle body) {
    const auto linear = physics_body_get_linear_velocity(body), angular = physics_body_get_angular_velocity(body);
    std::cout << '[';
    for (std::size_t i = 0; i < 3; ++i) std::cout << (i ? "," : "") << linear[i];
    for (const double value : angular) std::cout << ',' << value;
    std::cout << ']';
}

int main() {
    check_mass_frame();
    check_filters();
    check_sleep();
    const auto world = physics_world_create();
    physics_world_set_gravity(world, {0,0,0});
    const auto limits = physics_world_get_speed_limit(world);
    std::cout << std::setprecision(17) << "{\"limits\":[" << limits.max_linear << ',' << limits.max_angular << "],\"impulses\":[";
    const auto sphere = physics_shape_create_sphere({0,0,0}, .5);
    auto body = make_body(sphere, PhysicsMotionType::simulated);
    physics_world_add_body(world, body, false);
    bool first = true;
    for (const auto limit : {limits, PhysicsSpeedLimit{7,3}, PhysicsSpeedLimit{20,11}}) {
        physics_world_set_speed_limit(world, limit.max_linear, limit.max_angular);
        physics_world_step(world, 1.0/60);
        physics_body_set_transform(body, {});
        physics_body_set_linear_velocity(body, {0,0,0});
        physics_body_set_angular_velocity(body, {0,0,0});
        physics_body_apply_impulse(body, {0,1,0}, {1000,2000,0});
        if (!first) std::cout << ',';
        first = false;
        velocities(body);
    }
    const auto migrated = physics_world_create();
    physics_world_set_speed_limit(migrated, 5, 2);
    physics_world_add_body(migrated, body, false);
    physics_body_set_transform(body, {});
    physics_body_set_linear_velocity(body, {0,0,0});
    physics_body_set_angular_velocity(body, {0,0,0});
    physics_body_apply_impulse(body, {0,1,0}, {1000,2000,0});
    std::cout << ','; velocities(body);
    std::cout << "],\"damped\":";
    const auto damped = make_body(sphere, PhysicsMotionType::simulated);
    physics_world_add_body(world, damped, false);
    physics_body_set_linear_velocity(damped, {1,2,3});
    physics_body_set_angular_velocity(damped, {0,0,10});
    physics_world_step(world, 1.0/60);
    velocities(damped);
    std::cout << ",\"convex\":[";
    std::vector<std::array<double, 3>> vertices;
    for (double x : {-1., 1.}) for (double y : {-2., 2.}) for (double z : {-3., 3.})
        vertices.push_back({3 + .28*x - .96*y, -2 + .96*x + .28*y, 5 + z});
    const auto hull = physics_shape_create_convex_hull(vertices);
    first = true;
    for (const double mass : {1., 12.}) {
        const auto moving = make_body(hull, PhysicsMotionType::simulated);
        physics_body_set_mass_properties(moving, physics_shape_build_mass_properties(hull, mass));
        physics_world_add_body(world, moving, false);
        for (const std::array<double, 3> impulse : {std::array<double, 3>{1,0,0}, {0,0,1}}) {
            physics_body_set_linear_velocity(moving, {0,0,0});
            physics_body_set_angular_velocity(moving, {0,0,0});
            physics_body_apply_impulse(moving, {3,-1,5}, impulse);
            if (!first) std::cout << ',';
            first = false;
            velocities(moving);
        }
    }
    std::cout << "]}\n";
}
