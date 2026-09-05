#pragma once

/**
 * The rigid-body solver boundary.
 *
 * This is the one PAL contract that is not an operating-system service, and
 * it is here for the same reason the others are: it is a third-party library
 * reached through a fixed entry-point list. The list is not invented — it is
 * the surface the pinned `src/physics/havok.ts` already calls on the `hknp`
 * module a browser scene hands it. That module is a *parameter* to
 * `createHavokWorld(scene, hknp)`, and nothing in the pinned physics layer
 * assumes anything about it beyond these entry points, so the seam this
 * header names is upstream's own rather than one this port introduced.
 *
 * The consequence worth stating plainly: **no generated code names a
 * solver.** `upstream/physics.hpp` carries Babylon's rigid-body semantics —
 * the step gate, the four phases of a frame, the aggregate's ordering, the
 * bounding-box shape sizing — and reaches every one of them through the
 * functions below. Swapping the implementation is dropping in a different
 * translation unit, exactly as swapping a GPU backend is.
 *
 * **What a substituted solver costs, and why it is recorded rather than
 * hidden.** Havok and Bullet do not integrate the same contact model, so a
 * body's pose after N steps is a *different number*, not a rounded one. That
 * makes physics the only family in this repository whose output cannot be
 * gated against the browser golden pixel for pixel. It is recorded as the
 * `substituted-physics-solver` adaptation and measured by trajectory rather
 * than by MAD; `docs/fidelity.md` carries the contract.
 *
 * Handles own opaque solver state. Worlds retain their members; bodies retain
 * shapes and borrow their current world. No process-wide object registry is needed.
 */

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

