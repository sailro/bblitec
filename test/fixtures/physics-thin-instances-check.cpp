#include "allocation-tracker.hpp"
#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <bblite/upstream/character_controller.hpp>
#include <bit>
#include <cassert>

namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord& mesh) {
    return {1,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            static_cast<float>(mesh.position.x),
            static_cast<float>(mesh.position.y),
            static_cast<float>(mesh.position.z),
            1};
}
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
} // namespace bbl::upstream
namespace bbl {
void flush_thin_instances(Engine& engine, MeshHandle mesh) {
    ++engine.meshes.at(mesh.value).instance_version;
}
TransformNodeHandle create_transform_node(Engine& engine, std::string name, Vec3d position,
                                          Vec4 rotation, Vec3 scaling) {
    auto& node = engine.transform_nodes.emplace_back();
    node.name = std::move(name);
    node.position = position;
    node.rotation_quaternion = rotation;
    node.scaling = scaling;
    return {static_cast<std::uint32_t>(engine.transform_nodes.size() - 1)};
}
void set_transform_node_position(Engine& engine, TransformNodeHandle node, Vec3d position) {
    engine.transform_nodes.at(node.value).position = position;
}
} // namespace bbl
namespace p = bbl::pal;
namespace u = bbl::upstream;
void check_transform(const std::vector<float>& matrices, const p::PhysicsTransform& expected) {
    for (const std::size_t count : {1u, 1024u}) {
        std::vector<float> pool;
        pool.reserve(count * matrices.size());
        for (std::size_t index = 0; index < count; ++index)
            pool.insert(pool.end(), matrices.begin(), matrices.end());
        p::PhysicsTransform transform;
        std::array<double, 4> rotation{};
        std::vector<double> scratch(16), scales(count * 3);
        for (const bool identity : {true, false}) {
            const std::array<float, 16> carrier{1,
                                                0,
                                                0,
                                                0,
                                                0,
                                                1,
                                                0,
                                                0,
                                                0,
                                                0,
                                                1,
                                                0,
                                                identity ? 0.f : 2.f,
                                                identity ? 0.f : 3.f,
                                                identity ? 0.f : 4.f,
                                                1};
            const auto before = allocation_count;
            assert(&u::thin_instance_transform(pool, static_cast<double>(count - 1), carrier,
                                               identity, scratch, transform, rotation,
                                               scales) == &transform);
            assert(allocation_count == before);
            for (std::size_t i = 0; i < 3; ++i)
                assert(std::abs(transform.position[i] - expected.position[i] - carrier[12 + i]) <
                       1e-13);
            for (std::size_t i = 0; i < 4; ++i)
                assert(std::abs(transform.rotation[i] - expected.rotation[i]) < 1e-13);
        }
    }
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
        const double x = static_cast<double>(i * 10) + 123;
        const auto hit = u::physics_raycast(handle, {x, 466, 794}, {x, 466, 784}, ~0u, ~0u, false);
        assert(hit.has_hit && hit.body && *hit.body == body &&
               hit.body_index == static_cast<double>(i));
    }
    const auto miss = u::physics_raycast(handle, {-50, 10, 5}, {-50, 10, -5}, ~0u, ~0u, false);
    assert(!miss.has_hit && !miss.body && miss.body_index == -1);
    matrices[12] = 42;
    assert(u::thin_to(world, body));
    assert(p::physics_body_get_transform(state->handles[0]).position[0] == 165);
    p::physics_body_set_transform(state->handles[2], {{77, 88, 99}, {0, 0, 0, 1}});
    assert(u::thin_from(world, body));
    assert(matrices[44] == -46 && matrices[45] == -368 && matrices[46] == -690);
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
    {
        u::thin_compose_matrix(matrices, 0, 0, 10, 0, 0, 0, 0, 1, 2, 3, 4);
        u::thin_compose_matrix(matrices, 16, 10, 10, 0, 0, 0, 0, 1, 2, 3, 4);
        u::thin_compose_matrix(matrices, 32, 20, 10, 0, 0, 0, 0, 1, 1, 1, 1);
        u::enable_havok_thin_instance_advanced_physics(handle);
        const auto advanced = u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                     u::PhysicsMotionType::DYNAMIC, false);
        u::set_physics_body_shape(handle, advanced, shape);
        auto& advanced_state = *u::thin_state(world, advanced.handle);
        assert(advanced_state.scaled_shapes.size() == 1);
        const auto first_shape = p::physics_body_get_shape(advanced_state.handles[0]);
        assert(first_shape.value == p::physics_body_get_shape(advanced_state.handles[1]).value);
        assert(first_shape.value != shape.handle.value);
        assert(p::physics_body_get_shape(advanced_state.handles[2]).value == shape.handle.value);
        u::set_physics_body_mass(handle, advanced, 2);
        const auto scaled_mass = p::physics_body_get_mass_properties(advanced_state.handles[0]);
        const auto unit_mass = p::physics_body_get_mass_properties(advanced_state.handles[2]);
        assert(scaled_mass.mass == 2 && unit_mass.mass == 2);
        assert(scaled_mass.inertia[0] > unit_mass.inertia[0]);
        assert(u::physics_thin_count(handle, advanced) == 3);
        assert(!u::physics_thin_count(handle, ordinary));
        assert(!u::physics_thin_instance(handle, advanced, 3));
        const auto instance = *u::physics_thin_instance(handle, advanced, 0);
        const auto snapshot = u::physics_native_get_transform(instance).get<1>();
        u::physics_native_apply_impulse(instance, {123, 466, 789}, {4, 0, 0});
        assert(std::abs(p::physics_body_get_linear_velocity(advanced_state.handles[0])[0] - 2) <
               1e-6);
        assert(p::physics_body_get_linear_velocity(advanced_state.handles[1])[0] == 0);
        u::physics_native_set_linear_velocity(u::physics_native_body(advanced), {3, 2, 1});
        for (const auto& native : advanced_state.handles)
            assert(p::physics_body_get_linear_velocity(native)[0] == 3);
        u::physics_native_set_transform(instance, snapshot);
        u::physics_native_set_active(instance, false);
        assert(!advanced_state.handles[0].ownership->body->isActive());
        u::set_physics_body_velocity(handle, advanced, {4, 5, 6}, false);
        u::set_physics_body_velocity(handle, advanced, {1, 2, 3}, true);
        u::set_physics_body_transform(handle, advanced, {10, 20, 30}, {0, 0, 0, 1});
        for (const auto& native : advanced_state.handles) {
            assert(p::physics_body_get_linear_velocity(native)[0] == 4);
            assert(p::physics_body_get_angular_velocity(native)[1] == 2);
            assert(p::physics_body_get_transform(native).position[2] == 30);
        }
        assert(carrier.position.x == 123 && carrier.position.y == 456 && carrier.position.z == 789);
        u::remove_physics_body(handle, advanced);
    }
    u::set_physics_body_transform(handle, ordinary, {2, 3, 4}, {0, 0, 0, 1});
    u::set_physics_body_velocity(handle, ordinary, {4, 5, 6}, false);
    u::set_physics_body_velocity(handle, ordinary, {1, 2, 3}, true);
    const auto linear = u::get_physics_body_linear_velocity(handle, ordinary);
    const auto angular = u::get_physics_body_angular_velocity(handle, ordinary);
    assert(linear.x == 4 && linear.y == 5 && linear.z == 6);
    assert(angular.x == 1 && angular.y == 2 && angular.z == 3);
    assert(engine.meshes[1].position.x == 2 && engine.meshes[1].position.y == 3);
    assert(p::physics_body_get_transform(ordinary.handle).position[2] == 4);
    const u::PhysicsShape released{p::physics_shape_create_box({0, 0, 0}, {0, 0, 0, 1}, {1, 1, 1})};
    u::release_physics_shape(handle, released);
    assert(refuses([&] { static_cast<void>(p::physics_shape_default_mass(released.handle)); }));
    u::enable_havok_floating_origin(handle, 100);
    assert(refuses([&] {
        static_cast<void>(u::create_physics_body(handle, u::physics_node(bbl::MeshHandle{0}),
                                                 u::PhysicsMotionType::DYNAMIC, false));
    }));
    assert(world.bodies.size() == 1 && world.thin_states.empty());
}
