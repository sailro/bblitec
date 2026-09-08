#include "pal_physics_bullet.cpp"
#include <iomanip>
#include <iostream>
using namespace bbl::pal;

void print_pose(PhysicsBodyHandle body) {
    const auto pose = physics_body_get_transform(body);
    std::cout << '[';
    bool first = true;
    const auto values = [&](const auto& vector) {
        for (const auto value : vector) { if (!first) std::cout << ','; first = false; std::cout << value; }
    };
    values(pose.position); values(pose.rotation);
    values(physics_body_get_linear_velocity(body)); values(physics_body_get_angular_velocity(body));
    std::cout << ']';
}

int main() {
    std::cout << std::setprecision(17) << "{\"teleports\":[";
    bool first = true;
    for (const auto dt : {1.0/60, 1.0/120, 1.0/240}) {
        const auto world = physics_world_create();
        physics_world_set_gravity(world, {0,0,0});
        const auto body = physics_body_create();
        const auto box = physics_shape_create_box({0,0,0}, {0,0,0,1}, {1,1,1});
        physics_body_set_shape(body, box);
        physics_body_set_motion_type(body, PhysicsMotionType::node_driven);
        physics_body_set_transform(body, {{5,-2,-4}, {0,0,0,1}});
        physics_world_add_body(world, body, false);
        if (!first) std::cout << ',';
        first = false;
        std::cout << '['; print_pose(body);
        physics_world_step(world, dt); std::cout << ','; print_pose(body);
        physics_body_set_transform(body, {{1,2,3}, {0,std::sin(.2),0,std::cos(.2)}});
        std::cout << ','; print_pose(body);
        for (int step = 0; step < 2; ++step) { physics_world_step(world, dt); std::cout << ','; print_pose(body); }
        std::cout << ']';
        physics_world_release(world);
    }
    std::cout << "],\"boxQueries\":[";
    first = true;
    for (const double size : {.2,1.0,2.0,10.0}) for (const double y : {0.0,.3,.6,1.1}) {
        const auto world = physics_world_create();
        const auto body = physics_body_create();
        const auto box = physics_shape_create_box({0,0,0}, {0,0,0,1}, {size,size,size});
        const auto capsule = physics_shape_create_capsule({0,.3,0}, {0,-.3,0}, .6);
        physics_body_set_shape(body, box);
        physics_body_set_motion_type(body, PhysicsMotionType::immovable);
        physics_world_add_body(world, body, false);
        physics_world_step(world, 1.0/60);
        for (const bool cast : {false,true}) {
            const std::array<double,3> from{size/2+.65,y,0};
            const auto hits = cast
                ? physics_world_collect_shape_cast(world, capsule, {0,0,0,1}, from, {size/2-.15,y,0}, false, {}, 8)
                : physics_world_collect_shape_proximity(world, capsule, {from,{0,0,0,1}}, .2, false, {}, 8);
            if (!first) std::cout << ',';
            first = false;
            std::cout << '[';
            bool first_hit = true;
            for (const auto& hit : hits) {
                if (!first_hit) std::cout << ',';
                first_hit = false;
                std::cout << '[' << hit.distance_or_fraction;
                for (const auto& vector : {hit.input_point,hit.point,hit.input_normal,hit.normal}) for (const double value : vector) std::cout << ',' << value;
                std::cout << ']';
            }
            std::cout << ']';
        }
        physics_world_release(world);
    }
    std::cout << "]}\n";
}