namespace bbl::pal {

struct PhysicsWorldState;
struct PhysicsBodyState;
struct PhysicsShapeState;

/** `HP_World_Create`'s handle. */
struct PhysicsWorldHandle {
    std::uint32_t value = 0;
    std::shared_ptr<PhysicsWorldState> ownership;
};

/** `HP_Body_Create`'s handle. */
struct PhysicsBodyHandle {
    std::uint32_t value = 0;
    std::shared_ptr<PhysicsBodyState> ownership;
};

/** The handle every `HP_Shape_Create*` returns. */
struct PhysicsShapeHandle {
    std::uint32_t value = 0;
    std::shared_ptr<PhysicsShapeState> ownership;
};

/**
 * `HP_Body_GetQTransform` / `HP_Body_SetQTransform`: a position and a
 * quaternion, in the pin's own `[[x,y,z],[x,y,z,w]]` order.
 */
struct PhysicsTransform {
    std::array<double, 3> position{};
    std::array<double, 4> rotation{0.0, 0.0, 0.0, 1.0};
};

/**
 * The pair `HP_World_GetSpeedLimit` returns and `HP_World_SetSpeedLimit`
 * takes.
 *
 * A body speed ceiling is a property of the WORLD upstream, and the pinned
 * floating-origin module is what makes that observable here: every region
 * it creates is a second world, and `_getOrCreateRegion` seeds the new
 * one's limits by reading the base world's. Havok applies the ceiling as
 * part of an impulse write; Bullet has no rigid-body speed limit of its
 * own, so the backend applies it at the same two places.
 */
struct PhysicsSpeedLimit {
    double max_linear = 0.0;
    double max_angular = 0.0;
};

/**
 * `hknp.MotionType`, the back end's own enumeration.
 *
 * Deliberately NOT the pin's `PhysicsMotionType`. Upstream does not pass its
 * enum through either — `createPhysicsBody` maps
 * `STATIC/ANIMATED/DYNAMIC` onto `hknp.MotionType.STATIC/KINEMATIC/DYNAMIC`
 * — so the mapping is Babylon behaviour and belongs in generated code. These
 * names are the back end's, which is what keeps a renumbering upstream a
 * change to the generated mapping rather than a silent swap here.
 */
enum class PhysicsMotionType : std::int32_t {
    immovable = 0,
    node_driven = 1,
    simulated = 2,
};

/**
 * `hknp.MaterialCombine`. Which rule applies to which channel is the pinned
 * material's choice (`setPhysicsShapeMaterial` picks MINIMUM for friction
 * and MAXIMUM for restitution), so it travels as data rather than being
 * re-decided by whichever back end is linked.
 */
enum class PhysicsMaterialCombine : std::int32_t {
    minimum = 0,
    maximum = 1,
    arithmetic_mean = 2,
    multiply = 3,
};

/**
 * The material array `HP_Shape_SetMaterial` takes, field for field:
 * `[staticFriction, dynamicFriction, restitution, frictionCombine,
 * restitutionCombine]`.
 */
struct PhysicsShapeMaterial {
    double static_friction = 0.0;
    double dynamic_friction = 0.0;
    double restitution = 0.0;
    PhysicsMaterialCombine friction_combine =
        PhysicsMaterialCombine::minimum;
    PhysicsMaterialCombine restitution_combine =
        PhysicsMaterialCombine::maximum;
};

/**
 * The mass-properties tuple `HP_Shape_BuildMassProperties` returns and
 * `HP_Body_SetMassProperties` takes. Convex hulls make every member
 * observable: their centre and principal-axis orientation determine the
 * lever arm and angular response of a world-space impulse.
 */
struct PhysicsMassProperties {
    std::array<double, 3> center_of_mass{};
    double mass = 0.0;
    std::array<double, 3> inertia{};
    std::array<double, 4> inertia_orientation{0.0, 0.0, 0.0, 1.0};
};

enum class PhysicsCollisionEventType {
    started,
    continued,
    finished,
};

struct PhysicsCollisionEvent {
    PhysicsCollisionEventType type = PhysicsCollisionEventType::finished;
    std::array<double, 3> point{};
    std::array<double, 3> normal{};
    double impulse = 0.0;
};

/**
 * `HP_World_GetTriggerEvents`' own two event codes.
 *
 * The pin drains the stream by walking the module's heap and reading the
 * back end's `TRIGGER_ENTERED` / `TRIGGER_EXITED` integers out of each
 * record. That walk is the back end's, exactly as the collision drain is,
 * so the surface hands over the decoded pair and the generated side maps
 * them onto the pin's own `"ENTERED"` / `"EXITED"` strings.
 */
enum class PhysicsTriggerEventType {
    entered,
    exited,
};

/**
 * One drained trigger event. The pin's `PhysicsTriggerInfo` carries only
 * the type; its `PhysicsTriggerBodyInfo` extension resolves the two
 * participating bodies, and `onPhysicsTriggerBodies` -- the only reader of
 * them -- is not reached.
 */
struct PhysicsTriggerEvent {
    PhysicsTriggerEventType type = PhysicsTriggerEventType::entered;
};

struct PhysicsRaycastResult {
    bool has_hit = false;
    std::array<double, 3> point{};
    std::array<double, 3> normal{};
    double distance = 0.0;
};

// --- World -----------------------------------------------------------

/** `HP_World_Create`. */
[[nodiscard]] PhysicsWorldHandle physics_world_create();
/** `HP_World_SetGravity`. */
void physics_world_set_gravity(
    PhysicsWorldHandle world,
    std::array<double, 3> gravity);
/** `HP_World_GetSpeedLimit`, as the pair the pin reads `[1]` and `[2]` of. */
[[nodiscard]] PhysicsSpeedLimit physics_world_get_speed_limit(
    PhysicsWorldHandle world);
/** `HP_World_SetSpeedLimit`. */
void physics_world_set_speed_limit(
    PhysicsWorldHandle world,
    double max_linear,
    double max_angular);
/** `HP_World_AddBody`. */
void physics_world_add_body(
    PhysicsWorldHandle world,
    PhysicsBodyHandle body,
    bool start_asleep);
/**
 * `HP_World_RemoveBody`. Reached by the floating-origin module alone:
 * a body crossing a region boundary leaves one world and joins another
 * within one step.
 */
void physics_world_remove_body(
    PhysicsWorldHandle world,
    PhysicsBodyHandle body);
/**
 * `HP_World_Release`. The floating-origin module reclaims a region the
 * step after its last body migrated out.
 *
 * Release is idempotent. It detaches all bodies and frees the solver;
 * retained body handles remain valid. Identities are never recycled, and
 * the small closed state dies with its final owning handle.
 */
void physics_world_release(PhysicsWorldHandle world);
/** `HP_World_Step`, taking seconds exactly as the pin converts them. */
void physics_world_step(PhysicsWorldHandle world, double seconds);
[[nodiscard]] const std::vector<PhysicsCollisionEvent>&
physics_world_collision_events(PhysicsWorldHandle world);
/** `HP_World_GetTriggerEvents`, drained into one list per step. */
[[nodiscard]] const std::vector<PhysicsTriggerEvent>&
physics_world_trigger_events(PhysicsWorldHandle world);
[[nodiscard]] PhysicsRaycastResult physics_world_raycast(
    PhysicsWorldHandle world,
    std::array<double, 3> from,
    std::array<double, 3> to,
    std::uint32_t membership,
    std::uint32_t collide_with);

// --- Shapes ----------------------------------------------------------
//
// One entry point per arm of `createPrimitivePhysicsShapeHandle`, with the
// pin's own parameter list: a sphere is a centre and a radius, a box is a
// centre, a rotation and full *extents* (not half-extents — the conversion
// belongs to the backend, because it is the backend's convention). Then one
// per arm `createPhysicsShape` derives from a mesh instead: the hull of its
// points, and the triangle soup itself.

/** `HP_Shape_CreateSphere`. */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_sphere(
    std::array<double, 3> center,
    double radius);
/** `HP_Shape_CreateBox`. `extents` is the full size, as the pin passes it. */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_box(
    std::array<double, 3> center,
    std::array<double, 4> rotation,
    std::array<double, 3> extents);
/** `HP_Shape_CreateCapsule`. */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_capsule(
    std::array<double, 3> point_a,
    std::array<double, 3> point_b,
    double radius);
/** `HP_Shape_CreateCylinder`. */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_cylinder(
    std::array<double, 3> point_a,
    std::array<double, 3> point_b,
    double radius);
/** `HP_Shape_CreateConvexHull`, with the pin's packed vec3 input expanded. */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_convex_hull(
    const std::vector<std::array<double, 3>>& positions);
/**
 * `HP_Shape_CreateMesh`: the triangle soup itself rather than its hull,
 * with the pin's two packed heap buffers expanded into the vertex list and
 * the index triples that address it.
 *
 * The one thing this shape kind cannot do is move. Havok simulates a mesh
 * shape on a dynamic body; Bullet's triangle-mesh shape is concave, and a
 * moving concave body is the case Bullet documents as unsupported -- it
 * answers no inertia tensor and no concave-concave contact. So a mesh shape
 * that reaches a DYNAMIC body refuses at the assignment, in
 * `physics_body_set_shape` and `physics_body_set_motion_type`, rather than
 * simulating something the pin did not describe.
 */
[[nodiscard]] PhysicsShapeHandle physics_shape_create_mesh(
    const std::vector<std::array<double, 3>>& positions,
    const std::vector<std::uint32_t>& indices);
/** `HP_Shape_SetMaterial`, taking the pin's own array as a record. */
void physics_shape_set_material(
    PhysicsShapeHandle shape,
    const PhysicsShapeMaterial& material);
void physics_shape_set_filter_membership_mask(
    PhysicsShapeHandle shape,
    std::uint32_t membership_mask);
void physics_shape_set_filter_collide_mask(
    PhysicsShapeHandle shape,
    std::uint32_t collide_mask);
/**
 * `HP_Shape_SetTrigger`. A trigger shape overlaps without producing a
 * contact response, and the overlaps it does produce are what
 * `physics_world_trigger_events` reports.
 */
void physics_shape_set_trigger(
    PhysicsShapeHandle shape,
    bool is_trigger);

// --- Bodies ----------------------------------------------------------

/** `HP_Body_Create`. */
[[nodiscard]] PhysicsBodyHandle physics_body_create();
/** `HP_Body_SetMotionType`, taking the back end's own motion type. */
void physics_body_set_motion_type(
    PhysicsBodyHandle body,
    PhysicsMotionType motion_type);
/** `HP_Body_SetShape`. */
void physics_body_set_shape(
    PhysicsBodyHandle body,
    PhysicsShapeHandle shape);
/** `HP_Body_GetQTransform`. */
[[nodiscard]] PhysicsTransform physics_body_get_transform(
    PhysicsBodyHandle body);
/** `HP_Body_SetQTransform`. */
void physics_body_set_transform(
    PhysicsBodyHandle body,
    const PhysicsTransform& transform);
/** `HP_Body_SetTargetQTransform` (the ACTION prestep). */
void physics_body_set_target_transform(
    PhysicsBodyHandle body,
    const PhysicsTransform& transform);
/**
 * `HP_Shape_BuildMassProperties`. `setPhysicsBodyMass` keeps the
 * shape-derived tensor and overrides only the mass scalar; that branch is
 * the pin's and lives in generated code, so this returns the tensor and
 * decides nothing.
 */
[[nodiscard]] PhysicsMassProperties physics_shape_build_mass_properties(
    PhysicsShapeHandle shape,
    double mass);

/** `HP_Body_SetMassProperties`. */
void physics_body_set_mass_properties(
    PhysicsBodyHandle body,
    const PhysicsMassProperties& properties);
/** `HP_Body_ApplyImpulse`: world-space location followed by impulse. */
void physics_body_apply_impulse(
    PhysicsBodyHandle body,
    std::array<double, 3> location,
    std::array<double, 3> impulse);
[[nodiscard]] std::array<double, 3> physics_body_get_linear_velocity(
    PhysicsBodyHandle body);
/** `HP_Body_GetAngularVelocity`. */
[[nodiscard]] std::array<double, 3> physics_body_get_angular_velocity(
    PhysicsBodyHandle body);
/**
 * `HP_Body_SetLinearVelocity` / `HP_Body_SetAngularVelocity`. A migrating
 * body is re-added to its new region with the velocity it left the old one
 * with, and `HP_World_AddBody` does not carry it.
 */
void physics_body_set_linear_velocity(
    PhysicsBodyHandle body,
    std::array<double, 3> velocity);
void physics_body_set_angular_velocity(
    PhysicsBodyHandle body,
    std::array<double, 3> velocity);
void physics_body_set_collision_events_enabled(
    PhysicsBodyHandle body,
    bool enabled);

}  // namespace bbl::pal
