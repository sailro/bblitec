#pragma once

#include <BulletDynamics/Dynamics/btDiscreteDynamicsWorld.h>
#include <BulletCollision/CollisionDispatch/btCollisionDispatcher.h>
#include <BulletCollision/CollisionShapes/btCompoundShape.h>
#include <array>
#include <chrono>
#include <cstdio>
#include <mutex>

namespace bbl::pal {

class CollisionPairProfile {
    struct Sample {
        const char* first = nullptr;
        const char* second = nullptr;
        std::size_t calls = 0;
        double milliseconds = 0;
    };
    std::array<Sample, MAX_BROADPHASE_COLLISION_TYPES * MAX_BROADPHASE_COLLISION_TYPES> samples_{};
    std::mutex mutex_;

    static const btCollisionShape* leaf(const btCollisionObject* object) {
        const auto* shape = object->getCollisionShape();
        while (shape->isCompound()) {
            const auto* compound = static_cast<const btCompoundShape*>(shape);
            if (compound->getNumChildShapes() != 1)
                break;
            shape = compound->getChildShape(0);
        }
        return shape;
    }

public:
    void reset() { samples_.fill({}); }
    void process(btBroadphasePair& pair, btCollisionDispatcher& dispatcher,
                 const btDispatcherInfo& info) {
        auto* first = leaf(static_cast<const btCollisionObject*>(pair.m_pProxy0->m_clientObject));
        auto* second = leaf(static_cast<const btCollisionObject*>(pair.m_pProxy1->m_clientObject));
        if (first->getShapeType() > second->getShapeType())
            std::swap(first, second);
        const auto start = std::chrono::steady_clock::now();
        btCollisionDispatcher::defaultNearCallback(pair, dispatcher, info);
        const auto milliseconds =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start)
                .count();
        std::lock_guard lock(mutex_);
        auto& sample = samples_.at(static_cast<std::size_t>(first->getShapeType()) *
                                       MAX_BROADPHASE_COLLISION_TYPES +
                                   static_cast<std::size_t>(second->getShapeType()));
        sample.first = first->getName();
        sample.second = second->getName();
        sample.milliseconds += milliseconds;
        ++sample.calls;
    }
    void write(unsigned long long step) const {
        for (const auto& sample : samples_)
            if (sample.calls)
                std::fprintf(
                    stderr,
                    "[cpu][collision-pair] step=%llu first=%s second=%s calls=%zu ms=%.3f\n", step,
                    sample.first, sample.second, sample.calls, sample.milliseconds);
    }
};

struct PhysicsWorldPhaseTimes {
    double collision = 0, aabbs = 0, broadphase = 0, constraints = 0, islands = 0, predict = 0,
           integrate = 0, activate = 0, synchronize = 0;
};

struct PhysicsSolverPhaseTimes {
    double setup = 0, contacts = 0, split = 0, iterations = 0, finish = 0;
    std::size_t calls = 0, rows = 0, batches = 0, phases = 0;
};

class PhysicsPhaseTimer {
    double* total_;
    std::chrono::steady_clock::time_point started_{};

public:
    explicit PhysicsPhaseTimer(double* total) : total_(total) {
        if (total_)
            started_ = std::chrono::steady_clock::now();
    }
    ~PhysicsPhaseTimer() {
        if (total_)
            *total_ += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() -
                                                                 started_)
                           .count();
    }
};

/** Phase timing around unchanged Bullet operations; instantiated only for CPU profiling. */
template <typename World> class ProfiledDynamicsWorld final : public World {
    template <typename F> void measure(double& total, F operation) {
        const auto start = std::chrono::steady_clock::now();
        operation();
        total += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start)
                     .count();
    }

public:
    using World::World;
    PhysicsWorldPhaseTimes times;
    void performDiscreteCollisionDetection() override {
        measure(times.collision, [&] { World::performDiscreteCollisionDetection(); });
    }
    void updateAabbs() override {
        measure(times.aabbs, [&] { World::updateAabbs(); });
    }
    void computeOverlappingPairs() override {
        measure(times.broadphase, [&] { World::computeOverlappingPairs(); });
    }
    void solveConstraints(btContactSolverInfo& info) override {
        measure(times.constraints, [&] { World::solveConstraints(info); });
    }
    void calculateSimulationIslands() override {
        measure(times.islands, [&] { World::calculateSimulationIslands(); });
    }
    void predictUnconstraintMotion(btScalar delta) override {
        measure(times.predict, [&] { World::predictUnconstraintMotion(delta); });
    }
    void integrateTransforms(btScalar delta) override {
        measure(times.integrate, [&] { World::integrateTransforms(delta); });
    }
    void updateActivationState(btScalar delta) override {
        measure(times.activate, [&] { World::updateActivationState(delta); });
    }
    void synchronizeMotionStates() override {
        measure(times.synchronize, [&] { World::synchronizeMotionStates(); });
    }
};

} // namespace bbl::pal
