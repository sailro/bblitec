#include "pal_physics_bullet.cpp"
#include <cassert>
#include <iomanip>
#include <iostream>
using namespace bbl::pal;

int main() {
    std::cout << std::setprecision(17);
    const auto world = physics_world_create();
    physics_world_set_gravity(world, {0, 0, 0});
    const auto capsule = physics_shape_create_capsule({0, .3, 0}, {0, -.3, 0}, .6);
    const auto box = physics_shape_create_box({0, 0, 0}, {0, 0, 0, 1}, {.2, 2, 2});
    const auto floor = physics_shape_create_mesh({{-5, 0, -5}, {5, 0, -5}, {5, 0, 5}, {-5, 0, 5}}, {0, 2, 1, 0, 3, 2});
    std::vector<PhysicsBodyHandle> bodies;
    for (const auto& [shape, transform] : std::vector<std::pair<PhysicsShapeHandle, PhysicsTransform>>{
        {floor, {}}, {box, {{.75, 1, 0}, {0, 0, 0, 1}}}, {box, {{-.75, 1, 0}, {0, 0, 0, 1}}}, {capsule, {{0, .9, 0}, {0, 0, 0, 1}}}}) {
        const auto body = physics_body_create();
        physics_body_set_shape(body, shape);
        physics_body_set_motion_type(body, PhysicsMotionType::immovable);
        physics_body_set_transform(body, transform);
        physics_world_add_body(world, body, false);
        bodies.push_back(body);
    }
    physics_world_step(world, 1.0 / 60);
    const PhysicsTransform pose{{0, .9, 0}, {0, 0, 0, 1}};
    const auto proximity = physics_world_collect_shape_proximity(world, capsule, pose, .15, false, bodies[3], 16);
    const auto cast = physics_world_collect_shape_cast(world, capsule, pose.rotation, pose.position, {2, .9, 0}, false, bodies[3], 16);
    assert(proximity.size() >= 3);
    assert(!cast.empty());
    assert(physics_world_collect_shape_proximity(world, capsule, pose, .15, false, bodies[3], 1).size() == 1);
    assert(physics_world_collect_shape_cast(world, capsule, pose.rotation, pose.position, {2, .9, 0}, false, bodies[3], 1).size() == 1);
    std::cout << '[';
    bool first_query = true;
    for (const auto& hits : {proximity, cast}) {
        if (!first_query) std::cout << ',';
        first_query = false;
        std::cout << '[';
        bool first_hit = true;
        for (const auto& hit : hits) {
            assert(hit.body_identity != bodies[3].value);
            auto body = std::find_if(bodies.begin(), bodies.end(), [&](const auto& value) { return value.value == hit.body_identity; });
            assert(body != bodies.end());
            if (!first_hit) std::cout << ',';
            first_hit = false;
            std::cout << '[' << std::distance(bodies.begin(), body) << ',' << hit.distance_or_fraction;
            for (const auto& vector : {hit.input_point, hit.point, hit.input_normal, hit.normal}) for (double value : vector) std::cout << ',' << value;
            std::cout << ']';
        }
        std::cout << ']';
    }
    std::cout << "]\n";
    physics_shape_set_trigger(box, true);
    const auto no_triggers = physics_world_collect_shape_proximity(world, capsule, pose, .15, false, bodies[3], 16);
    assert(std::all_of(no_triggers.begin(), no_triggers.end(), [&](const auto& hit) { return hit.body_identity == bodies[0].value; }));
    assert(physics_world_collect_shape_proximity(world, capsule, pose, .15, true, bodies[3], 16).size() == proximity.size());
    const PhysicsMassProperties authored{{.1,.2,.3}, .37, {.2,.3,.4}, {0,0,0,1}};
    physics_body_set_mass_properties(bodies[3], authored);
    const auto properties = physics_body_get_mass_properties(bodies[3]);
    assert(std::abs(properties.mass - authored.mass) < 1e-7);
    for (std::size_t i = 0; i < 3; ++i) {
        assert(std::abs(properties.center_of_mass[i] - authored.center_of_mass[i]) < 1e-7);
        assert(std::abs(properties.inertia[i] - authored.inertia[i]) < 1e-7);
    }
    physics_world_release(world);
}
