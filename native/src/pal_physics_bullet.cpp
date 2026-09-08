/**
 * The rigid-body solver: Bullet behind the pin's own `HP_*` surface.
 *
 * Nothing in this file is Babylon behaviour. `upstream/physics.hpp` owns the
 * step gate, the four phases of a frame, the aggregate's ordering and the
 * bounding-box shape sizing, all lowered from `src/physics/havok.ts`; what
 * lives here is the translation from that surface to one library's API —
 * the same division `pal_sdl_gpu.cpp` keeps against the render plan.
 *
 * Bullet was chosen on licensing: it is Zlib, which this project can ship.
 * It is also the closest available relative of the reference, since
 * Babylon's legacy `AmmoJSPlugin` is Bullet compiled to WebAssembly — but
 * "closest available" is not "the same". `docs/fidelity.md#physics-contract`
 * carries what the substitution costs and how it is measured; the three
 * places this file has to do something Havok does not are commented where
 * they happen rather than restated here.
 */

#include "bblite/pal_physics.hpp"
#include "pal_handle_identity.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

#include <btBulletDynamicsCommon.h>
#include <BulletCollision/CollisionShapes/btConvexPolyhedron.h>
#include <BulletCollision/CollisionShapes/btBvhTriangleMeshShape.h>
#include <BulletCollision/CollisionShapes/btConvexTriangleMeshShape.h>
#include <BulletCollision/CollisionShapes/btTriangleMesh.h>
#include <BulletCollision/Gimpact/btGImpactCollisionAlgorithm.h>
#include <BulletCollision/Gimpact/btGImpactShape.h>
#include <BulletCollision/NarrowPhaseCollision/btGjkPairDetector.h>
#include <BulletCollision/NarrowPhaseCollision/btPointCollector.h>
#include <BulletCollision/NarrowPhaseCollision/btGjkEpaPenetrationDepthSolver.h>

namespace bbl::pal {
namespace {

/**
 * Bullet's own convex margin, not a value chosen here. A degenerate box axis
 * is grown to it in `physics_shape_create_box`; nothing else in this file
 * touches a shape's margin, because Bullet's per-shape margin is not one
 * convention — a `btSphereShape`'s margin IS its radius, so a single value
 * applied across shape kinds moves surfaces rather than aligning them.
 */
constexpr btScalar convex_margin = CONVEX_DISTANCE_MARGIN;

/**
 * Havok's `HP_World_Step(dt)` integrates in fixed 1/240 s sub-steps, as many
 * as the step holds, and Bullet's semi-implicit Euler step is the same
 * integrator, so it walks the same grid here. The measurement behind this
 * and the contact model below is docs/fidelity.md#physics-contract.
 */
constexpr double havok_substep_seconds = 1.0 / 240.0;

/*
 * Havok's contact model, reproduced in three parts:
 *
 * 1. A contact is speculative: a manifold's breaking threshold covers the
 *    pair's approach over one sub-step (`speculative_breaking_threshold`),
 *    so Bullet's own positive-distance solver rule
 *    (`velocityError = restitution - rel_vel - distance / dt`) lands a body
 *    exactly on the surface. Such a point gets no restitution
 *    (`combine_material_contact`), or that rule would spend the rebound on
 *    closing the gap.
 * 2. The rebound happens in the NEXT step and holds through every sub-step
 *    of it (`apply_active_bounces`).
 * 3. The rebound speed is the fitted `e·sqrt((v_a - g·dt)² - 2·g·d_k)`
 *    (`schedule_landing_bounces`).
 *
 * Friction, position correction and stacking stay Bullet's.
 */

/**
 * Havok damps by `v *= 1 - d·δ` per sub-step where Bullet damps by
 * `v *= (1 - d)^δ`; this is the Bullet coefficient with the same per-sub-step
 * factor. At Havok's default angular 0.1 the two differ by 5% per second.
 */
btScalar havok_damping(btScalar havok) {
    return btScalar(1) -
           static_cast<btScalar>(std::pow(
               1.0 - static_cast<double>(havok) * havok_substep_seconds,
               1.0 / havok_substep_seconds));
}

/**
 * `HP_World_GetSpeedLimit` on the reached Havok world reports these default
 * body-speed limits. Havok applies them as part of an impulse write (the
 * boombox shard is exactly 100 rad/s before its first step), whereas Bullet
 * has no finite rigid-body speed limit of its own. Keep the substitution at
 * the PAL boundary instead of changing the demo's impulse.
 */
constexpr btScalar default_max_linear_speed = btScalar(200);
constexpr btScalar default_max_angular_speed = btScalar(100);
constexpr btScalar default_linear_damping = btScalar(0);
constexpr btScalar default_angular_damping = btScalar(0.1);

/**
 * Havok's resting-contact solver converges the reached shard trace to exact
 * zero: its last two movers are at 0.301/1.982 (linear/angular) after 150
 * steps, 0.019/0.215 after 180, and zero by 240. Bullet otherwise leaves a
 * small contact-jitter tail for roughly twice as long. Stabilize only bodies
 * which stay below that late-motion envelope while touching another body;
 * free bodies retain their velocity and any later contact or impulse wakes a
 * stabilized body through Bullet's ordinary island activation.
 */
constexpr btScalar contact_rest_linear_speed = btScalar(0.3);
constexpr btScalar contact_rest_angular_speed = btScalar(2.0);
constexpr double contact_rest_seconds = 0.25;

/** The friction and restitution a shape carries until a material is set. */
struct ShapeMaterial {
    btScalar friction = 0;
    btScalar restitution = 0;
    PhysicsMaterialCombine friction_combine =
        PhysicsMaterialCombine::minimum;
    PhysicsMaterialCombine restitution_combine =
        PhysicsMaterialCombine::maximum;
};

} // namespace

struct PhysicsShapeState {
    const std::uint32_t identity = next_handle_identity<PhysicsShapeState, 0x7fffffffu>();
    /**
     * The triangle soup a `btBvhTriangleMeshShape` indexes. Bullet's shape
     * keeps a raw pointer into it, so the soup is owned here and declared
     * BEFORE the shape: members destroy in reverse declaration order, which
     * puts the shape's death first. Null for every other shape kind.
     */
    std::vector<PhysicsBodyState*> users;
    std::unique_ptr<btTriangleMesh> triangle_mesh;
    std::unique_ptr<btCollisionShape> shape;
    // Dynamic users retain a GImpact view of the same triangles. Static
    // users keep their BVH and its existing query/contact behavior.
    std::unique_ptr<btGImpactMeshShape> moving_mesh;
    /**
     * Transform from Bullet's centre-of-mass/principal-axis body frame into
     * the node-local frame the pin exposes. A primitive contributes its
     * authored centre; a convex hull contributes its computed centre and
     * inertia orientation.
     */
    btTransform node_from_body{btTransform::getIdentity()};
    PhysicsMassProperties mass_properties{};
    bool has_exact_mass_properties = false;
    ShapeMaterial material{};
    std::uint32_t membership_mask = 0xffffffffu;
    std::uint32_t collide_mask = 0xffffffffu;
    /**
     * `HP_Shape_SetTrigger`. Havok flags the SHAPE; Bullet's equivalent --
     * `CF_NO_CONTACT_RESPONSE` -- is a property of the collision object, so
     * the flag is recorded here and applied to whichever bodies wear the
     * shape.
     */
    bool is_trigger = false;
};

namespace {

/** A body's linear and angular velocity at one instant. */
struct BodyVelocity {
    btVector3 linear{0, 0, 0};
    btVector3 angular{0, 0, 0};
};

} // namespace

struct PhysicsBodyState {
    const std::uint32_t identity = next_handle_identity<PhysicsBodyState, 0x7fffffffu>();
    // Members destroy in reverse declaration order: the rigid body must die
    // before the motion state pointer it references.
    std::unique_ptr<btDefaultMotionState> motion_state;
    /**
     * The geometry this body wears when its centre of mass is not the
     * shape's own. Bullet centres a collision shape on the body origin and
     * integrates that origin as the centre of mass, so an authored centre
     * moves the geometry the other way — which needs a per-body child
     * transform the shared shape record cannot carry. Null for every body
     * that keeps the shape's centre, and declared before `body` for the
     * same reason `motion_state` is.
     */
    std::unique_ptr<btCompoundShape> mass_frame_shape;
    /**
     * Two constants of the geometry this body is wearing right now -- the
     * compound above when there is one, the shared shape otherwise: its
     * angular motion disc, and its share of a manifold's default breaking
     * threshold. Bullet recomputes each through a virtual bounding-sphere
     * evaluation on every read and both are read per pair per sub-step, so
     * they are written by `set_body_collision_shape` -- the one writer of
     * the body's collision shape -- rather than derived at each read.
     */
    btScalar motion_disc = 0;
    btScalar contact_breaking_threshold = 0;
    std::unique_ptr<btRigidBody> body;
    btTransform node_from_body{btTransform::getIdentity()};
    std::uint32_t world = 0;
    std::weak_ptr<PhysicsWorldState> owner_world;
    bool start_asleep = false;
    bool in_world = false;
    /**
     * Set whenever a write invalidates what `addRigidBody` recorded, and
     * flushed by the next step. See `flush_pending_readds`.
     */
    bool needs_readd = false;
    bool contacting = false;
    double contact_quiet_seconds = 0.0;
    /**
     * The node transform the pin last wrote. `createPhysicsBody` writes it
     * before `setPhysicsBodyShape` runs, so the shape's own centre offset is
     * not known yet; re-applying this when the shape arrives is what puts
     * the body where the pin asked for it.
     */
    PhysicsTransform requested{};
    std::shared_ptr<PhysicsShapeState> shape;
    bool collision_events_enabled = false;
    /**
     * The velocity at the start of the current `HP_World_Step` -- Havok's
     * approach speed `v_a` -- and at the start of the current sub-step, which
     * the landing test reads back once Bullet's solver has run.
     */
    BodyVelocity step_start{};
    BodyVelocity substep_start{};
    ~PhysicsBodyState() {
        body.reset();
        if (shape) std::erase(shape->users, this);
    }
};

namespace {

/**
 * One scheduled Havok rebound between two bodies, along Bullet's normal on
 * B (it points from B towards A): A is pushed along it and B against it,
 * and a static side simply ignores its impulse.
 */
struct HavokBounce {
    btRigidBody* body_a = nullptr;
    btRigidBody* body_b = nullptr;
    btVector3 local_point_a{0, 0, 0};
    btVector3 local_point_b{0, 0, 0};
    btVector3 normal{0, 1, 0};
    btScalar separating_speed = 0;
    btScalar gravity_into = 0;
};

btScalar speculative_breaking_threshold(
    const btCollisionObject* a,
    const btCollisionObject* b,
    btScalar substep_seconds);

/**
 * The dispatcher that hands every new manifold its speculative threshold;
 * the manifolds already alive are refreshed before each sub-step.
 */
class SpeculativeDispatcher final : public btCollisionDispatcher {
public:
    using btCollisionDispatcher::btCollisionDispatcher;
    btScalar substep_seconds = static_cast<btScalar>(havok_substep_seconds);

    btPersistentManifold* getNewManifold(
        const btCollisionObject* a,
        const btCollisionObject* b) override {
        btPersistentManifold* manifold =
            btCollisionDispatcher::getNewManifold(a, b);
        manifold->setContactBreakingThreshold(
            speculative_breaking_threshold(a, b, substep_seconds));
        return manifold;
    }
};

struct ContactSnapshot {
    std::array<double, 3> point{};
    std::array<double, 3> normal{};
    double impulse = 0.0;
};

} // namespace

struct PhysicsWorldState {
    const std::uint32_t identity = next_handle_identity<PhysicsWorldState, 0x7fffffffu>();
    std::unique_ptr<btDefaultCollisionConfiguration> configuration;
    std::unique_ptr<SpeculativeDispatcher> dispatcher;
    std::unique_ptr<btBroadphaseInterface> broadphase;
    std::unique_ptr<btSequentialImpulseConstraintSolver> solver;
    std::unique_ptr<btDiscreteDynamicsWorld> world;
    // Includes pending additions. Sorted handle order preserves the solver's
    // insertion order when bodies migrate between floating-origin regions.
    std::vector<std::shared_ptr<PhysicsBodyState>> members;
    std::size_t trigger_body_count = 0;
    std::uint64_t stabilized_total = 0;
    std::unordered_map<std::uint64_t, ContactSnapshot> previous_contacts;
    std::vector<PhysicsCollisionEvent> collision_events;
    /**
     * The trigger pairs that overlapped at the end of the previous step.
     * Havok reports an ENTERED and an EXITED edge; Bullet reports the
     * overlap state, so the edges come from the difference between two
     * consecutive states -- the same shape `previous_contacts` above gives
     * the collision stream.
     */
    std::unordered_set<std::uint64_t> previous_triggers;
    /**
     * Scratch for the current step's pairs, kept here rather than built
     * per call: a default-constructed `unordered_set` allocates its
     * sentinel on the Microsoft STL, so a fresh one every step was one
     * malloc and one free per world per step even with no trigger in the
     * scene. Swapped with `previous_triggers` and cleared, both tables'
     * buckets survive the frame.
     */
    std::unordered_set<std::uint64_t> current_triggers;

