#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>
#include <iostream>

// Geometry aggregation is outside this lifetime fixture. Refuse any accidental
// call instead of linking the renderer merely to provide its transform entry.
namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
}

int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    auto survivor = std::make_unique<Engine>();
    Scene surviving_scene;
    surviving_scene.engine = survivor.get();
    auto surviving_world = create_havok_world(surviving_scene, {0, -9.81, 0});

    for (int iteration = 0; iteration < 100; ++iteration) {
        Scene retained_scene;
        PhysicsWorldHandle retained_world;
        PhysicsBody retained_body;
        std::weak_ptr<pal::PhysicsWorldState> native_world;
        std::weak_ptr<pal::PhysicsBodyState> native_body;
        std::weak_ptr<pal::PhysicsShapeState> native_shape;
        std::weak_ptr<int> callback_capture;
        {
            auto engine = std::make_unique<Engine>();
            retained_scene.engine = engine.get();
            retained_world = create_havok_world(retained_scene, {0, -9.81, 0});
            auto world = retained_world.ownership.lock();
            native_world = world->handle.ownership;
            auto capture = std::make_shared<int>(0);
            callback_capture = capture;
            on_physics_after_step(retained_world, [capture](float) { ++*capture; });
            retained_scene.before_render.front()(20);
            assert(*capture == 1);
            enable_havok_floating_origin(retained_world, 100);
            engine->meshes.emplace_back();
            engine->meshes.back().position.x = 200; // A second floating-origin region.
            retained_body = create_physics_body(retained_world, physics_node(MeshHandle{0}),
                PhysicsMotionType::DYNAMIC, false);
            native_body = retained_body.handle.ownership;
            PhysicsShape shape;
            shape.handle = pal::physics_shape_create_sphere({0, 0, 0}, 0.5);
            native_shape = shape.handle.ownership;
            set_physics_body_shape(retained_world, retained_body, shape);
            retained_scene.fixed_delta_ms = 20;
            assert(world_step_seconds(*world) == 0.02);
            retained_scene.before_render.front()(20);
        }
        assert(retained_world.ownership.expired());
        assert(retained_body.owner.expired());
        assert(native_world.expired());
        assert(callback_capture.expired());
        assert(!native_body.expired() && !native_shape.expired());
        assert(!retained_body.region.ownership->world); // Retained region was closed.
        assert(retained_body.region.ownership->members.empty());
        retained_scene.before_render.front()(20); // Engine is gone: no callback/dangling access.
        bool refused = false;
        try { set_physics_timestep_ms(retained_world, 20); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
        refused = false;
        try { set_physics_body_pre_step(retained_body, true); }
        catch (const std::runtime_error&) { refused = true; }
        assert(refused);
        retained_body = {};
        assert(native_body.expired() && native_shape.expired());
        surviving_scene.before_render.front()(20);
        assert(!surviving_world.ownership.expired());
    }
    survivor.reset();
    assert(surviving_world.ownership.expired());
    surviving_scene.before_render.front()(20);
    std::cout << "physics-lifetime-check: ok\n";
}
