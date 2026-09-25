#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <bblite/upstream/character_controller.hpp>
#include <bit>
#include <cassert>

namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
} // namespace bbl::upstream
namespace bbl {
void flush_thin_instances(Engine& engine, MeshHandle mesh) {
    ++engine.meshes.at(mesh.value).instance_version;
}
TransformNodeHandle create_transform_node(Engine&, std::string, Vec3d, Vec4, Vec3) { std::abort(); }
void set_transform_node_position(Engine&, TransformNodeHandle, Vec3d) { std::abort(); }
} // namespace bbl
namespace p = bbl::pal;
namespace u = bbl::upstream;
void check_transform(const std::vector<float>& matrices, const p::PhysicsTransform& expected) {
    p::PhysicsTransform transform;
    std::array<double, 4> rotation{};
    assert(&u::thin_instance_transform(matrices, 0, transform, rotation) == &transform);
    for (std::size_t i = 0; i < 3; ++i)
        assert(std::abs(transform.position[i] - expected.position[i]) < 1e-13);
    for (std::size_t i = 0; i < 4; ++i)
        assert(std::abs(transform.rotation[i] - expected.rotation[i]) < 1e-13);
}
int main() {
    using namespace bbl;
#include "transforms.inc"
    Engine engine;
    engine.meshes.resize(2);
    Scene scene;
    scene.engine = &engine;
    const auto handle = u::create_havok_world(scene, {0, -10, 0});
    auto& world = *handle.ownership.lock();
    std::vector<float> matrices(48);
    for (std::size_t i = 0; i < 3; ++i)
        u::thin_compose_matrix(matrices, static_cast<double>(i * 16), static_cast<double>(i * 10),
                               10, 0, 0, 0, 0, 1, 1, 1, 1);
    auto& carrier = engine.meshes[0];
    carrier.thin_instanced = true;
    carrier.instance_count = 3;
    carrier.instance_source = &matrices;
    carrier.position = {123, 456, 789};
    const auto ordinary = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{1}),
                                                 u::PhysicsMotionType::STATIC, false);
    assert(u::get_physics_body_instance_count(ordinary) == 1);
    u::enable_havok_thin_instance_physics(handle);
    u::enable_havok_thin_instance_physics(handle);
    const auto body = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                             u::PhysicsMotionType::DYNAMIC, false);
    assert(u::get_physics_body_instance_count(body) == 3);
    auto* state = u::thin_state(world, body.handle);
    assert(state && state->handles.size() == 3);
    const u::PhysicsShape shape{p::physics_shape_create_box({0, 0, 0}, {0, 0, 0, 1}, {2, 2, 2})};
    u::set_physics_body_shape(handle, body, shape);
    u::set_physics_body_mass(handle, body, 2);
    for (const auto& native : state->handles)
        assert(p::physics_body_get_mass_properties(native).mass == 2);
    u::apply_physics_impulse(handle, body, {2, 0, 0}, {});
    for (const auto& native : state->handles)
        assert(std::abs(p::physics_body_get_linear_velocity(native)[0] - 1) < 1e-6);
    u::set_physics_body_motion_type(handle, body, u::PhysicsMotionType::STATIC);
    p::physics_world_step(world.handle, 1.0 / 60);
    for (std::size_t i = 0; i < 3; ++i) {
        const double x = static_cast<double>(i * 10);
        const auto hit = u::physics_raycast(handle, {x, 10, 5}, {x, 10, -5}, ~0u, ~0u, false);
        assert(hit.has_hit && hit.body && *hit.body == body &&
               hit.body_index == static_cast<double>(i));
    }
    const auto miss = u::physics_raycast(handle, {-50, 10, 5}, {-50, 10, -5}, ~0u, ~0u, false);
    assert(!miss.has_hit && !miss.body && miss.body_index == -1);
    matrices[12] = 42;
    assert(u::thin_to(world, body));
    assert(p::physics_body_get_transform(state->handles[0]).position[0] == 42);
    p::physics_body_set_transform(state->handles[2], {{77, 88, 99}, {0, 0, 0, 1}});
    assert(u::thin_from(world, body));
    assert(matrices[44] == 77 && matrices[45] == 88 && matrices[46] == 99);
    assert(carrier.position.x == 123 && carrier.position.y == 456 && carrier.position.z == 789);
    assert(carrier.instance_version == 1);
    std::vector<std::weak_ptr<p::PhysicsBodyState>> native_lifetimes;
    for (const auto& native : state->handles)
        native_lifetimes.push_back(native.ownership);
    u::remove_physics_body(handle, body);
    u::remove_physics_body(handle, body);
    assert(world.thin_states.empty());
    // The public body retains its primary handle. The other instances have no remaining owners.
    assert(native_lifetimes[1].expired() && native_lifetimes[2].expired());
    const auto refuses = [](auto action) {
        try {
            action();
        } catch (const std::runtime_error&) {
            return true;
        }
        return false;
    };
    carrier.instance_count = 0;
    assert(refuses([&] {
        static_cast<void>(u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                 u::PhysicsMotionType::DYNAMIC, false));
    }));
    assert(refuses([&] {
        static_cast<void>(u::create_physics_aggregate(handle, {0}, u::PhysicsShapeType::BOX, {}));
    }));
    carrier.instance_count = 3;
    {
        namespace c = bbl::character;
        const auto instances = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                      u::PhysicsMotionType::DYNAMIC, false);
        u::set_physics_body_shape(handle, instances, shape);
        u::set_physics_body_mass(handle, instances, 2);
        const auto control = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{1}),
                                                    u::PhysicsMotionType::STATIC, false);
        c::PhysicsCharacterController controller(engine);
        controller._world = js::make_ref<c::PhysicsWorld>();
        controller._world->value = handle;
        controller._body = controller._world_bodies().back();
        assert(controller._body->value == control);
        controller._shape = js::make_ref<c::PhysicsShape>();
        controller._startCollector = js::make_ref<c::QueryCollector>();
        controller._castCollector = js::make_ref<c::QueryCollector>();
        const auto& handles = u::thin_state(world, instances.handle)->handles;
        auto first = controller._thin_resolve(handles[0].value);
        auto second = controller._thin_resolve(handles[1].value);
        assert(first && second && std::get<2>(*first) == 0 && std::get<2>(*second) == 1);
        auto alias = std::get<1>(*first);
        assert(alias != controller._native_body(std::get<0>(*first)));
        assert(alias == std::get<1>(*controller._thin_resolve(handles[0].value)));
        controller._apply_impulse(alias, {42, 10, 0}, {2, 0, 0});
        assert(std::abs(p::physics_body_get_linear_velocity(handles[0])[0] - 1) < 1e-6);
        for (std::size_t i = 1; i < handles.size(); ++i)
            assert(p::physics_body_get_linear_velocity(handles[i])[0] == 0);
        const auto first_identity = alias.weak_identity();
        const auto second_identity = std::get<1>(*second).weak_identity();
        alias = {};
        first = std::nullopt;
        second = std::nullopt;
        controller.dispose();
        assert(first_identity.expired() && second_identity.expired());
        u::remove_physics_body(handle, instances);
    }
    u::enable_havok_floating_origin(handle, 100);
    assert(refuses([&] {
        static_cast<void>(u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                 u::PhysicsMotionType::DYNAMIC, false));
    }));
    assert(world.bodies.size() == 1 && world.thin_states.empty());
}