    std::vector<PhysicsTriggerEvent> trigger_events;
    /**
     * Rebounds scheduled by this step's landings, applied through every
     * sub-step of the next one.
     */
    std::vector<HavokBounce> scheduled_bounces;
    std::vector<HavokBounce> active_bounces;
    /**
     * `HP_World_GetSpeedLimit` / `HP_World_SetSpeedLimit`. Havok keeps the
     * ceiling on the world, and the floating-origin module reads one
     * world's onto another, so it lives here rather than as a file-scope
     * constant. Seeded with the reached Havok world's own defaults above.
     */
    btScalar max_linear_speed = default_max_linear_speed;
    btScalar max_angular_speed = default_max_angular_speed;
    ~PhysicsWorldState() { close(); }
    void close() {
        for (const auto& member : members) {
            if (member->in_world && world) world->removeRigidBody(member->body.get());
            member->in_world = false;
            member->needs_readd = false;
            member->world = 0;
            member->owner_world.reset();
        }
        std::vector<std::shared_ptr<PhysicsBodyState>>().swap(members);
        trigger_body_count = 0;
        world.reset();
        solver.reset();
        broadphase.reset();
        dispatcher.reset();
        configuration.reset();
        previous_contacts.clear();
        collision_events.clear();
        previous_triggers.clear();
        current_triggers.clear();
        trigger_events.clear();
        scheduled_bounces.clear();
        active_bounces.clear();
    }
};

namespace {

/** The tracked body behind a collision object; every object in a world is one. */
PhysicsBodyState* body_entry_of(const btCollisionObject* object) {
    const btRigidBody* body = btRigidBody::upcast(object);
    if (!body) return nullptr;
    auto* entry = static_cast<PhysicsBodyState*>(body->getUserPointer());
    return entry && entry->body.get() == body ? entry : nullptr;
}

const PhysicsShapeState* shape_entry_of(const btCollisionObject* object) {
    const auto* entry = body_entry_of(object);
    return entry ? entry->shape.get() : nullptr;
}

const ShapeMaterial* material_of(const btCollisionObject* object) {
    const auto* shape = shape_entry_of(object);
    return shape ? &shape->material : nullptr;
}

/** The one spelling of a pair's key, shared by every per-pair table. */
std::uint64_t pair_key(const btCollisionObject* a, const btCollisionObject* b) {
    const auto index_a = static_cast<std::uint32_t>(std::max(0, a->getUserIndex()));
    const auto index_b = static_cast<std::uint32_t>(std::max(0, b->getUserIndex()));
    return (static_cast<std::uint64_t>(std::min(index_a, index_b)) << 32) |
           std::max(index_a, index_b);
}

bool pair_has_pending_bounce(const PhysicsWorldState& world_entry, std::uint64_t key) {
    const auto matches = [&](const HavokBounce& bounce) {
        return pair_key(bounce.body_a, bounce.body_b) == key;
    };
    return std::any_of(
               world_entry.scheduled_bounces.begin(),
               world_entry.scheduled_bounces.end(), matches) ||
           std::any_of(
               world_entry.active_bounces.begin(),
               world_entry.active_bounces.end(), matches);
}

/** Whether a landing of this step has scheduled a rebound for the body. */
bool pending_bounce_involves(
    const PhysicsWorldState& world_entry,
    const btRigidBody* body) {
    return std::any_of(
        world_entry.scheduled_bounces.begin(),
        world_entry.scheduled_bounces.end(),
        [&](const HavokBounce& bounce) {
            return bounce.body_a == body || bounce.body_b == body;
        });
}

btVector3 gravity_of(const btRigidBody* body) {
    return body != nullptr && !body->isStaticOrKinematicObject()
               ? body->getGravity()
               : btVector3(0, 0, 0);
}

/**
 * The angular motion disc of the geometry an object actually wears.
 *
 * A body with an authored centre of mass wears its own compound around the
 * shared shape, and that compound's disc is the wider one -- the geometry
 * sits away from the origin the body spins about -- so the constant comes
 * from the body rather than from the shape record. Both bounds here run per
 * pair per sub-step, which is why each does exactly one body lookup and
 * reads the constant `set_body_collision_shape` recorded rather than
 * Bullet's virtual evaluation. An object no body owns -- nothing the worlds
 * here build -- keeps the virtual read.
 */
btScalar object_motion_disc(const btCollisionObject* object) {
    const PhysicsBodyState* entry = body_entry_of(object);
    if (entry == nullptr) {
        return object->getCollisionShape()->getAngularMotionDisc();
    }
    return entry->motion_disc;
}

/** The same, for a pair's share of the default breaking threshold. */
btScalar object_breaking_threshold(const btCollisionObject* object) {
    const PhysicsBodyState* entry = body_entry_of(object);
    if (entry == nullptr) {
        return object->getCollisionShape()->getContactBreakingThreshold(
            gContactBreakingThreshold);
    }
    return entry->contact_breaking_threshold;
}

/** A bound on how fast any point of the object moves. */
btScalar object_speed_bound(const btCollisionObject* object) {
    const btRigidBody* body = btRigidBody::upcast(object);
    if (body == nullptr || body->isStaticObject()) return 0;
    return body->getLinearVelocity().length() +
           body->getAngularVelocity().length() * object_motion_disc(object);
}

/** The breaking threshold Bullet itself gives a manifold of the pair. */
btScalar default_breaking_threshold(
    const btCollisionObject* a,
    const btCollisionObject* b) {
    return std::min(
        object_breaking_threshold(a), object_breaking_threshold(b));
}

/**
 * Part 1 of the contact model: how far ahead of the surfaces a manifold
 * keeps its points. Bullet detects contacts at the start of a sub-step and
 * its solver integrates the sub-step's gravity before it constrains, so the
 * approach a landing can happen under is the two bodies' speed plus that
 * gravity, over the sub-step; never narrower than Bullet's own threshold for
 * the pair.
 */
btScalar speculative_breaking_threshold(
    const btCollisionObject* a,
    const btCollisionObject* b,
    btScalar substep_seconds) {
    const btScalar gravity =
        gravity_of(btRigidBody::upcast(a)).length() +
        gravity_of(btRigidBody::upcast(b)).length();
    const btScalar approach =
        (object_speed_bound(a) + object_speed_bound(b) +
         gravity * substep_seconds) * substep_seconds;
    return std::max(default_breaking_threshold(a, b), approach);
}

PhysicsWorldState& world_at(const PhysicsWorldHandle& handle) {
    if (!handle.ownership || handle.value != handle.ownership->identity || !handle.ownership->world)
        throw std::runtime_error("Physics world handle is not live.");
    return *handle.ownership;
}

PhysicsBodyState& body_at(const PhysicsBodyHandle& handle) {
    if (!handle.ownership || handle.value != handle.ownership->identity)
        throw std::runtime_error("Physics body handle is not live.");
    return *handle.ownership;
}

PhysicsShapeState& shape_at(const PhysicsShapeHandle& handle) {
    if (!handle.ownership || handle.value != handle.ownership->identity)
        throw std::runtime_error("Physics shape handle is not live.");
    return *handle.ownership;
}

btVector3 to_bt(std::array<double, 3> v) {
    return btVector3(
        static_cast<btScalar>(v[0]),
        static_cast<btScalar>(v[1]),
        static_cast<btScalar>(v[2]));
}

/** The same narrowing for the `(x, y, z, w)` the PAL carries rotations in. */
btQuaternion to_bt(std::array<double, 4> v) {
    return btQuaternion(
        static_cast<btScalar>(v[0]),
        static_cast<btScalar>(v[1]),
        static_cast<btScalar>(v[2]),
        static_cast<btScalar>(v[3]));
}

void clamp_vector_length(btVector3& value, btScalar maximum) {
    const btScalar squared_length = value.length2();
    const btScalar squared_maximum = maximum * maximum;
    if (squared_length > squared_maximum) {
        value *= maximum / btSqrt(squared_length);
    }
}

void clamp_body_velocity(
    btRigidBody& body,
    btScalar max_linear,
    btScalar max_angular) {
    btVector3 linear = body.getLinearVelocity();
    btVector3 angular = body.getAngularVelocity();
    clamp_vector_length(linear, max_linear);
    clamp_vector_length(angular, max_angular);
    body.setLinearVelocity(linear);
    body.setAngularVelocity(angular);
}

/**
 * The ceiling in force for one body: its world's, or the reached Havok
 * defaults while it belongs to none. A body is created before
 * `HP_World_AddBody` places it, and an impulse can reach it there.
 */
PhysicsSpeedLimit body_speed_limit(const PhysicsBodyState& entry) {
    const auto world_entry = entry.owner_world.lock();
    if (world_entry != nullptr) {
        return PhysicsSpeedLimit{
            static_cast<double>(world_entry->max_linear_speed),
            static_cast<double>(world_entry->max_angular_speed)};
    }
    return PhysicsSpeedLimit{
        static_cast<double>(default_max_linear_speed),
        static_cast<double>(default_max_angular_speed)};
}

/**
 * Clamp a body to the ceiling in force for it, resolved from its world.
 * The three write-time entry points that can raise a speed all want this
 * exact pair, and the limit is a wire type in doubles that Bullet takes as
 * `btScalar` -- so the conversion lives here rather than at each call.
 */
void clamp_body_velocity(const PhysicsBodyState& entry) {
    if (entry.body == nullptr) {
        return;
    }
    const PhysicsSpeedLimit limit = body_speed_limit(entry);
    clamp_body_velocity(
        *entry.body,
        static_cast<btScalar>(limit.max_linear),
        static_cast<btScalar>(limit.max_angular));
}

void clamp_world_velocities(PhysicsWorldState& entry) {
    btDiscreteDynamicsWorld& world = *entry.world;
    for (int i = 0; i < world.getNumCollisionObjects(); ++i) {
        btRigidBody* body = btRigidBody::upcast(
            world.getCollisionObjectArray()[i]);
        if (body != nullptr && !body->isStaticOrKinematicObject()) {
            clamp_body_velocity(
                *body, entry.max_linear_speed, entry.max_angular_speed);
        }
    }
}

/** Whether an object wears the trigger flag `HP_Shape_SetTrigger` sets. */
bool is_trigger_object(const btCollisionObject* object) {
    return (object->getCollisionFlags() &
            btCollisionObject::CF_NO_CONTACT_RESPONSE) != 0;
}

int stabilize_contacting_bodies(
    PhysicsWorldState& world_entry,
    double seconds) {
    for (const auto& member : world_entry.members) {
        member->contacting = false;
    }
    const auto mark_contacting = [&](const btCollisionObject* object) {
        if (PhysicsBodyState* entry = body_entry_of(object)) entry->contacting = true;
    };
    const int manifold_count = world_entry.dispatcher->getNumManifolds();
    for (int manifold_index = 0;
         manifold_index < manifold_count;
         ++manifold_index) {
        const btPersistentManifold* manifold =
            world_entry.dispatcher->getManifoldByIndexInternal(
                manifold_index);
        // Passing through a trigger volume is not resting on anything, so
        // it must not count toward the contact-rest timer that puts a body
        // to sleep.
        if (
            is_trigger_object(static_cast<const btCollisionObject*>(
                manifold->getBody0())) ||
            is_trigger_object(static_cast<const btCollisionObject*>(
                manifold->getBody1()))) {
            continue;
        }
        // Touching means within the threshold Bullet itself gives the
        // pair, which is what this timer's envelope was measured under
        // before thresholds became speculative.
        const auto* object_a = static_cast<const btCollisionObject*>(
            manifold->getBody0());
        const auto* object_b = static_cast<const btCollisionObject*>(
            manifold->getBody1());
        const btScalar touching = default_breaking_threshold(object_a, object_b);
        bool has_contact = false;
        for (int point_index = 0;
             point_index < manifold->getNumContacts();
             ++point_index) {
            if (manifold->getContactPoint(point_index).getDistance() <=
                touching) {
                has_contact = true;
                break;
            }
        }
        if (has_contact) {
            mark_contacting(object_a);
            mark_contacting(object_b);
        }
    }

    int stabilized = 0;
    for (const auto& member : world_entry.members) {
        PhysicsBodyState& entry = *member;
        btRigidBody* body = entry.body.get();
        if (
            !entry.in_world || body == nullptr ||
            body->isStaticOrKinematicObject() || !entry.contacting ||
            // A body between a landing and its rebound is in flight however
            // slowly: sleeping it there would freeze it above the surface
            // (scene 42's sphere rested 0.0003 high). Its timer restarts
            // once the hop has landed.
            pending_bounce_involves(world_entry, body)) {
            entry.contact_quiet_seconds = 0.0;
            continue;
        }
        if (!body->isActive()) {
            entry.contact_quiet_seconds = 0.0;
            continue;
        }
        const bool quiet =
            body->getLinearVelocity().length2() <=
                contact_rest_linear_speed * contact_rest_linear_speed &&
            body->getAngularVelocity().length2() <=
                contact_rest_angular_speed * contact_rest_angular_speed;
        if (!quiet) {
            entry.contact_quiet_seconds = 0.0;
            continue;
        }
        entry.contact_quiet_seconds += seconds;
        if (entry.contact_quiet_seconds + 1e-9 < contact_rest_seconds) {
            continue;
        }
        body->setLinearVelocity(btVector3(0, 0, 0));
        body->setAngularVelocity(btVector3(0, 0, 0));
        body->clearForces();
        body->setActivationState(ISLAND_SLEEPING);
        entry.contact_quiet_seconds = 0.0;
        ++stabilized;
    }
    return stabilized;
}

/**
 * `HP_World_GetTriggerEvents`' stream.
 *
 * Havok reports the two EDGES of an overlap; Bullet reports the overlap
 * itself, so this diffs consecutive states the way `collect_collision_events`
 * does. The pair is a trigger pair when exactly one side is flagged: two
 * triggers overlapping report nothing upstream either, since a trigger has
 * no body to intersect against.
 */
void collect_trigger_events(PhysicsWorldState& world_entry) {
    if (world_entry.trigger_body_count == 0) {
        world_entry.trigger_events.assign(world_entry.previous_triggers.size(),
            PhysicsTriggerEvent{PhysicsTriggerEventType::exited});
        world_entry.previous_triggers.clear();
        world_entry.current_triggers.clear();
        return;
    }
    std::unordered_set<std::uint64_t>& current = world_entry.current_triggers;
    current.clear();
    const int manifold_count = world_entry.dispatcher->getNumManifolds();
    for (int manifold_index = 0;
         manifold_index < manifold_count;
         ++manifold_index) {
        const btPersistentManifold* manifold =
            world_entry.dispatcher->getManifoldByIndexInternal(manifold_index);
        const auto* object_a = static_cast<const btCollisionObject*>(
            manifold->getBody0());
        const auto* object_b = static_cast<const btCollisionObject*>(
            manifold->getBody1());
        if (is_trigger_object(object_a) == is_trigger_object(object_b)) {
            continue;
        }
        const int index_a = object_a->getUserIndex();
        const int index_b = object_b->getUserIndex();
        if (index_a <= 0 || index_b <= 0) {
            continue;
        }
        bool overlapping = false;
        for (int point_index = 0;
             point_index < manifold->getNumContacts();
             ++point_index) {
            if (manifold->getContactPoint(point_index).getDistance() <= 0.0) {
                overlapping = true;
                break;
            }
        }
        if (!overlapping) {
            continue;
        }
        current.insert(pair_key(object_a, object_b));
    }

    world_entry.trigger_events.clear();
    for (const std::uint64_t key : current) {
        if (!world_entry.previous_triggers.contains(key)) {
            world_entry.trigger_events.push_back(
                PhysicsTriggerEvent{PhysicsTriggerEventType::entered});
        }
    }
    for (const std::uint64_t key : world_entry.previous_triggers) {
        if (!current.contains(key)) {
            world_entry.trigger_events.push_back(
                PhysicsTriggerEvent{PhysicsTriggerEventType::exited});
        }
    }
    world_entry.previous_triggers.swap(current);
}

void collect_collision_events(PhysicsWorldState& world_entry) {
    std::unordered_map<std::uint64_t, ContactSnapshot> current;
    const int manifold_count = world_entry.dispatcher->getNumManifolds();
    for (int manifold_index = 0;
         manifold_index < manifold_count;
         ++manifold_index) {
        const btPersistentManifold* manifold =
            world_entry.dispatcher->getManifoldByIndexInternal(manifold_index);
        const auto* object_a = static_cast<const btCollisionObject*>(
            manifold->getBody0());
        const auto* object_b = static_cast<const btCollisionObject*>(
            manifold->getBody1());
        // A trigger volume reports through the trigger stream and produces
        // no collision upstream, so it is not a collision here either.
        if (is_trigger_object(object_a) || is_trigger_object(object_b)) {
            continue;
        }
        const auto* body_a = body_entry_of(object_a);
        const auto* body_b = body_entry_of(object_b);
        if (!body_a || !body_b || (!body_a->collision_events_enabled && !body_b->collision_events_enabled)) continue;
        const std::uint64_t key = pair_key(object_a, object_b);
        for (int point_index = 0;
             point_index < manifold->getNumContacts();
             ++point_index) {
            const btManifoldPoint& point =
                manifold->getContactPoint(point_index);
            if (point.getDistance() > 0.0) {
                continue;
            }
            const btVector3 position = point.getPositionWorldOnB();
            const btVector3 normal = point.m_normalWorldOnB;
            ContactSnapshot& snapshot = current[key];
            snapshot.point = {position.x(), position.y(), position.z()};
            snapshot.normal = {normal.x(), normal.y(), normal.z()};
            snapshot.impulse = std::max(
                snapshot.impulse,
                static_cast<double>(point.getAppliedImpulse()));
        }
    }

    world_entry.collision_events.clear();
    world_entry.collision_events.reserve(
        current.size() + world_entry.previous_contacts.size());
    for (const auto& [key, snapshot] : current) {
        world_entry.collision_events.push_back(PhysicsCollisionEvent{
            world_entry.previous_contacts.contains(key)
                ? PhysicsCollisionEventType::continued
                : PhysicsCollisionEventType::started,
            snapshot.point,
            snapshot.normal,
            snapshot.impulse,
        });
    }
    for (const auto& [key, snapshot] : world_entry.previous_contacts) {
        if (!current.contains(key)) {
            world_entry.collision_events.push_back(PhysicsCollisionEvent{
                PhysicsCollisionEventType::finished,
                snapshot.point,
                snapshot.normal,
                0.0,
            });
        }
    }
    world_entry.previous_contacts = std::move(current);
}

/**
 * The pin configures a body in Havok's order: create, motion type, add to
 * world, transform, shape, material, mass. Havok reads each write live;
 * Bullet takes the collision group, the broadphase proxy and the body's
 * gravity from the state the body had when it was *added*, so a shape or a
 * mass arriving later would leave a dynamic body filed as static with an
 * empty proxy — a body that never falls.
 *
 * That is a backend mechanic, not a semantic difference, so the PAL absorbs
 * it. The re-add is deferred to the next step rather than performed per
 * write: a body is configured three times during one aggregate, and each
 * `removeRigidBody` walks the overlapping-pair cache and does a linear
 * search of the world's object list, so doing it eagerly is quadratic in
 * body count at load for no benefit.
 */
void mark_body_dirty(PhysicsBodyState& entry) {
    entry.needs_readd = true;
}

/**
 * `HP_Shape_SetTrigger` reaching the object that wears the shape. Havok
 * keeps the flag on the shape; Bullet's `CF_NO_CONTACT_RESPONSE` is the
 * collision object's, so the two meet here.
 */
void apply_trigger_flag(PhysicsBodyState& entry, bool is_trigger) {
    if (entry.body == nullptr) return;
    const int flags = entry.body->getCollisionFlags();
    entry.body->setCollisionFlags(
        is_trigger
            ? flags | btCollisionObject::CF_NO_CONTACT_RESPONSE
            : flags & ~btCollisionObject::CF_NO_CONTACT_RESPONSE);
}

void flush_pending_readds(PhysicsWorldState& world_entry) {
    for (const auto& member : world_entry.members) {
        PhysicsBodyState& entry = *member;
        if (!entry.needs_readd) {
            continue;
        }
        entry.needs_readd = false;
        if (entry.in_world) {
            world_entry.world->removeRigidBody(entry.body.get());
        }
        const PhysicsShapeState* shape = entry.shape.get();
        const bool has_custom_filter =
            shape &&
            (shape->membership_mask != 0xffffffffu ||
             shape->collide_mask != 0xffffffffu);
        if (has_custom_filter) {
            world_entry.world->addRigidBody(
                entry.body.get(),
                static_cast<int>(shape->membership_mask),
                static_cast<int>(shape->collide_mask));
        } else {
            // Bullet's default overload assigns StaticFilter to immovable
            // bodies and excludes StaticFilter from their mask. Passing the
            // equivalent all-bits application defaults through the explicit
            // overload discards that motion-type filter, making every pair
            // of touching static shards run collision detection forever.
            // Keep explicit groups only for scenes which actually authored
            // a filter (Racer); the default path is both the intended Bullet
            // behavior and what lets Break Meshes keep intact shards static.
            world_entry.world->addRigidBody(entry.body.get());
        }
        entry.in_world = true;
        if (entry.start_asleep) {
            // `HP_World_AddBody(world, body, startsAsleep)`: the body joins
            // the world deactivated and stays put until something wakes it.
            // Bullet has no add-time flag, and a fresh body is ACTIVE_TAG,
            // so the state is written here -- at the deferred insertion,
            // which is after the transform, shape and mass writes that each
            // call `activate`. The intent is consumed rather than kept, so
            // a later re-add (a shape or mass change) cannot put a running
            // body back to sleep.
            entry.start_asleep = false;
            entry.body->setActivationState(ISLAND_SLEEPING);
        } else if (!entry.body->isStaticObject()) {
            // Forcing an immovable body active would keep it so for good --
            // Bullet only ever puts non-static bodies back to sleep -- and
            // every pair it touches in collision detection every sub-step.
            entry.body->activate(true);
        }
    }
}

/** One place that composes a node transform with its shape's centre. */
void write_world_transform(
    PhysicsBodyState& entry,
    const PhysicsTransform& transform) {
    btTransform world(to_bt(transform.rotation), to_bt(transform.position));
    world *= entry.node_from_body;
    entry.body->setWorldTransform(world);
    entry.body->getMotionState()->setWorldTransform(world);
}

/** The other direction of that compose: the node pose a body holds now. */
PhysicsTransform read_node_transform(const PhysicsBodyState& entry) {
    btTransform transform;
    entry.body->getMotionState()->getWorldTransform(transform);
    // Bullet integrates its COM/principal-axis frame. The pin exposes the
    // node frame, so remove the body-owned transform on the way back out.
    const btTransform node = transform * entry.node_from_body.inverse();
    const btVector3 origin = node.getOrigin();
    const btQuaternion rotation = node.getRotation();
    return PhysicsTransform{
        {origin.x(), origin.y(), origin.z()},
        {rotation.x(), rotation.y(), rotation.z(), rotation.w()},
    };
}

btScalar combine(
    PhysicsMaterialCombine mode,
    btScalar left,
    btScalar right) {
    switch (mode) {
        case PhysicsMaterialCombine::minimum:
            return std::min(left, right);
        case PhysicsMaterialCombine::maximum:
            return std::max(left, right);
        case PhysicsMaterialCombine::arithmetic_mean:
            return (left + right) * btScalar(0.5);
        case PhysicsMaterialCombine::multiply:
            return left * right;
    }
    throw std::runtime_error("Unknown physics material combine mode.");
}

/** The restitution the two shapes' materials combine to, on the pin's rule. */
btScalar combined_restitution(
    const btCollisionObject* a,
    const btCollisionObject* b) {
    const auto* left = material_of(a);
    const auto* right = material_of(b);
    if (left == nullptr || right == nullptr) return 0;
    return combine(
        left->restitution_combine, left->restitution, right->restitution);
}

/**
 * Bullet's default combine is the product of the pair on both channels;
 * which rule applies per channel is the pinned material's to state, so it
 * travels across the surface and is applied on the manifold here.
 */
bool combine_material_contact(
    btManifoldPoint& point,
    const btCollisionObjectWrapper* a,
    int /*partIdA*/,
    int /*indexA*/,
    const btCollisionObjectWrapper* b,
    int /*partIdB*/,
    int /*indexB*/) {
    const auto* left = material_of(a->getCollisionObject());
    const auto* right = material_of(b->getCollisionObject());
    if (left != nullptr && right != nullptr) {
        point.m_combinedFriction = combine(
            left->friction_combine, left->friction, right->friction);
        // A speculative point carries no restitution: Bullet's own
        // `restitution - rel_vel - distance / dt` would spend the rebound on
        // closing the gap. Nor does the landed point that follows it while
        // the pair's Havok rebound is pending -- `schedule_landing_bounces`
        // applies that rebound in the next step, and Bullet's would bounce
        // off the landing speed first. A point born penetrating on a pair
        // with no rebound pending keeps Bullet's restitution
        // (docs/fidelity.md#physics-contract measures both).
        const auto rebound_pending = [&] {
            const PhysicsBodyState* entry = body_entry_of(a->getCollisionObject());
            const auto owner = entry ? entry->owner_world.lock() : nullptr;
            return owner && pair_has_pending_bounce(
                       *owner,
                       pair_key(a->getCollisionObject(), b->getCollisionObject()));
        };
        point.m_combinedRestitution =
            point.getDistance() > 0 || rebound_pending()
                ? btScalar(0)
                : combined_restitution(
                      a->getCollisionObject(), b->getCollisionObject());
    }
    return true;
}

void cache_velocities(const PhysicsWorldState& world, BodyVelocity PhysicsBodyState::*slot) {
    for (const auto& member : world.members) {
        PhysicsBodyState& entry = *member;
        if (entry.body == nullptr) continue;
        (entry.*slot).linear = entry.body->getLinearVelocity();
        (entry.*slot).angular = entry.body->getAngularVelocity();
    }
}

void refresh_speculative_thresholds(
    PhysicsWorldState& world_entry,
    btScalar substep_seconds) {
    world_entry.dispatcher->substep_seconds = substep_seconds;
    const int manifold_count = world_entry.dispatcher->getNumManifolds();
    for (int index = 0; index < manifold_count; ++index) {
        btPersistentManifold* manifold =
            world_entry.dispatcher->getManifoldByIndexInternal(index);
        const auto* a = static_cast<const btCollisionObject*>(manifold->getBody0());
        const auto* b = static_cast<const btCollisionObject*>(manifold->getBody1());
        // A pair Bullet will not dispatch this sub-step keeps its threshold.
        if (!a->isActive() && !b->isActive()) continue;
        manifold->setContactBreakingThreshold(
            speculative_breaking_threshold(a, b, substep_seconds));
    }
}

/**
 * Part 2 of the contact model: before each sub-step of the step after a
 * landing, lift the pair's separating velocity back to the rebound, allowing
 * for the gravity Bullet is about to integrate over this sub-step so the
 * velocity after it is the rebound itself.
 */
void apply_active_bounces(PhysicsWorldState& world_entry, btScalar substep_seconds) {
    for (const HavokBounce& bounce : world_entry.active_bounces) {
        btRigidBody* a = bounce.body_a;
        btRigidBody* b = bounce.body_b;
        const btVector3 point_a =
            a->getCenterOfMassTransform() * bounce.local_point_a;
        const btVector3 point_b =
            b->getCenterOfMassTransform() * bounce.local_point_b;
        const btVector3 arm_a = point_a - a->getCenterOfMassPosition();
        const btVector3 arm_b = point_b - b->getCenterOfMassPosition();
        // A static or kinematic side has no inverse mass: it contributes
        // nothing here and Bullet ignores the impulse handed to it below.
        const btScalar denominator =
            a->computeImpulseDenominator(point_a, bounce.normal) +
            b->computeImpulseDenominator(point_b, bounce.normal);
        const btScalar separating = bounce.normal.dot(
            a->getVelocityInLocalPoint(arm_a) - b->getVelocityInLocalPoint(arm_b));
        const btScalar target =
            bounce.separating_speed + bounce.gravity_into * substep_seconds;
        if (separating >= target || denominator <= 0) continue;
        const btScalar impulse = (target - separating) / denominator;
        a->applyImpulse(bounce.normal * impulse, arm_a);
        b->applyImpulse(-bounce.normal * impulse, arm_b);
        a->activate();
        b->activate();
    }
}

btVector3 velocity_at(const BodyVelocity& velocity, const btVector3& arm) {
    return velocity.linear + velocity.angular.cross(arm);
}

/**
 * Parts 1 and 3 of the contact model, read off the manifolds Bullet just
 * refreshed: a point that reports a positive gap the pre-solve approach
 * would have crossed this sub-step is a landing Bullet's speculative
 * constraint has just performed, and it schedules the rebound for the next
 * step, once per pair.
 */
void schedule_landing_bounces(
    PhysicsWorldState& world_entry,
    btScalar substep_seconds,
    double step_seconds) {
    const int manifold_count = world_entry.dispatcher->getNumManifolds();
    for (int index = 0; index < manifold_count; ++index) {
        const btPersistentManifold* manifold =
            world_entry.dispatcher->getManifoldByIndexInternal(index);
        if (manifold->getNumContacts() == 0) continue;
        const auto* object_a = static_cast<const btCollisionObject*>(manifold->getBody0());
        const auto* object_b = static_cast<const btCollisionObject*>(manifold->getBody1());
        if (is_trigger_object(object_a) || is_trigger_object(object_b)) continue;
        PhysicsBodyState* entry_a = body_entry_of(object_a);
        PhysicsBodyState* entry_b = body_entry_of(object_b);
        if (entry_a == nullptr || entry_b == nullptr) continue;
        btRigidBody* body_a = entry_a->body.get();
        btRigidBody* body_b = entry_b->body.get();
        if (body_a->isStaticOrKinematicObject() &&
            body_b->isStaticOrKinematicObject()) {
            continue;
        }
        if (pair_has_pending_bounce(world_entry, pair_key(object_a, object_b))) {
            continue;
        }

        int landing_points = 0;
        btVector3 landing_point_a(0, 0, 0);
        btVector3 landing_point_b(0, 0, 0);
        btVector3 landing_normal(0, 0, 0);
        btScalar landing_gap = 0;
        for (int point_index = 0;
             point_index < manifold->getNumContacts();
             ++point_index) {
            const btManifoldPoint& point = manifold->getContactPoint(point_index);
            const btScalar gap = point.getDistance();
            if (gap <= 0) continue;
            const btVector3& normal = point.m_normalWorldOnB;
            const btVector3 arm_a =
                point.getPositionWorldOnA() - body_a->getCenterOfMassPosition();
            const btVector3 arm_b =
                point.getPositionWorldOnB() - body_b->getCenterOfMassPosition();
            // The approach the solver saw: the pre-sub-step velocity plus this
            // sub-step's gravity, which Bullet integrates before it solves.
            const btVector3 pre_a = velocity_at(
                {entry_a->substep_start.linear +
                     gravity_of(body_a) * substep_seconds,
                 entry_a->substep_start.angular},
                arm_a);
            const btVector3 pre_b = velocity_at(
                {entry_b->substep_start.linear +
                     gravity_of(body_b) * substep_seconds,
                 entry_b->substep_start.angular},
                arm_b);
            const btScalar approach = -normal.dot(pre_a - pre_b);
            if (approach * substep_seconds <= gap) continue;
            ++landing_points;
            landing_point_a += point.getPositionWorldOnA();
            landing_point_b += point.getPositionWorldOnB();
            landing_normal += normal;
            landing_gap += gap;
        }
        if (landing_points == 0) continue;
        const btScalar inverse_count = btScalar(1) / landing_points;
        landing_point_a *= inverse_count;
        landing_point_b *= inverse_count;
        landing_gap *= inverse_count;
        if (landing_normal.length2() <= 0) continue;
        landing_normal.normalize();

        // Part 3: the rebound from the approach at the start of the step.
        const btVector3 start_a = velocity_at(
            entry_a->step_start,
            landing_point_a - body_a->getCenterOfMassPosition());
        const btVector3 start_b = velocity_at(
            entry_b->step_start,
            landing_point_b - body_b->getCenterOfMassPosition());
        const btScalar approach_speed = -landing_normal.dot(start_a - start_b);
        const btScalar gravity_into = std::max(
            btScalar(0),
            -landing_normal.dot(gravity_of(body_a) - gravity_of(body_b)));
        const btScalar restitution = combined_restitution(object_a, object_b);
        const btScalar step = static_cast<btScalar>(step_seconds);
        const btScalar before_bounce = approach_speed - gravity_into * step;
        if (restitution <= 0 || before_bounce <= 0) continue;
        const btScalar separating_speed =
            restitution *
            btSqrt(std::max(
                btScalar(0),
                before_bounce * before_bounce -
                    btScalar(2) * gravity_into * landing_gap));
        if (separating_speed <= 0) continue;

        HavokBounce bounce{};
        bounce.body_a = body_a;
        bounce.body_b = body_b;
        bounce.normal = landing_normal;
        bounce.local_point_a =
            body_a->getCenterOfMassTransform().inverse() * landing_point_a;
        bounce.local_point_b =
            body_b->getCenterOfMassTransform().inverse() * landing_point_b;
        bounce.separating_speed = separating_speed;
        bounce.gravity_into = gravity_into;
        world_entry.scheduled_bounces.push_back(bounce);
    }
}

PhysicsShapeHandle push_shape(
    std::unique_ptr<btCollisionShape> shape,
    btTransform node_from_body,
    PhysicsMassProperties mass_properties = {},
    bool has_exact_mass_properties = false,
    std::unique_ptr<btTriangleMesh> triangle_mesh = nullptr) {
    auto owned = std::make_shared<PhysicsShapeState>();
    PhysicsShapeState& entry = *owned;
    entry.triangle_mesh = std::move(triangle_mesh);
    entry.shape = std::move(shape);
    entry.node_from_body = node_from_body;
    entry.mass_properties = mass_properties;
    entry.has_exact_mass_properties = has_exact_mass_properties;
    return PhysicsShapeHandle{owned->identity, std::move(owned)};
}

btTransform translated_frame(btVector3 center) {
    btTransform frame = btTransform::getIdentity();
    frame.setOrigin(center);
    return frame;
}

/**
 * A capsule or cylinder is given by two points and a radius upstream;
 * Bullet's are axis-aligned around a half-height. The segment's midpoint
 * becomes the shape centre and its length the height, which reproduces the
 * pin's geometry for the axis-aligned segments the reached slice passes.
 * A segment off the Y axis would need a rotated child shape and refuses
 * rather than silently standing upright.
 */
struct Segment {
    btVector3 center;
    btScalar half_height;
};

Segment segment_from(
    std::array<double, 3> point_a,
    std::array<double, 3> point_b) {
    const btVector3 a = to_bt(point_a);
    const btVector3 b = to_bt(point_b);
    const btVector3 delta = b - a;
    if (std::abs(delta.x()) > 1e-6f || std::abs(delta.z()) > 1e-6f) {
        throw std::runtime_error(
            "A capsule or cylinder physics shape whose segment is not "
            "Y-aligned is not lowered by this prototype.");
    }
    return Segment{
        (a + b) * btScalar(0.5), std::abs(delta.y()) * btScalar(0.5)};
}

}  // namespace

// --- World -----------------------------------------------------------

/**
 * Bullet's default `addRigidBody` overload never pairs two immovable
 * bodies: it gives them `StaticFilter` and masks it out of their mask. A
 * scene that authors its own masks takes the explicit overload, which drops
 * that rule, so it is restated here on top of the authored masks for every
 * pair -- otherwise every pair of touching static shapes runs collision
 * detection on every sub-step.
 */
struct MotionTypeOverlapFilter final : btOverlapFilterCallback {
    bool needBroadphaseCollision(
        btBroadphaseProxy* proxy_a,
        btBroadphaseProxy* proxy_b) const override {
        if ((proxy_a->m_collisionFilterGroup & proxy_b->m_collisionFilterMask) == 0 ||
            (proxy_b->m_collisionFilterGroup & proxy_a->m_collisionFilterMask) == 0) {
            return false;
        }
        const auto* a = static_cast<const btCollisionObject*>(proxy_a->m_clientObject);
        const auto* b = static_cast<const btCollisionObject*>(proxy_b->m_clientObject);
        return !(a->isStaticOrKinematicObject() && b->isStaticOrKinematicObject());
    }
};

MotionTypeOverlapFilter& motion_type_overlap_filter() {
    static MotionTypeOverlapFilter filter;
    return filter;
}

PhysicsWorldHandle physics_world_create() {
    // `gContactAddedCallback` is one process-global function pointer and the
    // assignment is idempotent.
    gContactAddedCallback = combine_material_contact;

    auto owned = std::make_shared<PhysicsWorldState>();
    PhysicsWorldState& entry = *owned;
    entry.configuration =
        std::make_unique<btDefaultCollisionConfiguration>();
    entry.dispatcher = std::make_unique<SpeculativeDispatcher>(
        entry.configuration.get());
    btGImpactCollisionAlgorithm::registerAlgorithm(entry.dispatcher.get());
    entry.broadphase = std::make_unique<btDbvtBroadphase>();
    entry.solver =
        std::make_unique<btSequentialImpulseConstraintSolver>();
    entry.world = std::make_unique<btDiscreteDynamicsWorld>(
        entry.dispatcher.get(),
        entry.broadphase.get(),
        entry.solver.get(),
        entry.configuration.get());
    entry.world->getPairCache()->setOverlapFilterCallback(
        &motion_type_overlap_filter());
    return PhysicsWorldHandle{owned->identity, std::move(owned)};
}

void physics_world_set_gravity(
    PhysicsWorldHandle world,
    std::array<double, 3> gravity) {
    world_at(world).world->setGravity(to_bt(gravity));
}

PhysicsSpeedLimit physics_world_get_speed_limit(PhysicsWorldHandle world) {
    const PhysicsWorldState& entry = world_at(world);
    return PhysicsSpeedLimit{
        static_cast<double>(entry.max_linear_speed),
        static_cast<double>(entry.max_angular_speed)};
}

void physics_world_set_speed_limit(
    PhysicsWorldHandle world,
    double max_linear,
    double max_angular) {
    PhysicsWorldState& entry = world_at(world);
    entry.max_linear_speed = static_cast<btScalar>(max_linear);
    entry.max_angular_speed = static_cast<btScalar>(max_angular);
}

void physics_world_add_body(PhysicsWorldHandle world, PhysicsBodyHandle body, bool start_asleep) {
    auto& entry = body_at(body);
    auto& target = world_at(world);
    if (entry.world != world.value) {
        auto position = std::lower_bound(target.members.begin(), target.members.end(), body.value,
            [](const auto& member, std::uint32_t identity) { return member->identity < identity; });
        target.members.insert(position, body.ownership);
        if (auto previous = entry.owner_world.lock()) {
            physics_world_remove_body(PhysicsWorldHandle{previous->identity, previous}, body);
        }
        if (entry.shape && entry.shape->is_trigger) ++target.trigger_body_count;
    }
    entry.world = world.value;
    entry.owner_world = world.ownership;
    entry.start_asleep = start_asleep;
    mark_body_dirty(entry);
}

void physics_world_remove_body(PhysicsWorldHandle world, PhysicsBodyHandle body) {
    auto& entry = body_at(body);
    if (entry.world != world.value) return;
    auto& owner = world_at(world);
    if (entry.in_world) owner.world->removeRigidBody(entry.body.get());
    // A removed body can die immediately. Retire every cached raw bounce
    // pointer before dropping the world's owning reference.
    const auto involves = [&](const HavokBounce& bounce) {
        return bounce.body_a == entry.body.get() || bounce.body_b == entry.body.get();
    };
    std::erase_if(owner.scheduled_bounces, involves);
    std::erase_if(owner.active_bounces, involves);
    if (entry.shape && entry.shape->is_trigger) --owner.trigger_body_count;
    std::erase(owner.members, body.ownership);
    entry.in_world = false;
    entry.needs_readd = false;
    entry.world = 0;
    entry.owner_world.reset();
}

void physics_world_release(PhysicsWorldHandle world) {
    if (!world.ownership || world.ownership->identity != world.value) {
        throw std::runtime_error("Invalid physics world handle.");
    }
    world.ownership->close();
}

void physics_world_step(PhysicsWorldHandle world, double seconds) {
    PhysicsWorldState& entry = world_at(world);
    static const bool cpu_profile = [] {
        const char* value = std::getenv("BBLITE_CPU_PROFILE");
        return value && value[0] == '1' && value[1] == '\0';
    }();
    using ProfileClock = std::chrono::steady_clock;
    const auto profile_start =
        cpu_profile ? ProfileClock::now() : ProfileClock::time_point{};
    int pending_readds = 0;
    if (cpu_profile) {
        for (const auto& member : entry.members) {
            if (member->needs_readd) {
                ++pending_readds;
            }
        }
    }
    flush_pending_readds(entry);
    // An impulse is clamped at its write below. This pass also covers any
    // velocity written by another reached body operation before this step.
    clamp_world_velocities(entry);
    const auto flush_end =
        cpu_profile ? ProfileClock::now() : ProfileClock::time_point{};

    // The pin runs ONE `HP_World_Step` per frame and says so: "The clamp is
    // intentionally *not* a substepping loop: Lite runs a single fixed step
    // per frame." What Havok does inside that call is Havok's, and it is
    // measured above: fixed 1/240 s sub-steps, as many as the step holds.
    // Bullet takes the same sub-steps here, each an ordinary full step of
    // its own (`maxSubSteps` 0 disables its accumulator and interpolation),
    // so the two integrators walk the same grid.
    const int substeps = std::max(
        1, static_cast<int>(std::lround(seconds / havok_substep_seconds)));
    const btScalar substep_seconds =
        static_cast<btScalar>(seconds / substeps);
    cache_velocities(entry, &PhysicsBodyState::step_start);
    // The landings of the previous step rebound during this one; the active
    // list is emptied below once they have, so the swap leaves the schedule
    // empty for this step's landings.
    entry.active_bounces.swap(entry.scheduled_bounces);
    for (int i = 0; i < substeps; ++i) {
        refresh_speculative_thresholds(entry, substep_seconds);
        apply_active_bounces(entry, substep_seconds);
        cache_velocities(entry, &PhysicsBodyState::substep_start);
        entry.world->stepSimulation(substep_seconds, 0, substep_seconds);
        schedule_landing_bounces(entry, substep_seconds, seconds);
    }
    entry.active_bounces.clear();
    // Contacts can add velocity inside Bullet's solver. Havok's body limits
    // remain invariant after a step, so make that invariant observable here
    // too before transforms and counters are read.
    clamp_world_velocities(entry);
    collect_collision_events(entry);
    collect_trigger_events(entry);
    const int stabilized_bodies =
        stabilize_contacting_bodies(entry, seconds);
    entry.stabilized_total += static_cast<std::uint64_t>(stabilized_bodies);
    const auto solver_end =
        cpu_profile ? ProfileClock::now() : ProfileClock::time_point{};

    if (cpu_profile) {
        static std::uint64_t profile_step = 0;
        if (profile_step % 30 == 0 || pending_readds > 0) {
            int dynamic_bodies = 0;
            int active_dynamic_bodies = 0;
            int moving_bodies = 0;
            double maximum_linear_speed = 0.0;
            double maximum_angular_speed = 0.0;
            double squared_speed_sum = 0.0;
            const btDiscreteDynamicsWorld& stepped = *entry.world;
            for (int i = 0; i < stepped.getNumCollisionObjects(); ++i) {
                const btCollisionObject* object =
                    stepped.getCollisionObjectArray()[i];
                if (!object->isStaticOrKinematicObject()) {
                    ++dynamic_bodies;
                    if (object->isActive()) {
                        ++active_dynamic_bodies;
                    }
                    const auto* rigid_body = btRigidBody::upcast(object);
                    if (rigid_body != nullptr) {
                        const double linear_speed = static_cast<double>(
                            rigid_body->getLinearVelocity().length());
                        const double angular_speed = static_cast<double>(
                            rigid_body->getAngularVelocity().length());
                        maximum_linear_speed =
                            std::max(maximum_linear_speed, linear_speed);
                        maximum_angular_speed =
                            std::max(maximum_angular_speed, angular_speed);
                        squared_speed_sum += linear_speed * linear_speed;
                        if (linear_speed > 0.01 || angular_speed > 0.01) {
                            ++moving_bodies;
                        }
                    }
                }
            }
            const double flush_ms =
                std::chrono::duration<double, std::milli>(
                    flush_end - profile_start)
                    .count();
            const double solver_ms =
                std::chrono::duration<double, std::milli>(
                    solver_end - flush_end)
                    .count();
            std::fprintf(
                stderr,
                "[cpu][physics] step=%llu bodies=%d dynamic=%d "
                "active_dynamic=%d "
                "moving=%d max_linear=%.3f max_angular=%.3f rms_linear=%.3f "
                "manifolds=%d stabilized_total=%llu pending_readds=%d "
                "flush_ms=%.3f solver_ms=%.3f\n",
                static_cast<unsigned long long>(profile_step),
                stepped.getNumCollisionObjects(),
                dynamic_bodies,
                active_dynamic_bodies,
                moving_bodies,
                maximum_linear_speed,
                maximum_angular_speed,
                dynamic_bodies > 0
                    ? std::sqrt(
                          squared_speed_sum /
                          static_cast<double>(dynamic_bodies))
                    : 0.0,
                entry.dispatcher->getNumManifolds(),
                static_cast<unsigned long long>(entry.stabilized_total),
                pending_readds,
                flush_ms,
                solver_ms);
        }
        ++profile_step;
    }

    // The trajectory instrument. A substituted solver cannot be gated by
    // MAD against a Havok golden at a moving pose, so what grades it is the
    // pose it produces per step. Read once: this is a per-frame path, and
    // `getenv` takes a lock and scans the environment block.
    static const bool trace =
        std::getenv("BBLITE_PHYSICS_TRACE") != nullptr;
    if (trace) {
        static int step_index = 0;
        // A trigger event carries no pixels — the pin's own handler for it
        // writes a dataset flag, which erases — so the trace is the only
        // place its two edges are observable at all.
        for (const PhysicsTriggerEvent& event : entry.trigger_events) {
            std::fprintf(
                stderr,
                "[physics] step %d trigger %s\n",
                step_index,
                event.type == PhysicsTriggerEventType::entered ? "ENTERED"
                                                               : "EXITED");
        }
        const btDiscreteDynamicsWorld& stepped = *entry.world;
        for (int i = 0; i < stepped.getNumCollisionObjects(); ++i) {
            const btVector3 origin = stepped.getCollisionObjectArray()[i]
                                         ->getWorldTransform()
                                         .getOrigin();
            std::fprintf(
                stderr,
                "[physics] step %d dt %.9f body %d pos %.9f %.9f %.9f\n",
                step_index, seconds, i,
                static_cast<double>(origin.x()),
                static_cast<double>(origin.y()),
                static_cast<double>(origin.z()));
        }
        ++step_index;
    }
}

const std::vector<PhysicsCollisionEvent>& physics_world_collision_events(
    PhysicsWorldHandle world) {
    return world_at(world).collision_events;
}

const std::vector<PhysicsTriggerEvent>& physics_world_trigger_events(
    PhysicsWorldHandle world) {
    return world_at(world).trigger_events;
}

PhysicsRaycastResult physics_world_raycast(
    PhysicsWorldHandle world,
    std::array<double, 3> from,
    std::array<double, 3> to,
    std::uint32_t membership,
    std::uint32_t collide_with,
    bool should_hit_triggers) {
    const btVector3 ray_from = to_bt(from);
    const btVector3 ray_to = to_bt(to);
    struct FilteredRayCallback final : btCollisionWorld::ClosestRayResultCallback {
        bool include_triggers;

        FilteredRayCallback(const btVector3& start, const btVector3& end, bool include)
            : ClosestRayResultCallback(start, end), include_triggers(include) {}

        bool needsCollision(btBroadphaseProxy* proxy) const override {
            return ClosestRayResultCallback::needsCollision(proxy) &&
                (include_triggers || !is_trigger_object(
                    static_cast<const btCollisionObject*>(proxy->m_clientObject)));
        }
    } callback(ray_from, ray_to, should_hit_triggers);
    callback.m_collisionFilterGroup = static_cast<int>(membership);
    callback.m_collisionFilterMask = static_cast<int>(collide_with);
    world_at(world).world->rayTest(ray_from, ray_to, callback);
    static const bool trace = std::getenv("BBLITE_TRACE_PHYSICS_RAYS") != nullptr;
    if (trace) {
        const PhysicsBodyState* body = callback.hasHit() ? body_entry_of(callback.m_collisionObject) : nullptr;
        std::fprintf(stderr,
            "[physics-ray] from=[%.17g,%.17g,%.17g] to=[%.17g,%.17g,%.17g] hit=%d body=%u point=[%.17g,%.17g,%.17g]\n",
            from[0], from[1], from[2], to[0], to[1], to[2], callback.hasHit() ? 1 : 0,
            body ? body->identity : 0,
            callback.hasHit() ? static_cast<double>(callback.m_hitPointWorld.x()) : 0.0,
            callback.hasHit() ? static_cast<double>(callback.m_hitPointWorld.y()) : 0.0,
            callback.hasHit() ? static_cast<double>(callback.m_hitPointWorld.z()) : 0.0);
    }
    if (!callback.hasHit()) {
        return {};
    }
    const btVector3& point = callback.m_hitPointWorld;
    const btVector3& normal = callback.m_hitNormalWorld;
    const PhysicsBodyState* hit_body = body_entry_of(callback.m_collisionObject);
    return PhysicsRaycastResult{
        true,
        {point.x(), point.y(), point.z()},
        {normal.x(), normal.y(), normal.z()},
        hit_body ? hit_body->identity : 0,
    };
}

namespace {

btTransform query_transform(const PhysicsTransform& transform) {
    return btTransform(btQuaternion(
        static_cast<btScalar>(transform.rotation[0]), static_cast<btScalar>(transform.rotation[1]),
        static_cast<btScalar>(transform.rotation[2]), static_cast<btScalar>(transform.rotation[3])),
        to_bt(transform.position));
}

const btConvexShape& convex_query_shape(const PhysicsShapeState& shape) {
    if (!shape.shape->isConvex()) {
        throw std::runtime_error("Physics shape queries require a convex query shape.");
    }
    return static_cast<const btConvexShape&>(*shape.shape);
}

// Measured Havok cylinder queries use a rounded rim capped at 0.015, reduced for small
// shapes. Keep this query geometry independent of the existing contact solver.
// The cross-solver query fixture observes both rim and side contacts.
class QueryShape {
public:
    explicit QueryShape(const PhysicsShapeState& source) : source_(convex_query_shape(source)) {
        if (source_.getShapeType() == CYLINDER_SHAPE_PROXYTYPE) {
            const auto& cylinder = static_cast<const btCylinderShape&>(source_);
            const btVector3 half = cylinder.getHalfExtentsWithMargin();
            cylinder_.emplace(half);
            cylinder_->setMargin(btMin(btScalar(.015), half[half.minAxis()] * btScalar(.1)));
        }
    }
    const btConvexShape& get() const { return cylinder_ ? *cylinder_ : source_; }
private:
    const btConvexShape& source_;
    std::optional<btCylinderShape> cylinder_;
};

bool query_accepts(const PhysicsShapeState& query, const PhysicsBodyState& body,
                   bool include_triggers, std::uint32_t ignored = 0) {
    return body.in_world && body.shape && body.identity != ignored &&
        (include_triggers || !body.shape->is_trigger) &&
        (query.membership_mask & body.shape->collide_mask) != 0 &&
        (body.shape->membership_mask & query.collide_mask) != 0;
}

btPointCollector closest_convex_points(const btConvexShape& a, const btTransform& a_transform,
                                     const btConvexShape& b, const btTransform& b_transform,
                                     double max_distance) {
    btVoronoiSimplexSolver simplex;
    btGjkEpaPenetrationDepthSolver penetration;
    btGjkPairDetector detector(&a, &b, &simplex, &penetration);
    btDiscreteCollisionDetectorInterface::ClosestPointInput input;
    input.m_transformA = a_transform;
    input.m_transformB = b_transform;
    input.m_maximumDistanceSquared = static_cast<btScalar>(max_distance * max_distance);
    btPointCollector result;
    detector.getClosestPoints(input, result, nullptr);
    return result;
}

PhysicsShapeQueryResult shape_query_hit(const btPointCollector& point,
                                      const btTransform& query_node, double value) {
    const btVector3 normal = point.m_normalOnBInWorld;
    const btVector3 input_point = query_node.inverse() *
        (point.m_pointInWorld + normal * point.m_distance);
    const btVector3 input_normal = query_node.getBasis().transpose() * -normal;
    return PhysicsShapeQueryResult{true, value,
        {input_point.x(), input_point.y(), input_point.z()},
        {point.m_pointInWorld.x(), point.m_pointInWorld.y(), point.m_pointInWorld.z()},
        {input_normal.x(), input_normal.y(), input_normal.z()},
        {normal.x(), normal.y(), normal.z()}};
}

// Parallel side features have an interval of equally close point pairs. Havok
// chooses the capsule's first segment endpoint; Bullet's simplex averages it.
// Select the lower end of their axial overlap without changing distance/normal.
void select_parallel_capsule_feature(btPointCollector& point,
                                     const btConvexShape& query, const btTransform& query_transform,
                                     const btCollisionShape& target, const btTransform& target_transform) {
    if (query.getShapeType() != CYLINDER_SHAPE_PROXYTYPE ||
        target.getShapeType() != CAPSULE_SHAPE_PROXYTYPE) return;
    const auto& cylinder = static_cast<const btCylinderShape&>(query);
    const auto& capsule = static_cast<const btCapsuleShape&>(target);
    const btVector3 capsule_axis = target_transform.getBasis().getColumn(capsule.getUpAxis());
    const btVector3 cylinder_axis = query_transform.getBasis().getColumn(cylinder.getUpAxis());
    if (btFabs(capsule_axis.dot(cylinder_axis)) < btScalar(1) - SIMD_EPSILON ||
        btFabs(capsule_axis.dot(point.m_normalOnBInWorld)) > SIMD_EPSILON) return;
    const btScalar capsule_center = capsule_axis.dot(target_transform.getOrigin());
    const btScalar cylinder_center = capsule_axis.dot(query_transform.getOrigin());
    const btScalar cylinder_half = cylinder.getHalfExtentsWithMargin()[cylinder.getUpAxis()];
    const btScalar lower = btMax(capsule_center - capsule.getHalfHeight(), cylinder_center - cylinder_half);
    const btScalar upper = btMin(capsule_center + capsule.getHalfHeight(), cylinder_center + cylinder_half);
    if (lower <= upper) {
        point.m_pointInWorld += capsule_axis * (lower - capsule_axis.dot(point.m_pointInWorld));
    }
}
}

PhysicsShapeQueryResult physics_world_shape_proximity(
    PhysicsWorldHandle world, PhysicsShapeHandle shape, const PhysicsTransform& transform,
    double max_distance, bool should_hit_triggers) {
    auto& owner = world_at(world);
    const auto& query = shape_at(shape);
    const QueryShape query_shape(query);
    const btConvexShape& convex = query_shape.get();
    const btTransform node = query_transform(transform);
    const btTransform shape_transform = node * query.node_from_body;
    PhysicsShapeQueryResult result;
    double closest = max_distance;
    for (const auto& candidate : owner.members) {
        if (!query_accepts(query, *candidate, should_hit_triggers)) continue;
        const auto* target = candidate->body->getCollisionShape();
        if (!target->isConvex()) {
            throw std::runtime_error("Physics proximity against concave or compound bodies is not supported.");
        }
        btPointCollector hit = closest_convex_points(convex, shape_transform,
            static_cast<const btConvexShape&>(*target), candidate->body->getWorldTransform(),
            std::max(0.0, closest));
        if (hit.m_hasResult && static_cast<double>(hit.m_distance) <= closest) {
            select_parallel_capsule_feature(hit, convex, shape_transform, *target,
                candidate->body->getWorldTransform());
            closest = static_cast<double>(hit.m_distance);
            result = shape_query_hit(hit, node, closest);
        }
    }
    return result;
}

PhysicsShapeQueryResult physics_world_shape_cast(
    PhysicsWorldHandle world, PhysicsShapeHandle shape, std::array<double, 4> rotation,
    std::array<double, 3> from, std::array<double, 3> to, bool should_hit_triggers,
    PhysicsBodyHandle ignored_body) {
    auto& owner = world_at(world);
    const auto& query = shape_at(shape);
    const QueryShape query_shape(query);
    const btConvexShape& convex = query_shape.get();
    const btTransform from_node = query_transform(PhysicsTransform{from, rotation});
    const btTransform to_node = query_transform(PhysicsTransform{to, rotation});
    struct QueryCallback final : btCollisionWorld::ClosestConvexResultCallback {
        const PhysicsShapeState& query;
        bool include_triggers;
        std::uint32_t ignored;
        QueryCallback(const btVector3& start, const btVector3& end,
                      const PhysicsShapeState& shape_state, bool include, std::uint32_t ignore)
            : ClosestConvexResultCallback(start, end), query(shape_state),
              include_triggers(include), ignored(ignore) {}
        bool needsCollision(btBroadphaseProxy* proxy) const override {
            const auto* body = body_entry_of(static_cast<const btCollisionObject*>(proxy->m_clientObject));
            return body && query_accepts(query, *body, include_triggers, ignored);
        }
    } callback(from_node.getOrigin(), to_node.getOrigin(), query, should_hit_triggers, ignored_body.value);
    owner.world->convexSweepTest(&convex, from_node * query.node_from_body,
        to_node * query.node_from_body, callback);
    if (!callback.hasHit()) return {};
    btTransform hit_node = from_node;
    hit_node.setOrigin(from_node.getOrigin().lerp(to_node.getOrigin(), callback.m_closestHitFraction));
    btPointCollector point;
    point.m_hasResult = true;
    point.m_distance = 0;
    point.m_pointInWorld = callback.m_hitPointWorld;
    point.m_normalOnBInWorld = callback.m_hitNormalWorld;
    select_parallel_capsule_feature(point, convex, hit_node * query.node_from_body,
        *callback.m_hitCollisionObject->getCollisionShape(), callback.m_hitCollisionObject->getWorldTransform());
    return shape_query_hit(point, hit_node, static_cast<double>(callback.m_closestHitFraction));
}

// --- Shapes ----------------------------------------------------------

PhysicsShapeHandle physics_shape_create_sphere(
    std::array<double, 3> center,
    double radius) {
    return push_shape(
        std::make_unique<btSphereShape>(
            static_cast<btScalar>(radius)),
        translated_frame(to_bt(center)));
}

PhysicsShapeHandle physics_shape_create_box(
    std::array<double, 3> center,
    std::array<double, 4> rotation,
    std::array<double, 3> extents) {
    if (std::abs(rotation[0]) > 1e-9 || std::abs(rotation[1]) > 1e-9 ||
        std::abs(rotation[2]) > 1e-9 ||
        std::abs(std::abs(rotation[3]) - 1.0) > 1e-9) {
        throw std::runtime_error(
            "A rotated box physics shape is not lowered by this "
            "prototype.");
    }
    // A `createGround` mesh is zero-thickness in Y, so its box asks for a
    // half-extent of 0 on that axis — a plane in Havok's tolerance model
    // and a zero-volume box in Bullet's, which cannot resolve a contact.
    // The axis is grown to Bullet's margin and the centre sunk by the same
    // amount, so the box's +axis face stays exactly where the mesh puts it
    // and a body rests at its geometric height. Measured: with the sink a
    // unit sphere rests at 1.000, without it at 1.040.
    //
    // The sink direction assumes the +axis face is the contact surface,
    // which is true of a ground and not of a thin ceiling; a scene needing
    // the other one has no way to say so yet
    // (`docs/fidelity.md#physics-contract`).
    btVector3 half(
        static_cast<btScalar>(extents[0] * 0.5),
        static_cast<btScalar>(extents[1] * 0.5),
        static_cast<btScalar>(extents[2] * 0.5));
    btVector3 offset = to_bt(center);
    for (int axis = 0; axis < 3; ++axis) {
        const btScalar grown = std::max(half[axis], convex_margin);
        offset[axis] -= grown - half[axis];
        half[axis] = grown;
    }
    return push_shape(
        std::make_unique<btBoxShape>(half),
        translated_frame(offset));
}

PhysicsShapeHandle physics_shape_create_capsule(
    std::array<double, 3> point_a,
    std::array<double, 3> point_b,
    double radius) {
    const Segment segment = segment_from(point_a, point_b);
    return push_shape(
        std::make_unique<btCapsuleShape>(
            static_cast<btScalar>(radius),
            segment.half_height * btScalar(2)),
        translated_frame(segment.center));
}

PhysicsShapeHandle physics_shape_create_cylinder(
    std::array<double, 3> point_a,
    std::array<double, 3> point_b,
    double radius) {
    const Segment segment = segment_from(point_a, point_b);
    return push_shape(
        std::make_unique<btCylinderShape>(btVector3(
            static_cast<btScalar>(radius),
            segment.half_height,
            static_cast<btScalar>(radius))),
        translated_frame(segment.center));
}

PhysicsShapeHandle physics_shape_create_convex_hull(
    const std::vector<std::array<double, 3>>& positions) {
    auto source_hull = std::make_unique<btConvexHullShape>();
    for (const std::array<double, 3>& position : positions) {
        source_hull->addPoint(to_bt(position), false);
    }
    source_hull->recalcLocalAabb();
    if (!source_hull->initializePolyhedralFeatures()) {
        throw std::runtime_error(
            "A convex-hull physics shape has no closed polyhedron.");
    }
    const btConvexPolyhedron* polyhedron =
        source_hull->getConvexPolyhedron();
    if (polyhedron == nullptr || polyhedron->m_faces.size() == 0) {
        throw std::runtime_error(
            "A convex-hull physics shape has no mass-properties faces.");
    }

    // `HP_Shape_BuildMassProperties` returns the hull's centre and
    // principal axes. Bullet's fast btConvexHullShape leaves both at the
    // object origin, so build one temporary exact triangle hull to obtain
    // the same physical frame, then retain the fast shape in that frame.
    btTriangleMesh mass_mesh;
    for (int face_index = 0;
         face_index < polyhedron->m_faces.size();
         ++face_index) {
        const btFace& face = polyhedron->m_faces[face_index];
        if (face.m_indices.size() < 3) continue;
        const btVector3& first =
            polyhedron->m_vertices[face.m_indices[0]];
        for (int i = 1; i + 1 < face.m_indices.size(); ++i) {
            const btVector3& second =
                polyhedron->m_vertices[face.m_indices[i]];
            const btVector3& third =
                polyhedron->m_vertices[face.m_indices[i + 1]];
            const btVector3 face_normal(
                face.m_plane[0], face.m_plane[1], face.m_plane[2]);
            if ((second - first).cross(third - first).dot(face_normal) >= 0) {
                mass_mesh.addTriangle(first, second, third);
            } else {
                mass_mesh.addTriangle(first, third, second);
            }
        }
    }
    btConvexTriangleMeshShape mass_shape(&mass_mesh, true);
    btTransform principal = btTransform::getIdentity();
    btVector3 inertia(0, 0, 0);
    btScalar volume = 0;
    mass_shape.calculatePrincipalAxisTransform(
        principal, inertia, volume);
    if (
        !std::isfinite(static_cast<double>(volume)) ||
        volume <= SIMD_EPSILON) {
        // Havok accepts the reached sliver cells by inflating them through
        // its convex radius. Bullet's raw hull can collide with the same
        // points, but an exact volume frame is undefined; retain the origin
        // frame and let its ordinary AABB inertia handle this rare arm.
        return push_shape(
            std::move(source_hull), btTransform::getIdentity());
    }

    auto hull = std::make_unique<btConvexHullShape>();
    const btTransform body_from_node = principal.inverse();
    for (const std::array<double, 3>& position : positions) {
        hull->addPoint(body_from_node * to_bt(position), false);
    }
    hull->recalcLocalAabb();
    const btVector3 center = principal.getOrigin();
    const btQuaternion orientation = principal.getRotation();
    return push_shape(
        std::move(hull),
        principal,
        PhysicsMassProperties{
            {center.x(), center.y(), center.z()},
            static_cast<double>(volume),
            {inertia.x(), inertia.y(), inertia.z()},
            {orientation.x(), orientation.y(), orientation.z(),
             orientation.w()}},
        true);
}

PhysicsShapeHandle physics_shape_create_mesh(
    const std::vector<std::array<double, 3>>& positions,
    const std::vector<std::uint32_t>& indices) {
    // The pin hands Havok two heap buffers and lets it index one with the
    // other. Bullet's equivalent that owns its own storage is
    // `btTriangleMesh`, which takes a triangle at a time, so the indexing
    // happens here instead of inside the back end.
    auto triangles = std::make_unique<btTriangleMesh>();
    for (std::size_t i = 0; i + 2 < indices.size(); i += 3) {
        const std::uint32_t a = indices[i];
        const std::uint32_t b = indices[i + 1];
        const std::uint32_t c = indices[i + 2];
        if (a >= positions.size() || b >= positions.size() ||
            c >= positions.size()) {
            throw std::runtime_error(
                "A physics mesh shape has a triangle index outside its "
                "vertex list.");
        }
        triangles->addTriangle(
            to_bt(positions[a]), to_bt(positions[b]), to_bt(positions[c]));
    }
    if (triangles->getNumTriangles() == 0) {
        throw std::runtime_error(
            "Cannot create physics mesh shape without triangle indices.");
    }
    // `buildBvh` is what makes the soup queryable: every ray test and every
    // contact against it walks that tree, and the shape owns it.
    auto shape = std::make_unique<btBvhTriangleMeshShape>(
        triangles.get(), true);
    return push_shape(
        std::move(shape),
        btTransform::getIdentity(),
        PhysicsMassProperties{},
        false,
        std::move(triangles));
}

void physics_shape_set_material(
    PhysicsShapeHandle shape,
    const PhysicsShapeMaterial& material) {
    PhysicsShapeState& entry = shape_at(shape);
    // Bullet carries one friction per body, where the pin's material array
    // separates static from dynamic. No reached call passes a differing
    // pair -- `setPhysicsShapeMaterial` writes the same value into both --
    // so a pair that does differ refuses rather than silently taking one.
    if (material.static_friction != material.dynamic_friction) {
        throw std::runtime_error(
            "A physics material with differing static and dynamic "
            "friction is not lowered by this prototype.");
    }
    entry.material = ShapeMaterial{
        static_cast<btScalar>(material.dynamic_friction),
        static_cast<btScalar>(material.restitution),
        material.friction_combine,
        material.restitution_combine,
    };
}

void physics_shape_set_filter_membership_mask(
    PhysicsShapeHandle shape,
    std::uint32_t membership_mask) {
    PhysicsShapeState& shape_entry = shape_at(shape);
    shape_entry.membership_mask = membership_mask;
    for (auto* body : shape_entry.users) mark_body_dirty(*body);
}

void physics_shape_set_filter_collide_mask(
    PhysicsShapeHandle shape,
    std::uint32_t collide_mask) {
    PhysicsShapeState& shape_entry = shape_at(shape);
    shape_entry.collide_mask = collide_mask;
    for (auto* body : shape_entry.users) mark_body_dirty(*body);
}

void physics_shape_set_trigger(PhysicsShapeHandle shape, bool is_trigger) {
    PhysicsShapeState& shape_entry = shape_at(shape);
    if (shape_entry.is_trigger == is_trigger) return;
    shape_entry.is_trigger = is_trigger;
    for (auto* body : shape_entry.users) {
        if (auto world = body->owner_world.lock()) {
            if (is_trigger) ++world->trigger_body_count;
            else --world->trigger_body_count;
        }
        apply_trigger_flag(*body, is_trigger);
    }
}

// --- Bodies ----------------------------------------------------------

namespace {

/**
 * The one writer of a body's collision shape.
 *
 * `PhysicsBodyState::motion_disc` and `contact_breaking_threshold` are
 * constants of whatever geometry the body wears, so the invariant is
 * maintained here -- at the four places the geometry changes -- rather than
 * re-derived by the per-pair, per-sub-step readers above.
 */
void set_body_collision_shape(
    PhysicsBodyState& entry,
    btCollisionShape* shape) {
    entry.body->setCollisionShape(shape);
    entry.motion_disc = shape->getAngularMotionDisc();
    entry.contact_breaking_threshold =
        shape->getContactBreakingThreshold(gContactBreakingThreshold);
}

btCollisionShape* body_shape(PhysicsBodyState& entry) {
    PhysicsShapeState& shape = *entry.shape;
    if (!shape.triangle_mesh || entry.body->isStaticOrKinematicObject()) {
        return shape.shape.get();
    }
    if (!shape.moving_mesh) {
        shape.moving_mesh =
            std::make_unique<btGImpactMeshShape>(shape.triangle_mesh.get());
        shape.moving_mesh->updateBound();
    }
    return shape.moving_mesh.get();
}

void refresh_body_shape(PhysicsBodyState& entry) {
    if (!entry.shape) return;
    btCollisionShape* shape = body_shape(entry);
    if (entry.mass_frame_shape) {
        entry.mass_frame_shape->removeChildShapeByIndex(0);
        entry.mass_frame_shape->addChildShape(
            entry.node_from_body.inverse() * entry.shape->node_from_body, shape);
        shape = entry.mass_frame_shape.get();
    }
    set_body_collision_shape(entry, shape);
}

/**
 * Drop any per-body mass-frame compound and wear the shared shape itself.
 * Both callers reach this the moment the body's centre of mass becomes the
 * shape's own again: a new shape carries its own centre, and mass
 * properties that author none ask for the shape's.
 */
void wear_shared_shape(PhysicsBodyState& entry) {
    set_body_collision_shape(entry, body_shape(entry));
    entry.mass_frame_shape.reset();
}

} // namespace

PhysicsBodyHandle physics_body_create() {
    auto owned = std::make_shared<PhysicsBodyState>();
    PhysicsBodyState& entry = *owned;
    entry.motion_state = std::make_unique<btDefaultMotionState>();
    // `HP_Body_Create` makes a body with no shape yet; Bullet requires one
    // at construction, so an empty shape stands in until
    // `HP_Body_SetShape` replaces it.
    static btEmptyShape placeholder;
    btRigidBody::btRigidBodyConstructionInfo info(
        btScalar(0), entry.motion_state.get(), &placeholder);
    entry.body = std::make_unique<btRigidBody>(info);
    // The placeholder is the first geometry the body wears, so it seeds the
    // two constants the same writer maintains for every later one.
    set_body_collision_shape(entry, &placeholder);
    // A fresh Havok body reports damping 0/0.1. Bullet defaults both channels
    // to zero, which leaves small convex shards spinning long after the
    // reference has allowed their contact island to sleep. The coefficient
    // is converted, since the two libraries apply it differently.
    entry.body->setDamping(
        havok_damping(default_linear_damping),
        havok_damping(default_angular_damping));
    // The manifold callback reads the material through the user pointer,
    // and CF_CUSTOM_MATERIAL_CALLBACK is what makes Bullet call it.
    entry.body->setCollisionFlags(
        entry.body->getCollisionFlags() |
        btCollisionObject::CF_CUSTOM_MATERIAL_CALLBACK);
    owned->body->setUserIndex(static_cast<int>(owned->identity));
    owned->body->setUserPointer(owned.get());
    return PhysicsBodyHandle{owned->identity, std::move(owned)};
}

/**
 * The one concave shape kind this file builds. `isConcave()` is the rule
 * Bullet states but the wrong question to ask here: Bullet's own empty
 * placeholder shape sits inside the concave range too, and every body wears
 * that between `HP_Body_Create` and `HP_Body_SetShape`.
 */
bool is_triangle_mesh_shape(const btCollisionShape& shape) {
    return shape.getShapeType() == TRIANGLE_MESH_SHAPE_PROXYTYPE;
}

void physics_body_set_motion_type(
    PhysicsBodyHandle body,
    PhysicsMotionType motion_type) {
    PhysicsBodyState& entry = body_at(body);
    int flags = entry.body->getCollisionFlags();
    flags &= ~(btCollisionObject::CF_STATIC_OBJECT |
               btCollisionObject::CF_KINEMATIC_OBJECT);
    switch (motion_type) {
        case PhysicsMotionType::immovable:
            flags |= btCollisionObject::CF_STATIC_OBJECT;
            break;
        case PhysicsMotionType::node_driven:
            // Driven by the node transform, never by the solver.
            flags |= btCollisionObject::CF_KINEMATIC_OBJECT;
            entry.body->setActivationState(DISABLE_DEACTIVATION);
            break;
        case PhysicsMotionType::simulated:
            break;
    }
    entry.body->setCollisionFlags(flags);
    refresh_body_shape(entry);
    mark_body_dirty(entry);
}

void physics_body_set_shape(
    PhysicsBodyHandle body,
    PhysicsShapeHandle shape) {
    PhysicsBodyState& entry = body_at(body);
    PhysicsShapeState& shape_entry = shape_at(shape);
    const bool shape_changed = entry.shape != shape.ownership;
    if (shape_changed) {
        shape_entry.users.push_back(&entry);
        if (auto world = entry.owner_world.lock()) {
            if (entry.shape && entry.shape->is_trigger) --world->trigger_body_count;
            if (shape_entry.is_trigger) ++world->trigger_body_count;
        }
        if (entry.shape) std::erase(entry.shape->users, &entry);
        entry.shape = shape.ownership;
    }
    entry.node_from_body = shape_entry.node_from_body;
    // A shape carries its own centre of mass, so attaching one drops the
    // frame an earlier `setPhysicsBodyMassProperties` authored — the same
    // reset Havok performs, and the reason the pin's own order writes the
    // shape before the mass. Re-attaching the shape the body already wears
    // is the second half of that reset, so both arms are the one call.
    if (shape_changed || entry.mass_frame_shape) wear_shared_shape(entry);
    apply_trigger_flag(entry, shape_entry.is_trigger);
    // The pin writes the node transform before the shape, so the shape's
    // own centre offset was not known then. Re-apply it now.
    write_world_transform(entry, entry.requested);
    mark_body_dirty(entry);
}

PhysicsTransform physics_body_get_transform(PhysicsBodyHandle body) {
    return read_node_transform(body_at(body));
}

void physics_body_set_transform(
    PhysicsBodyHandle body,
    const PhysicsTransform& transform) {
    PhysicsBodyState& entry = body_at(body);
    entry.requested = transform;
    entry.contact_quiet_seconds = 0.0;
    write_world_transform(entry, transform);
    // An immovable body is left as Bullet keeps it (asleep): forcing it
    // active would keep every pair it touches in collision detection.
    if (!entry.body->isStaticObject()) entry.body->activate(true);
}

void physics_body_set_target_transform(
    PhysicsBodyHandle body,
    const PhysicsTransform& transform) {
    // `HP_Body_SetTargetQTransform` derives a velocity that carries the
    // body to the target over one step, so resting bodies on top are
    // dragged by friction rather than tunnelled through. Bullet has no such
    // entry point; a kinematic body's motion state IS that behaviour, since
    // the solver derives contact velocity from the swept transform.
    physics_body_set_transform(body, transform);
}

PhysicsMassProperties physics_shape_build_mass_properties(
    PhysicsShapeHandle shape,
    double mass) {
    const PhysicsShapeState& shape_entry = shape_at(shape);
    PhysicsMassProperties properties = shape_entry.mass_properties;
    btVector3 inertia(0, 0, 0);
    if (shape_entry.has_exact_mass_properties) {
        inertia = btVector3(
            static_cast<btScalar>(properties.inertia[0]),
            static_cast<btScalar>(properties.inertia[1]),
            static_cast<btScalar>(properties.inertia[2]));
    } else {
        if (shape_entry.moving_mesh) {
            shape_entry.moving_mesh->calculateLocalInertia(
                static_cast<btScalar>(mass), inertia);
        } else if (!is_triangle_mesh_shape(*shape_entry.shape)) {
            shape_entry.shape->calculateLocalInertia(
                static_cast<btScalar>(mass), inertia);
        }
        properties.mass = mass;
        properties.inertia = {
            inertia.x(), inertia.y(), inertia.z()};
        const btVector3 center = shape_entry.node_from_body.getOrigin();
        const btQuaternion orientation =
            shape_entry.node_from_body.getRotation();
        properties.center_of_mass = {
            center.x(), center.y(), center.z()};
        properties.inertia_orientation = {
            orientation.x(), orientation.y(), orientation.z(),
            orientation.w()};
    }
    static const bool cpu_profile = [] {
        const char* value = std::getenv("BBLITE_CPU_PROFILE");
        return value && value[0] == '1' && value[1] == '\0';
    }();
    if (cpu_profile) {
        std::fprintf(
            stderr,
            "[cpu][physics-mass] shape=%u mass=%.6f "
            "center=%.6f,%.6f,%.6f inertia=%.6f,%.6f,%.6f "
            "orientation=%.6f,%.6f,%.6f,%.6f\n",
            shape.value,
            properties.mass,
            properties.center_of_mass[0],
            properties.center_of_mass[1],
            properties.center_of_mass[2],
            static_cast<double>(inertia.x()),
            static_cast<double>(inertia.y()),
            static_cast<double>(inertia.z()),
            properties.inertia_orientation[0],
            properties.inertia_orientation[1],
            properties.inertia_orientation[2],
            properties.inertia_orientation[3]);
    }
    return properties;
}

namespace {

/**
 * Give a body the centre-of-mass frame its mass properties ask for.
 *
 * Havok carries the centre of mass as a body-local point and leaves the
 * shape where the node puts it. Bullet has no such point: the rigid body's
 * transform IS its centre-of-mass frame and a collision shape is centred on
 * that origin. So `node_from_body` — that frame in node-local space, which
 * is what `physics_shape_build_mass_properties` reads a shape's own centre
 * back out of — is the thing that moves here, and the geometry has to move
 * the opposite way by the same transform to stay where the scene drew it.
 * That opposite transform is a per-body compound child, because the shape
 * record is shared by every body wearing it.
 *
 * A body whose properties still carry the shape's own centre and
 * orientation takes the plain-shape path and changes nothing. Every body
 * that never authors a centre is one: the aggregate and `setPhysicsBodyMass`
 * both hand back exactly what the shape derived.
 */
void apply_body_mass_frame(
    PhysicsBodyState& entry,
    const PhysicsMassProperties& properties) {
    if (!entry.shape) return;
    const btTransform& shape_frame = entry.shape->node_from_body;
    const btVector3 shape_center = shape_frame.getOrigin();
    const btQuaternion shape_rotation = shape_frame.getRotation();
    // Whether the properties still carry the shape's own frame, asked in the
    // representation both sides already hold. Rebuilding a `btTransform`
    // from the arrays and testing THAT against the shape's would compare a
    // `btMatrix3x3 -> btQuaternion -> btMatrix3x3` round trip in the build's
    // scalar type against the basis it came from, which only an identity
    // basis reliably survives -- so a convex hull, whose frame is its
    // rotated principal-axis frame, would take the compound path below for
    // a centre no scene ever authored.
    const bool centred =
        properties.center_of_mass ==
            std::array<double, 3>{
                shape_center.x(), shape_center.y(), shape_center.z()} &&
        properties.inertia_orientation ==
            std::array<double, 4>{
                shape_rotation.x(), shape_rotation.y(),
                shape_rotation.z(), shape_rotation.w()};
    const btTransform node_from_body =
        centred ? shape_frame
                : btTransform(
                      to_bt(properties.inertia_orientation),
                      to_bt(properties.center_of_mass));
    const bool unchanged =
        node_from_body.getOrigin() == entry.node_from_body.getOrigin() &&
        node_from_body.getBasis() == entry.node_from_body.getBasis() &&
        centred == !entry.mass_frame_shape;
    if (unchanged) return;
    // The node pose is the scene's and does not move; only the frame
    // composed under it does, so it is read before the frame changes and
    // written back after.
    const PhysicsTransform node = read_node_transform(entry);
    entry.node_from_body = node_from_body;
    if (centred) {
        wear_shared_shape(entry);
    } else {
        auto offset = std::make_unique<btCompoundShape>();
        offset->addChildShape(
            node_from_body.inverse() * shape_frame, body_shape(entry));
        set_body_collision_shape(entry, offset.get());
        entry.mass_frame_shape = std::move(offset);
    }
    write_world_transform(entry, node);
}

} // namespace

void physics_body_set_mass_properties(
    PhysicsBodyHandle body,
    const PhysicsMassProperties& properties) {
    PhysicsBodyState& entry = body_at(body);
    apply_body_mass_frame(entry, properties);
    entry.body->setMassProps(
        static_cast<btScalar>(properties.mass),
        btVector3(
            static_cast<btScalar>(properties.inertia[0]),
            static_cast<btScalar>(properties.inertia[1]),
            static_cast<btScalar>(properties.inertia[2])));
    entry.body->updateInertiaTensor();
    entry.contact_quiet_seconds = 0.0;
    mark_body_dirty(entry);
}

void physics_body_apply_impulse(
    PhysicsBodyHandle body,
    std::array<double, 3> location,
    std::array<double, 3> impulse) {
    PhysicsBodyState& entry = body_at(body);
    const btVector3 relative =
        to_bt(location) - entry.body->getCenterOfMassPosition();
    entry.body->applyImpulse(to_bt(impulse), relative);
    entry.contact_quiet_seconds = 0.0;
    clamp_body_velocity(entry);
    if (!entry.body->isStaticObject()) entry.body->activate(true);
    static const bool cpu_profile = [] {
        const char* value = std::getenv("BBLITE_CPU_PROFILE");
        return value && value[0] == '1' && value[1] == '\0';
    }();
    if (cpu_profile) {
        std::fprintf(
            stderr,
            "[cpu][physics-impulse] body=%u location=%.6f,%.6f,%.6f "
            "relative=%.6f,%.6f,%.6f impulse=%.6f,%.6f,%.6f "
            "linear=%.6f angular=%.6f\n",
            body.value,
            location[0], location[1], location[2],
            static_cast<double>(relative.x()),
            static_cast<double>(relative.y()),
            static_cast<double>(relative.z()),
            impulse[0], impulse[1], impulse[2],
            static_cast<double>(entry.body->getLinearVelocity().length()),
            static_cast<double>(entry.body->getAngularVelocity().length()));
    }
}

std::array<double, 3> physics_body_get_linear_velocity(
    PhysicsBodyHandle body) {
    const btVector3 velocity = body_at(body).body->getLinearVelocity();
    return {velocity.x(), velocity.y(), velocity.z()};
}

std::array<double, 3> physics_body_get_angular_velocity(
    PhysicsBodyHandle body) {
    const btVector3 velocity = body_at(body).body->getAngularVelocity();
    return {velocity.x(), velocity.y(), velocity.z()};
}

void physics_body_set_linear_velocity(
    PhysicsBodyHandle body,
    std::array<double, 3> velocity) {
    PhysicsBodyState& entry = body_at(body);
    entry.body->setLinearVelocity(to_bt(velocity));
    // The same ceiling an impulse write is subject to: Havok applies its
    // world limit at the write rather than at the step.
    clamp_body_velocity(entry);
}

void physics_body_set_angular_velocity(
    PhysicsBodyHandle body,
    std::array<double, 3> velocity) {
    PhysicsBodyState& entry = body_at(body);
    entry.body->setAngularVelocity(to_bt(velocity));
    clamp_body_velocity(entry);
}

void physics_body_set_collision_events_enabled(
    PhysicsBodyHandle body,
    bool enabled) {
    body_at(body).collision_events_enabled = enabled;
}

}  // namespace bbl::pal
