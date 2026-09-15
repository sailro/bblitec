#pragma once

#include <BulletDynamics/Dynamics/btDiscreteDynamicsWorld.h>
#include <chrono>

namespace bbl::pal {

/** Phase timing around unchanged Bullet operations; instantiated only for CPU profiling. */
class ProfiledDynamicsWorld final : public btDiscreteDynamicsWorld {
    template <typename F> void measure(double& total, F operation) {
        const auto start = std::chrono::steady_clock::now();
        operation();
        total += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    }
public:
    using btDiscreteDynamicsWorld::btDiscreteDynamicsWorld;
    struct Times { double collision = 0, aabbs = 0, broadphase = 0, constraints = 0, islands = 0, predict = 0, integrate = 0, activate = 0, synchronize = 0; } times;
    void performDiscreteCollisionDetection() override { measure(times.collision, [&] { btDiscreteDynamicsWorld::performDiscreteCollisionDetection(); }); }
    void updateAabbs() override { measure(times.aabbs, [&] { btDiscreteDynamicsWorld::updateAabbs(); }); }
    void computeOverlappingPairs() override { measure(times.broadphase, [&] { btDiscreteDynamicsWorld::computeOverlappingPairs(); }); }
    void solveConstraints(btContactSolverInfo& info) override { measure(times.constraints, [&] { btDiscreteDynamicsWorld::solveConstraints(info); }); }
    void calculateSimulationIslands() override { measure(times.islands, [&] { btDiscreteDynamicsWorld::calculateSimulationIslands(); }); }
    void predictUnconstraintMotion(btScalar delta) override { measure(times.predict, [&] { btDiscreteDynamicsWorld::predictUnconstraintMotion(delta); }); }
    void integrateTransforms(btScalar delta) override { measure(times.integrate, [&] { btDiscreteDynamicsWorld::integrateTransforms(delta); }); }
    void updateActivationState(btScalar delta) override { measure(times.activate, [&] { btDiscreteDynamicsWorld::updateActivationState(delta); }); }
    void synchronizeMotionStates() override { measure(times.synchronize, [&] { btDiscreteDynamicsWorld::synchronizeMotionStates(); }); }
};

} // namespace bbl::pal
