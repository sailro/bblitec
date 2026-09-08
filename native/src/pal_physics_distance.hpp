#pragma once
#include <BulletDynamics/ConstraintSolver/btGeneric6DofSpring2Constraint.h>

namespace bbl::pal {

// Havok's radial row predicts the next substep's anchors. The frame's
// initial limit error supplies a 40% stabilization offset; the remaining
// correction is the predicted distance's signed violation of the interval.
class RadialDistanceConstraint final : public btGeneric6DofSpring2Constraint {
    btScalar minimum_;
    btScalar maximum_;
    btScalar stabilization_ = 0;
    btScalar step_scale_ = 1;
    int radial_row_ = 0;

    btScalar violation(btScalar distance) const {
        return distance - btClamped(distance, minimum_, maximum_);
    }

public:
    RadialDistanceConstraint(btRigidBody& parent, btRigidBody& child,
        const btTransform& parent_frame, const btTransform& child_frame, btScalar minimum, btScalar maximum)
        : btGeneric6DofSpring2Constraint(parent, child, parent_frame, child_frame), minimum_(minimum), maximum_(maximum) {}

    void begin_frame(btScalar step_scale) {
        const auto a = m_rbA.getWorldTransform() * getFrameOffsetA();
        const auto b = m_rbB.getWorldTransform() * getFrameOffsetB();
        stabilization_ = btScalar(0.4) * violation((b.getOrigin() - a.getOrigin()).length());
        step_scale_ = step_scale;
    }

    void getInfo1(btConstraintInfo1* info) override {
        btGeneric6DofSpring2Constraint::getInfo1(info);
        radial_row_ = info->m_numConstraintRows++;
        info->nub = 0;
    }

    void getInfo2(btConstraintInfo2* info) override {
        btGeneric6DofSpring2Constraint::getInfo2(info);
        const btScalar dt = 1 / info->fps;
        const auto velocity_a = m_rbA.getLinearVelocity() + m_rbA.getTotalForce() * (m_rbA.getInvMass() * dt);
        const auto velocity_b = m_rbB.getLinearVelocity() + m_rbB.getTotalForce() * (m_rbB.getInvMass() * dt);
        const auto angular_a = m_rbA.getAngularVelocity() + m_rbA.getInvInertiaTensorWorld() * m_rbA.getTotalTorque() * dt;
        const auto angular_b = m_rbB.getAngularVelocity() + m_rbB.getInvInertiaTensorWorld() * m_rbB.getTotalTorque() * dt;
        btTransform a, b;
        btTransformUtil::integrateTransform(m_rbA.getWorldTransform(), velocity_a, angular_a, dt, a);
        btTransformUtil::integrateTransform(m_rbB.getWorldTransform(), velocity_b, angular_b, dt, b);
        const auto parent_offset = a.getBasis() * getFrameOffsetA().getOrigin();
        const auto child_offset = b.getBasis() * getFrameOffsetB().getOrigin();
        const auto separation = b.getOrigin() + child_offset - a.getOrigin() - parent_offset;
        const auto distance = separation.length();
        const auto normal = distance > SIMD_EPSILON ? separation / distance : btVector3(1, 0, 0);
        const auto parent_angular = parent_offset.cross(-normal);
        const auto child_angular = child_offset.cross(normal);
        const auto offset = radial_row_ * info->rowskip;
        for (int lane = 0; lane < 3; ++lane) {
            info->m_J1linearAxis[offset + lane] = -normal[lane];
            info->m_J2linearAxis[offset + lane] = normal[lane];
            info->m_J1angularAxis[offset + lane] = parent_angular[lane];
            info->m_J2angularAxis[offset + lane] = child_angular[lane];
        }
        const auto velocity = normal.dot(velocity_b - velocity_a) +
            parent_angular.dot(angular_a) + child_angular.dot(angular_b);
        // The pin's default ideal step scales stiffness for short substeps.
        info->m_constraintError[offset] = velocity + (stabilization_ - violation(distance)) * info->fps * step_scale_;
    }
};
} // namespace bbl::pal
