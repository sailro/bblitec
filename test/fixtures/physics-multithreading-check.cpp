#include "pal_physics_bullet.cpp"
#include <array>
#include <atomic>
#include <cassert>
#include <future>
#include <iostream>
#include <set>

using namespace bbl::pal;

static_assert(sizeof(btSimdScalar) == 16);
static_assert(sizeof(btSolverConstraint) == 192);

void run_world() {
    const auto world = physics_world_create();
    physics_world_set_gravity(world, {0, -10, 0});
    const auto floor = physics_shape_create_box({0, -.5, 0}, {0, 0, 0, 1}, {20, 1, 20});
    const auto ground = physics_body_create();
    physics_body_set_shape(ground, floor);
    physics_world_add_body(world, ground, false);
    const auto box = physics_shape_create_box({0, 0, 0}, {0, 0, 0, 1}, {.7, .7, .7});
    std::vector<PhysicsBodyHandle> bodies;
    for (int y = 0; y < 8; ++y)
        for (int x = 0; x < 8; ++x)
            for (int z = 0; z < 8; ++z) {
                const auto body = physics_body_create();
                physics_body_set_shape(body, box);
                physics_body_set_motion_type(body, PhysicsMotionType::simulated);
                physics_body_set_mass_properties(body, physics_shape_build_mass_properties(box, 1));
                physics_body_set_transform(body, {{(x - 4) * .7, y * .7 + .34, (z - 4) * .7}});
                physics_body_set_collision_events_enabled(body, true);
                physics_world_add_body(world, body, false);
                bodies.push_back(body);
            }
    int maximum_manifolds = 0;
    for (int frame = 0; frame < 90; ++frame) {
        physics_world_step(world, 1.0 / 60);
        maximum_manifolds =
            std::max(maximum_manifolds, world_at(world).dispatcher->getNumManifolds());
        for (const auto& body : bodies) {
            const auto transform = physics_body_get_transform(body);
            for (const auto lane : transform.position)
                assert(std::isfinite(lane));
            for (const auto lane : transform.rotation)
                assert(std::isfinite(lane));
            assert(transform.position[1] > -.2 && transform.position[1] < 7);
        }
    }
    assert(maximum_manifolds > 250);
    assert(!physics_world_collision_events(world).empty());
    for (const auto& body : bodies) {
        physics_world_remove_body(world, body);
        physics_body_release(body);
    }
    physics_world_remove_body(world, ground);
    physics_body_release(ground);
    physics_world_release(world);
    physics_shape_release(box);
    physics_shape_release(floor);
}

int main() {
    try {
        auto& scheduler = physics_scheduler();
        scheduler.run([&] {
            struct Sum final : btIParallelSumBody {
                btScalar sumLoop(int begin, int end) const override {
                    btScalar result = 0;
                    for (int index = begin; index < end; ++index)
                        result += static_cast<btScalar>(index % 17) / 8;
                    return result;
                }
            } sum;
            btScalar expected = 0;
            for (int begin = 0; begin < 4096; begin += 64)
                expected += sum.sumLoop(begin, begin + 64);
            for (int repeat = 0; repeat < 32; ++repeat)
                assert(btParallelSum(0, 4096, 64, sum) == expected);
            std::array<std::atomic<unsigned>, 128> visits{};
            struct Visits final : btIParallelForBody {
                std::array<std::atomic<unsigned>, 128>& visits;
                const btIParallelSumBody& nested;
                Visits(std::array<std::atomic<unsigned>, 128>& counters,
                       const btIParallelSumBody& operation)
                    : visits(counters), nested(operation) {}
                void forLoop(int begin, int end) const override {
                    assert(btParallelSum(0, 8, 1, nested) == 3.5f);
                    for (int index = begin; index < end; ++index)
                        ++visits[static_cast<std::size_t>(index - 5)];
                }
            } visit(visits, sum);
            for (const int count : {0, 1, 3, 4, 7, 8, 13, 31, 64, 127}) {
                for (const int grain : {1, 3, 16}) {
                    for (auto& value : visits)
                        value = 0;
                    btParallelFor(5, 5 + count, grain, visit);
                    for (std::size_t index = 0; index < visits.size(); ++index)
                        assert(visits[index] ==
                               static_cast<unsigned>(index < static_cast<std::size_t>(count)));
                }
            }
            struct Failure final : btIParallelForBody {
                void forLoop(int, int) const override {
                    throw std::runtime_error("worker failure");
                }
            } failure;
            bool propagated = false;
            try {
                btParallelFor(0, 4096, 64, failure);
            } catch (const std::runtime_error& error) {
                propagated = std::string_view(error.what()) == "worker failure";
            }
            assert(propagated);
            assert(btParallelSum(0, 4096, 64, sum) == expected);
            propagated = false;
            try {
                btParallelFor(0, 4, 1, failure);
            } catch (const std::runtime_error& error) {
                propagated = std::string_view(error.what()) == "worker failure";
            }
            assert(propagated);
            assert(btParallelSum(0, 4096, 64, sum) == expected);
            PhysicsWorkerPool serial;
            serial.setNumThreads(1);
            bool refused = false;
            try {
                serial.setNumThreads(1);
            } catch (const std::logic_error&) {
                refused = true;
            }
            assert(refused);
        });
        auto first = std::async(std::launch::async, run_world);
        auto second = std::async(std::launch::async, run_world);
        first.get();
        second.get();
        std::cout << "physics-multithreading: ok\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
