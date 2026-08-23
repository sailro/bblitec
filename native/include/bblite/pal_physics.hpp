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
 * The handles are opaque integers rather than pointers so the surface stays
 * a C-shaped ABI — the same shape the WASM module exposes — and so a backend
 * can own its objects however it likes.
 */

#include <array>
#include <cstdint>

namespace bbl::pal {

/** `HP_World_Create`'s handle. */
struct PhysicsWorldHandle {
    std::uint32_t value = 0;
};

/** `HP_Body_Create`'s handle. */
struct PhysicsBodyHandle {
    std::uint32_t value = 0;
};

/** The handle every `HP_Shape_Create*` returns. */
struct PhysicsShapeHandle {
    std::uint32_t value = 0;
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
 * `HP_Body_SetMassProperties` takes. The pin's fourth member, the inertia
 * orientation, is unreached and absent.
 */
struct PhysicsMassProperties {
    std::array<double, 3> center_of_mass{};
    double mass = 0.0;
    std::array<double, 3> inertia{};
};

// --- World -----------------------------------------------------------

/** `HP_World_Create`. */
[[nodiscard]] PhysicsWorldHandle physics_world_create();
/** `HP_World_SetGravity`. */
void physics_world_set_gravity(
    PhysicsWorldHandle world,
    std::array<double, 3> gravity);
/** `HP_World_AddBody`. */
void physics_world_add_body(
    PhysicsWorldHandle world,
    PhysicsBodyHandle body,
    bool start_asleep);
/** `HP_World_Step`, taking seconds exactly as the pin converts them. */
void physics_world_step(PhysicsWorldHandle world, double seconds);

// --- Shapes ----------------------------------------------------------
//
// One entry point per arm of `createPrimitivePhysicsShapeHandle`, with the
// pin's own parameter list: a sphere is a centre and a radius, a box is a
// centre, a rotation and full *extents* (not half-extents — the conversion
// belongs to the backend, because it is the backend's convention).

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
/** `HP_Shape_SetMaterial`, taking the pin's own array as a record. */
void physics_shape_set_material(
    PhysicsShapeHandle shape,
    const PhysicsShapeMaterial& material);

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

}  // namespace bbl::pal
