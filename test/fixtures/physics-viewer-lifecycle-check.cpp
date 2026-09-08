#include <bblite/runtime.hpp>
namespace bbl::upstream { MeshHandle bind_scene_mesh_profile(Engine&, MeshHandle, std::uint32_t); }
#include "pal_physics_bullet.cpp"
#include "physics.cpp"
#include <cassert>
#include <iostream>

std::vector<std::uint32_t> observed_lines;
namespace bbl {
MeshHandle create_mesh_from_data(Engine& engine, const std::string& name,
    const std::vector<float>& positions, const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices, const std::vector<float>&,
    const std::vector<float>&, const std::vector<float>&, const std::vector<float>&) {
    assert(positions.size() == 9 && normals == std::vector<float>(9));
    observed_lines = indices;
    const MeshHandle handle{static_cast<std::uint32_t>(engine.meshes.size())};
    engine.meshes.emplace_back(); engine.meshes.back().name = name;
    return handle;
}
MaterialHandle create_shader_material(Engine& engine, std::uint32_t variant) {
    assert(variant == 7);
    const MaterialHandle handle{static_cast<std::uint32_t>(engine.materials.size())};
    engine.materials.emplace_back(); return handle;
}
}
namespace bbl::upstream {
std::array<float, 16> mesh_local_matrix(const MeshRecord&) { std::abort(); }
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) { std::abort(); }
std::array<float, 16> transform_node_world(const Engine&, TransformNodeHandle) { std::abort(); }
MeshHandle bind_scene_mesh_profile(Engine&, MeshHandle mesh, std::uint32_t profile) { assert(profile == 3); return mesh; }
}
namespace bbl::pal {
PhysicsDebugGeometry materialized_physics_debug_geometry(const PhysicsDebugShapeDescriptor&) {
    static const std::array<float, 9> positions{0,0,0, 1,0,0, 0,1,0};
    static const std::array<std::uint32_t, 3> indices{0,1,2};
    return {positions, indices};
}
}
int main() {
    using namespace bbl;
    using namespace bbl::upstream;
    Engine engine;
    Scene scene; scene.engine = &engine;
    auto world = create_havok_world(scene, {0,0,0});
    const auto base_hooks = scene.before_render.size();
    engine.meshes.emplace_back();
    engine.meshes.back().position = {2,3,4};
    engine.meshes.back().rotation_quaternion = {0,0.6f,0,0.8f};
    engine.meshes.back().scaling = {2,3,4};
    auto body = create_physics_body(world, physics_node(MeshHandle{0}), PhysicsMotionType::STATIC, false);
    auto viewer = create_physics_viewer(scene, world, 7);
    assert(!show_physics_body(viewer, body, 3)); // No assigned shape.
    PhysicsShape shape; shape.handle = pal::physics_shape_create_sphere({0,0,0}, 1);
    set_physics_body_shape(world, body, shape);
    const auto shown = show_physics_body(viewer, body, 3);
    assert(shown && viewer->bodies.size() == 1 && scene.meshes.size() == 1);
    assert((observed_lines == std::vector<std::uint32_t>{0,1,1,2,2,0}));
    assert(scene.before_render.size() == base_hooks + 1);
    assert(!show_physics_body(viewer, body, 3) && engine.meshes.size() == 2);
    auto& mesh = engine.meshes[shown->value];
    assert(mesh.position.x == 2 && mesh.position.y == 3 && mesh.position.z == 4);
    assert(mesh.rotation_quaternion.y == 0.6f && mesh.rotation_quaternion.w == 0.8f);
    assert(mesh.scaling.x == 1 && mesh.scaling.y == 1 && mesh.scaling.z == 1);
    assert(!mesh.pickable && mesh.has_render_order && mesh.render_order == 1000);
    engine.meshes[0].position.x = 19;
    viewer->update(0);
    assert(engine.meshes[shown->value].position.x == 19);
    assert(hide_physics_body(viewer, body));
    assert(!hide_physics_body(viewer, body));
    assert(scene.meshes.empty() && scene.before_render.size() == base_hooks);
    assert(show_physics_body(viewer, body, 3));
    std::weak_ptr<PhysicsViewer> retained = viewer;
    viewer.reset();
    assert(!retained.expired()); // Registration keeps the source closure alive.
    scene.before_render[scene.before_render.size() - 1](0);
    dispose_physics_viewer(retained.lock());
    assert(scene.meshes.empty() && scene.before_render.size() == base_hooks);
    js::collect_cycles();
    assert(retained.expired());
    std::cout << "physics-viewer-lifecycle: ok\n";
}
