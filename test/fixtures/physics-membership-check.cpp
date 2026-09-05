#include "pal_physics_bullet.cpp"

#include <cassert>
#include <iostream>

using namespace bbl::pal;

PhysicsBodyHandle sphere(PhysicsWorldHandle world, double x = 0) {
    const auto shape = physics_shape_create_sphere({0, 0, 0}, 0.5);
    const auto body = physics_body_create();
    physics_body_set_shape(body, shape);
    physics_body_set_motion_type(body, PhysicsMotionType::simulated);
    physics_body_set_mass_properties(body, physics_shape_build_mass_properties(shape, 1));
    PhysicsTransform pose;
    pose.position = {x, 0, 0};
    physics_body_set_transform(body, pose);
    physics_world_add_body(world, body, false);
    return body;
}

int main() {
    const auto a = physics_world_create();
    const auto b = physics_world_create();
    const auto first = sphere(a);
    const auto second = sphere(a, 10);
    // Repeated addition and direct migration also work before Bullet's first
    // flush, when getCollisionObjectArray() cannot yet describe membership.
    physics_world_add_body(a, first, false);
    assert(world_at(a).members.size() == 2);
    physics_world_add_body(b, first, false);
    assert(world_at(a).members == std::vector<std::shared_ptr<PhysicsBodyState>>{second.ownership});
    physics_world_step(a, 1.0 / 60);
    physics_world_step(b, 1.0 / 60);
    assert(world_at(a).world->getNumCollisionObjects() == 1);
    assert(world_at(b).world->getNumCollisionObjects() == 1);

    physics_body_set_linear_velocity(first, {2, 0, 0});
    physics_body_set_linear_velocity(second, {2, 0, 0});
    const double first_x = physics_body_get_transform(first).position[0];
    const double second_x = physics_body_get_transform(second).position[0];
    for (int i = 0; i < 20; ++i) {
        physics_world_step(a, 1.0 / 60);
        physics_world_step(b, 1.0 / 60);
    }
    assert(std::abs((physics_body_get_transform(first).position[0] - first_x) -
                    (physics_body_get_transform(second).position[0] - second_x)) < 0.00001);
    // Stepping another region must not clear this body's resting timer.
    body_at(first).contact_quiet_seconds = 0.25;
    physics_world_step(a, 1.0 / 60);
    assert(body_at(first).contact_quiet_seconds == 0.25);
    physics_world_add_body(a, first, false);
    assert(world_at(b).world->getNumCollisionObjects() == 0);
    assert((world_at(a).members == std::vector<std::shared_ptr<PhysicsBodyState>>{first.ownership, second.ownership}));
    physics_world_remove_body(b, first); // Removing from another world is inert.
    physics_world_release(a);
    assert(body_at(first).world == 0 && body_at(second).world == 0);
    physics_world_add_body(b, first, false);
    physics_world_step(b, 1.0 / 60);
    assert(world_at(b).world->getNumCollisionObjects() == 1);

    const auto trigger_world = physics_world_create();
    const auto traveler = sphere(trigger_world);
    const auto trigger_shape = physics_shape_create_box({0, 0, 0}, {0, 0, 0, 1}, {4, 4, 4});
    physics_shape_set_trigger(trigger_shape, true);
    const auto trigger = physics_body_create();
    physics_body_set_shape(trigger, trigger_shape);
    physics_world_add_body(trigger_world, trigger, false);
    physics_world_step(trigger_world, 1.0 / 60);
    assert(physics_world_trigger_events(trigger_world).size() == 1);
    assert(physics_world_trigger_events(trigger_world)[0].type == PhysicsTriggerEventType::entered);
    physics_world_remove_body(trigger_world, traveler);
    physics_world_step(trigger_world, 1.0 / 60);
    assert(physics_world_trigger_events(trigger_world).size() == 1);
    assert(physics_world_trigger_events(trigger_world)[0].type == PhysicsTriggerEventType::exited);
    physics_world_add_body(trigger_world, traveler, false);
    physics_world_step(trigger_world, 1.0 / 60);
    assert(world_at(trigger_world).trigger_body_count == 1);
    physics_world_remove_body(trigger_world, trigger);
    physics_world_step(trigger_world, 1.0 / 60);
    assert(world_at(trigger_world).trigger_body_count == 0);
    assert(physics_world_trigger_events(trigger_world).size() == 1);
    assert(physics_world_trigger_events(trigger_world)[0].type == PhysicsTriggerEventType::exited);
    physics_world_step(trigger_world, 1.0 / 60);
    assert(physics_world_trigger_events(trigger_world).empty());

    // A world retains discarded body/shape handles, then frees the complete
    // graph when its final handle dies. An independent world stays usable.
    for (int iteration = 0; iteration < 100; ++iteration) {
        std::weak_ptr<PhysicsWorldState> weak_world;
        std::weak_ptr<PhysicsBodyState> weak_body;
        std::weak_ptr<PhysicsShapeState> weak_shape;
        {
            auto world = physics_world_create();
            weak_world = world.ownership;
            {
                auto body = sphere(world);
                weak_body = body.ownership;
                weak_shape = body.ownership->shape;
            }
            assert(!weak_body.expired() && !weak_shape.expired());
            physics_world_step(world, 1.0 / 60);
        }
        assert(weak_world.expired() && weak_body.expired() && weak_shape.expired());
    }
    physics_world_step(b, 1.0 / 60);

    // External bodies retain their shape after world release; replacing a
    // shape removes the old raw-user registration and frees it immediately.
    auto held_world = physics_world_create();
    auto held_body = sphere(held_world);
    std::weak_ptr<PhysicsShapeState> retired_shape = held_body.ownership->shape;
    auto replacement = physics_shape_create_sphere({0, 0, 0}, 1);
    physics_body_set_shape(held_body, replacement);
    assert(retired_shape.expired());
    assert(replacement.ownership->users == std::vector<PhysicsBodyState*>{held_body.ownership.get()});
    physics_world_release(held_world);
    physics_world_release(held_world); // Release is idempotent for owned handles.
    assert(held_body.ownership->owner_world.expired());
    assert(physics_body_get_transform(held_body).position[0] == 0);
    held_body = {};
    assert(replacement.ownership->users.empty());

    // Deferred rebounds contain raw Bullet pointers: removing either member
    // must retire both caches before the last body owner can disappear.
    auto bounce_world = physics_world_create();
    auto bounce_a = sphere(bounce_world);
    auto bounce_b = sphere(bounce_world, 10);
    HavokBounce bounce;
    bounce.body_a = body_at(bounce_a).body.get();
    bounce.body_b = body_at(bounce_b).body.get();
    world_at(bounce_world).scheduled_bounces.push_back(bounce);
    world_at(bounce_world).active_bounces.push_back(bounce);
    std::weak_ptr<PhysicsBodyState> removed = bounce_a.ownership;
    physics_world_remove_body(bounce_world, bounce_a);
    bounce_a = {};
    assert(removed.expired());
    assert(world_at(bounce_world).scheduled_bounces.empty());
    assert(world_at(bounce_world).active_bounces.empty());
    physics_world_step(bounce_world, 1.0 / 60);

    std::vector<PhysicsWorldHandle> regions;
    for (int region = 0; region < 32; ++region) {
        const auto world = physics_world_create();
        regions.push_back(world);
        for (int i = 0; i < 64; ++i) sphere(world, i * 2.0);
    }
    std::vector<std::shared_ptr<PhysicsBodyState>> all_bodies;
    for (const auto& region : regions) {
        const auto& members = world_at(region).members;
        all_bodies.insert(all_bodies.end(), members.begin(), members.end());
    }
    const auto benchmark = [&](bool global) {
        const auto start = std::chrono::steady_clock::now();
        for (int repeat = 0; repeat < 200; ++repeat) {
            for (auto world : regions) {
                if (global) {
                    for (auto& owned : all_bodies) {
                        auto& body = *owned;
                        if (body.world == world.value && body.body) {
                            body.step_start.linear = body.body->getLinearVelocity();
                            body.step_start.angular = body.body->getAngularVelocity();
                        }
                    }
                } else {
                    cache_velocities(world_at(world), &PhysicsBodyState::step_start);
                }
            }
        }
        return std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - start).count();
    };
    const double global_ms = benchmark(true);
    const double members_ms = benchmark(false);
    std::cout << "32 regions, 2048 bodies: global " << global_ms
              << " ms, membership " << members_ms << " ms\n";
    for (auto world : regions) physics_world_release(world);
    physics_world_release(b);
    physics_world_release(trigger_world);
    std::cout << "physics-membership-check: ok\n";
}
