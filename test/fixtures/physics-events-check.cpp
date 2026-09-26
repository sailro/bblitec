#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>

namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}; }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
} // namespace bbl::upstream
namespace bbl {
void flush_thin_instances(Engine& engine, MeshHandle mesh) {
    ++engine.meshes.at(mesh.value).instance_version;
}
} // namespace bbl
namespace p = bbl::pal;
namespace u = bbl::upstream;

int main() {
    bbl::Engine engine;
    engine.meshes.resize(4);
    bbl::Scene scene;
    scene.engine = &engine;
    const auto handle = u::create_havok_world(scene, {0, 0, 0});
    auto& world = *handle.ownership.lock();
    assert(!world.events);
    const auto ordinary = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                 u::PhysicsMotionType::STATIC, false);
#if TEST_THIN
    std::vector<float> matrices(48);
    for (std::size_t i = 0; i < 3; ++i)
        u::thin_compose_matrix(matrices, static_cast<double>(i * 16), static_cast<double>(i * 10),
                               0, 0, 0, 0, 0, 1, 1, 1, 1);
    auto& carrier = engine.meshes[1];
    carrier.thin_instanced = true;
    carrier.instance_count = 3;
    carrier.instance_source = &matrices;
    u::enable_havok_thin_instance_physics(handle);
#endif
    const auto target = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{1}),
                                               u::PhysicsMotionType::DYNAMIC, false);
    std::vector<p::PhysicsBodyHandle> native_handles{target.handle};
#if TEST_THIN
    native_handles = u::thin_state(world, target.handle)->handles;
#endif
    u::set_physics_body_collision_events_enabled(handle, target, true);
    for (const auto& native : native_handles)
        assert(native.ownership->collision_events_enabled);

    // A drained PAL stream can contain several contacts for a body removed by its first callback.
    auto& stream = world.handle.ownership->collision_events;
    for (const auto& native : native_handles)
        stream.push_back(p::PhysicsCollisionEvent{p::PhysicsCollisionEventType::started,
                                                  {1, 2, 3},
                                                  {0, 1, 0},
                                                  4,
                                                  native.value,
                                                  ordinary.handle.value,
                                                  {1, 1.75, 3}});
    stream.push_back(p::PhysicsCollisionEvent{
        p::PhysicsCollisionEventType::started, {}, {}, 0, 0, ordinary.handle.value});
    std::size_t first = 0, second = 0;
    int added = 0;
    u::on_physics_collision(handle, [&](const u::PhysicsCollisionInfo& info) {
        assert(info.collider == target && info.collided_against == ordinary);
        assert(info.collider_index == static_cast<double>(first) &&
               info.collided_against_index == 0);
        assert(info.type == u::PhysicsCollisionType::STARTED && info.impulse == 4 &&
               info.distance == -0.25);
        assert(info.point.y == 2 && info.normal.y == 1);
        if (first++ == 0) {
            u::remove_physics_body(handle, target);
            u::remove_physics_body(handle, target);
            u::remove_physics_body(handle, ordinary);
            u::on_physics_after_step(handle, [&](float) { ++added; });
        }
        for (const auto& native : native_handles)
            assert(native.ownership->body && native.ownership->world == 0);
        assert(ordinary.handle.ownership->body);
    });
    u::on_physics_collision(handle, [&](const u::PhysicsCollisionInfo& info) {
        assert(info.collider == target && info.collided_against == ordinary);
        assert(info.collider_index == static_cast<double>(second++));
        assert(info.collider.handle.ownership->body &&
               info.collided_against.handle.ownership->body);
    });
    u::physics_dispatch_after_step(world, 1.0 / 60);
    assert(first == native_handles.size() && second == first && added == 0);
    assert(world.bodies.empty() && !world.events->removed && !world.events->draining);
    for (const auto& native : native_handles) {
        assert(!native.ownership->body);
        assert(!u::physics_events_resolve(world, *world.events, native.value));
    }
    assert(!ordinary.handle.ownership->body);
#if TEST_THIN
    assert(world.thin_states.empty());
#endif
    // The next dispatch skips contacts whose bodies have been released and sees the new callback.
    u::physics_dispatch_after_step(world, 1.0 / 60);
    assert(first == native_handles.size() && second == first && added == 1);

    world.after_step.clear();
    const auto throwing = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{2}),
                                                 u::PhysicsMotionType::STATIC, false);
    u::on_physics_after_step(handle, [&](float) {
        u::remove_physics_body(handle, throwing);
        assert(throwing.handle.ownership->body);
        throw std::runtime_error("callback");
    });
    bool threw = false;
    try {
        u::physics_dispatch_after_step(world, 1.0 / 60);
    } catch (const std::runtime_error& error) {
        threw = std::string(error.what()) == "callback";
    }
    assert(threw && !throwing.handle.ownership->body && !world.events->draining &&
           !world.events->removed);
    world.after_step.clear();

    // Real Bullet contact records retain both native IDs, signed separation and FINISHED data.
    const auto ground = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{2}),
                                               u::PhysicsMotionType::STATIC, false);
    engine.meshes[3].position = {0, 1.5, 0};
    const auto ball = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{3}),
                                             u::PhysicsMotionType::DYNAMIC, false);
    const u::PhysicsShape shape{p::physics_shape_create_sphere({0, 0, 0}, 1)};
    u::set_physics_body_shape(handle, ground, shape);
    u::set_physics_body_shape(handle, ball, shape);
    u::set_physics_body_mass(handle, ball, 1);
    u::set_physics_body_collision_events_enabled(handle, ball, true);
    p::physics_world_step(world.handle, 1.0 / 60);
    assert(stream.size() == 1 && stream[0].type == p::PhysicsCollisionEventType::started);
    const auto contact = stream[0];
    assert((contact.collider_identity == ground.handle.value &&
            contact.collided_against_identity == ball.handle.value) ||
           (contact.collider_identity == ball.handle.value &&
            contact.collided_against_identity == ground.handle.value));
    double distance = 0;
    for (std::size_t i = 0; i < 3; ++i)
        distance += (contact.point_other[i] - contact.point[i]) * contact.normal[i];
    assert(distance < 0 && contact.impulse >= 0);
    p::physics_body_set_transform(ball.handle, {{0, 10, 0}, {0, 0, 0, 1}});
    p::physics_world_step(world.handle, 1.0 / 60);
    assert(stream.size() == 1 && stream[0].type == p::PhysicsCollisionEventType::finished);
    assert(stream[0].impulse == 0 && stream[0].collider_identity == contact.collider_identity);
    assert(stream[0].point_other == contact.point_other);
}
