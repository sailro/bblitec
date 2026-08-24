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

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <memory>
#include <stdexcept>

#include <btBulletDynamicsCommon.h>

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

/** The friction and restitution a shape carries until a material is set. */
struct ShapeMaterial {
    btScalar friction = 0;
    btScalar restitution = 0;
    PhysicsMaterialCombine friction_combine =
        PhysicsMaterialCombine::minimum;
    PhysicsMaterialCombine restitution_combine =
        PhysicsMaterialCombine::maximum;
};

struct ShapeEntry {
    std::unique_ptr<btCollisionShape> shape;
    /**
     * `HP_Shape_CreateSphere`/`CreateBox` take a centre, and Bullet's
     * primitives are origin-centred — so a non-zero centre becomes a
     * transform offset the body carries.
     */
    btVector3 center{0, 0, 0};
    ShapeMaterial material{};
};

struct BodyEntry {
    std::unique_ptr<btRigidBody> body;
    std::unique_ptr<btDefaultMotionState> motion_state;
    btVector3 shape_center{0, 0, 0};
    std::uint32_t world = 0;
    bool start_asleep = false;
    bool in_world = false;
    /**
     * Set whenever a write invalidates what `addRigidBody` recorded, and
     * flushed by the next step. See `flush_pending_readds`.
     */
    bool needs_readd = false;
    /**
     * The node transform the pin last wrote. `createPhysicsBody` writes it
     * before `setPhysicsBodyShape` runs, so the shape's own centre offset is
     * not known yet; re-applying this when the shape arrives is what puts
     * the body where the pin asked for it.
     */
    PhysicsTransform requested{};
};

struct WorldEntry {
    std::unique_ptr<btDefaultCollisionConfiguration> configuration;
    std::unique_ptr<btCollisionDispatcher> dispatcher;
    std::unique_ptr<btBroadphaseInterface> broadphase;
    std::unique_ptr<btSequentialImpulseConstraintSolver> solver;
    std::unique_ptr<btDiscreteDynamicsWorld> world;
};

/**
 * Slot 0 of each table is the null handle, so a default-constructed handle
 * never names a live object. `std::deque` keeps references stable across
 * growth, which the body entries a world holds depend on.
 */
std::deque<WorldEntry>& worlds() {
    static std::deque<WorldEntry> table(1);
    return table;
}

std::deque<BodyEntry>& bodies() {
    static std::deque<BodyEntry> table(1);
    return table;
}

std::deque<ShapeEntry>& shapes() {
    static std::deque<ShapeEntry> table(1);
    return table;
}

WorldEntry& world_at(PhysicsWorldHandle handle) {
    if (handle.value == 0 || handle.value >= worlds().size()) {
        throw std::runtime_error("Physics world handle is not live.");
    }
    return worlds()[handle.value];
}

BodyEntry& body_at(PhysicsBodyHandle handle) {
    if (handle.value == 0 || handle.value >= bodies().size()) {
        throw std::runtime_error("Physics body handle is not live.");
    }
    return bodies()[handle.value];
}

ShapeEntry& shape_at(PhysicsShapeHandle handle) {
    if (handle.value == 0 || handle.value >= shapes().size()) {
        throw std::runtime_error("Physics shape handle is not live.");
    }
    return shapes()[handle.value];
}

btVector3 to_bt(std::array<double, 3> v) {
    return btVector3(
        static_cast<btScalar>(v[0]),
        static_cast<btScalar>(v[1]),
        static_cast<btScalar>(v[2]));
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
void mark_body_dirty(BodyEntry& entry) {
    entry.needs_readd = true;
}

void flush_pending_readds(WorldEntry& world_entry, std::uint32_t world) {
    for (BodyEntry& entry : bodies()) {
        if (!entry.needs_readd || entry.world != world) {
            continue;
        }
        entry.needs_readd = false;
        if (entry.in_world) {
            world_entry.world->removeRigidBody(entry.body.get());
        }
        world_entry.world->addRigidBody(entry.body.get());
        entry.in_world = true;
        if (!entry.start_asleep) {
            entry.body->activate(true);
        }
    }
}

/** One place that composes a node transform with its shape's centre. */
void write_world_transform(
    BodyEntry& entry,
    const PhysicsTransform& transform) {
    const btQuaternion rotation(
        static_cast<btScalar>(transform.rotation[0]),
        static_cast<btScalar>(transform.rotation[1]),
        static_cast<btScalar>(transform.rotation[2]),
        static_cast<btScalar>(transform.rotation[3]));
    btTransform world;
    world.setRotation(rotation);
    world.setOrigin(
        btVector3(
            static_cast<btScalar>(transform.position[0]),
            static_cast<btScalar>(transform.position[1]),
            static_cast<btScalar>(transform.position[2])) +
        quatRotate(rotation, entry.shape_center));
    entry.body->setWorldTransform(world);
    entry.body->getMotionState()->setWorldTransform(world);
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
    const auto* left = static_cast<const ShapeMaterial*>(
        a->getCollisionObject()->getUserPointer());
    const auto* right = static_cast<const ShapeMaterial*>(
        b->getCollisionObject()->getUserPointer());
    if (left != nullptr && right != nullptr) {
        point.m_combinedFriction = combine(
            left->friction_combine, left->friction, right->friction);
        point.m_combinedRestitution = combine(
            left->restitution_combine,
            left->restitution,
            right->restitution);
    }
    return true;
}

PhysicsShapeHandle push_shape(
    std::unique_ptr<btCollisionShape> shape,
    btVector3 center) {
    shapes().push_back(ShapeEntry{std::move(shape), center, {}});
    return PhysicsShapeHandle{
        static_cast<std::uint32_t>(shapes().size() - 1)};
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

PhysicsWorldHandle physics_world_create() {
    // `gContactAddedCallback` is one process-global function pointer and the
    // assignment is idempotent.
    gContactAddedCallback = combine_material_contact;

    WorldEntry entry{};
    entry.configuration =
        std::make_unique<btDefaultCollisionConfiguration>();
    entry.dispatcher = std::make_unique<btCollisionDispatcher>(
        entry.configuration.get());
    entry.broadphase = std::make_unique<btDbvtBroadphase>();
    entry.solver =
        std::make_unique<btSequentialImpulseConstraintSolver>();
    entry.world = std::make_unique<btDiscreteDynamicsWorld>(
        entry.dispatcher.get(),
        entry.broadphase.get(),
        entry.solver.get(),
        entry.configuration.get());
    worlds().push_back(std::move(entry));
    return PhysicsWorldHandle{
        static_cast<std::uint32_t>(worlds().size() - 1)};
}

void physics_world_set_gravity(
    PhysicsWorldHandle world,
    std::array<double, 3> gravity) {
    world_at(world).world->setGravity(to_bt(gravity));
}

void physics_world_add_body(
    PhysicsWorldHandle world,
    PhysicsBodyHandle body,
    bool start_asleep) {
    BodyEntry& entry = body_at(body);
    entry.world = world.value;
    entry.start_asleep = start_asleep;
    mark_body_dirty(entry);
}

void physics_world_step(PhysicsWorldHandle world, double seconds) {
    WorldEntry& entry = world_at(world);
    flush_pending_readds(entry, world.value);

    // The pin runs ONE step per frame and says so: "The clamp is
    // intentionally *not* a substepping loop: Lite runs a single fixed step
    // per frame." `stepSimulation` substeps by default, so the substep
    // count is pinned to one and the fixed step to the whole delta, which
    // makes Bullet integrate the same single step the pin asks Havok for.
    entry.world->stepSimulation(
        static_cast<btScalar>(seconds),
        0,
        static_cast<btScalar>(seconds));

    // The trajectory instrument. A substituted solver cannot be gated by
    // MAD against a Havok golden at a moving pose, so what grades it is the
    // pose it produces per step. Read once: this is a per-frame path, and
    // `getenv` takes a lock and scans the environment block.
    static const bool trace =
        std::getenv("BBLITE_PHYSICS_TRACE") != nullptr;
    if (trace) {
        static int step_index = 0;
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

// --- Shapes ----------------------------------------------------------

PhysicsShapeHandle physics_shape_create_sphere(
    std::array<double, 3> center,
    double radius) {
    return push_shape(
        std::make_unique<btSphereShape>(
            static_cast<btScalar>(radius)),
        to_bt(center));
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
    return push_shape(std::make_unique<btBoxShape>(half), offset);
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
        segment.center);
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
        segment.center);
}

void physics_shape_set_material(
    PhysicsShapeHandle shape,
    const PhysicsShapeMaterial& material) {
    ShapeEntry& entry = shape_at(shape);
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

// --- Bodies ----------------------------------------------------------

PhysicsBodyHandle physics_body_create() {
    BodyEntry entry{};
    entry.motion_state = std::make_unique<btDefaultMotionState>();
    // `HP_Body_Create` makes a body with no shape yet; Bullet requires one
    // at construction, so an empty shape stands in until
    // `HP_Body_SetShape` replaces it.
    static btEmptyShape placeholder;
    btRigidBody::btRigidBodyConstructionInfo info(
        btScalar(0), entry.motion_state.get(), &placeholder);
    entry.body = std::make_unique<btRigidBody>(info);
    // The manifold callback reads the material through the user pointer,
    // and CF_CUSTOM_MATERIAL_CALLBACK is what makes Bullet call it.
    entry.body->setCollisionFlags(
        entry.body->getCollisionFlags() |
        btCollisionObject::CF_CUSTOM_MATERIAL_CALLBACK);
    bodies().push_back(std::move(entry));
    return PhysicsBodyHandle{
        static_cast<std::uint32_t>(bodies().size() - 1)};
}

void physics_body_set_motion_type(
    PhysicsBodyHandle body,
    PhysicsMotionType motion_type) {
    BodyEntry& entry = body_at(body);
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
    mark_body_dirty(entry);
}

void physics_body_set_shape(
    PhysicsBodyHandle body,
    PhysicsShapeHandle shape) {
    BodyEntry& entry = body_at(body);
    ShapeEntry& shape_entry = shape_at(shape);
    entry.shape_center = shape_entry.center;
    entry.body->setCollisionShape(shape_entry.shape.get());
    entry.body->setUserPointer(&shape_entry.material);
    // The pin writes the node transform before the shape, so the shape's
    // own centre offset was not known then. Re-apply it now.
    write_world_transform(entry, entry.requested);
    mark_body_dirty(entry);
}

PhysicsTransform physics_body_get_transform(PhysicsBodyHandle body) {
    const BodyEntry& entry = body_at(body);
    btTransform transform;
    entry.body->getMotionState()->getWorldTransform(transform);
    // The shape centre is the pin's, not Bullet's: `HP_Shape_CreateSphere`
    // takes a centre and the node's transform is the body's origin, so the
    // offset is removed on the way back out.
    const btVector3 origin =
        transform.getOrigin() -
        quatRotate(transform.getRotation(), entry.shape_center);
    const btQuaternion rotation = transform.getRotation();
    return PhysicsTransform{
        {origin.x(), origin.y(), origin.z()},
        {rotation.x(), rotation.y(), rotation.z(), rotation.w()},
    };
}

void physics_body_set_transform(
    PhysicsBodyHandle body,
    const PhysicsTransform& transform) {
    BodyEntry& entry = body_at(body);
    entry.requested = transform;
    write_world_transform(entry, transform);
    entry.body->activate(true);
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
    btVector3 inertia(0, 0, 0);
    shape_at(shape).shape->calculateLocalInertia(
        static_cast<btScalar>(mass), inertia);
    return PhysicsMassProperties{
        {0.0, 0.0, 0.0},
        mass,
        {inertia.x(), inertia.y(), inertia.z()},
    };
}

void physics_body_set_mass_properties(
    PhysicsBodyHandle body,
    const PhysicsMassProperties& properties) {
    BodyEntry& entry = body_at(body);
    entry.body->setMassProps(
        static_cast<btScalar>(properties.mass),
        btVector3(
            static_cast<btScalar>(properties.inertia[0]),
            static_cast<btScalar>(properties.inertia[1]),
            static_cast<btScalar>(properties.inertia[2])));
    entry.body->updateInertiaTensor();
    mark_body_dirty(entry);
}

}  // namespace bbl::pal
