/**
 * The physics family, lowered from `src/physics/havok.ts`.
 *
 * The pin already draws the line this port needs. `createHavokWorld(scene,
 * hknp)` takes the solver as a *parameter* and every call it makes on it is
 * an `HP_*` entry point, so `havok.ts` is not "the Havok integration" -- it
 * is Babylon's rigid-body semantics written against a fixed back-end
 * surface. That split is the ownership rule this repository already states:
 * everything above the line describes Babylon behaviour and is generated,
 * and the surface below it is a third-party library reached through the
 * PAL, which is the same role SDL plays.
 *
 * So what this lowerer emits is the pinned module's own logic:
 *
 * - the step gate `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`, the
 *   non-finite/non-positive rejection, and the `Math.min(stepMs,
 *   MAX_STEP_MS) / 1000` clamp -- each read out of `_stepWorld` rather than
 *   restated, so a bump that moves the ceiling moves what is emitted;
 * - the pre-step / step / post-step / after-step ORDER, which is the whole
 *   observable contract of a frame;
 * - `createPhysicsAggregate`'s own ordering (shape, body, shape assignment,
 *   material, then mass) and its `?? 0.2` friction/restitution defaults;
 * - the bounding-box shape sizing (`_boundingCenter`, `_boundingExtents`,
 *   `_boundingRadius`) term for term.
 *
 * What it deliberately does NOT emit is any solver arithmetic. There is
 * none in the pinned module to emit.
 *
 * **The one semantic divergence this repository has ever carried.** Every
 * other adaptation here is bit-faithful by construction or executed in the
 * engine the golden runs in. A different solver is neither: Bullet and
 * Havok integrate different contact models, so a body's pose after N steps
 * is a different number, not a rounding of the same one. It is recorded as
 * `substituted-physics-solver` in the scene's `fidelity.json` and it is the
 * reason no physics scene can carry a pixel threshold against a Havok
 * golden. See `docs/fidelity.md`.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";

export const havokModule = "src/physics/havok.ts";

export class PhysicsLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * `MAX_STEP_MS`, the pin's own tunnelling ceiling. Read rather than
     * restated: the value is a solver-stability contract, and a bump that
     * changes it changes what a native step does.
     */
    private maxStepMs(): number {
        const file = this.context.sourceFile(havokModule);
        return this.context.numericValue(
            this.context.variableInitializer(file, "MAX_STEP_MS"),
            file,
        );
    }

    /**
     * The `gravity ?? { x, y, z }` default `createHavokWorld` resolves.
     */
    private defaultGravity(): [number, number, number] {
        const { declaration } = this.context.functionDeclaration(
            havokModule,
            "createHavokWorld",
        );
        const initializer = this.context.variableInitializer(
            declaration,
            "g",
        );
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken ||
            !ts.isObjectLiteralExpression(initializer.right)
        ) {
            this.context.contractError(
                initializer,
                "Expected createHavokWorld to default its gravity " +
                    "through `gravity ?? { x, y, z }`.",
            );
        }
        const file = this.context.sourceFile(havokModule);
        return ["x", "y", "z"].map((axis) =>
            this.context.numericValue(
                this.context.propertyInitializer(
                    initializer.right as ts.ObjectLiteralExpression,
                    axis,
                ),
                file,
            ),
        ) as [number, number, number];
    }

    /**
     * `createPhysicsAggregate`'s `options.friction ?? 0.2` and
     * `options.restitution ?? 0.2`. Two separate reads, because the pin
     * writes two separate defaults and a bump may move only one.
     */
    private aggregateMaterialDefaults(): {
        friction: number;
        restitution: number;
    } {
        const { declaration } = this.context.functionDeclaration(
            havokModule,
            "createPhysicsAggregate",
        );
        const file = this.context.sourceFile(havokModule);
        const read = (name: string): number => {
            const initializer = this.context.variableInitializer(
                declaration,
                name,
            );
            if (
                !ts.isBinaryExpression(initializer) ||
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken
            ) {
                this.context.contractError(
                    initializer,
                    `Expected createPhysicsAggregate to default ` +
                        `${name} through \`options.${name} ?? <value>\`.`,
                );
            }
            return this.context.numericValue(initializer.right, file);
        };
        return {
            friction: read("friction"),
            restitution: read("restitution"),
        };
    }

    /**
     * The numeric value of each `PhysicsShapeType` / `PhysicsMotionType`
     * member. A `const enum` is inlined by the TypeScript emitter, so the
     * declaration is the only place the number exists -- and both PALs
     * translate the emitted enumerator, so a member the pin renumbers has
     * to renumber here too.
     */
    private enumMembers(name: string): Map<string, number> {
        const file = this.context.sourceFile(havokModule);
        const declaration = file.statements.find(
            (statement): statement is ts.EnumDeclaration =>
                ts.isEnumDeclaration(statement) &&
                statement.name.text === name,
        );
        if (!declaration) {
            this.context.contractError(
                file,
                `Expected ${havokModule} to declare enum ${name}.`,
            );
        }
        const members = new Map<string, number>();
        for (const member of declaration.members) {
            if (!ts.isIdentifier(member.name) || !member.initializer) {
                this.context.contractError(
                    member,
                    `Expected ${name} members to carry explicit ` +
                        "numeric initializers.",
                );
            }
            members.set(
                member.name.text,
                this.context.numericValue(member.initializer, file),
            );
        }
        return members;
    }

    /**
     * Asserts the step gate is still the shape this port emits: reject a
     * non-finite or non-positive step, then clamp through `Math.min`
     * against `MAX_STEP_MS` and divide by 1000 into seconds. The emitted
     * C++ mirrors it; this is what fails generation if the pin's gate
     * moves rather than letting a silently different step ship.
     */
    /**
     * The pinned declarations this port RESTATES, and what must still be
     * true of each.
     *
     * A restated body is safe only while the thing it restates has not
     * moved, so every rule the emitted template folds is listed against the
     * declaration that states it. Two shapes cover all of them: fragments a
     * body must contain, and CALLS it must make in order. The second reads
     * the declaration own call nodes rather than its text, because a
     * substring scan is satisfied by a comment naming the function, and an
     * ordering a comment can reorder is not a contract.
     */
    private static readonly textContracts: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        [
            "_stepWorld",
            [
                // The step gate: which delta, and the tunnelling clamp.
                "world._fixedDeltaMs > 0 ? world._fixedDeltaMs : deltaMs",
                "!Number.isFinite(stepMs) || stepMs <= 0",
                "Math.min(stepMs, MAX_STEP_MS) / 1000",
                // Which bodies each phase touches; the template restates
                // all three predicates.
                "b._prestepType !== PhysicsPrestepType.DISABLED",
                "b._prestepType === PhysicsPrestepType.ACTION",
                "b.motionType === (PhysicsMotionType.DYNAMIC as number)",
            ],
        ],
        [
            // `unshift`, not `push`: physics integrates before every other
            // before-render callback, so a scene reading a pose in one
            // reads this frame pose rather than the previous frame one.
            "createHavokWorld",
            ["scene._beforeRender.unshift(stepCb)"],
        ],
        [
            "_syncBodyToNode",
            [
                "node.position.set(pos[0], pos[1], pos[2])",
                "node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3])",
            ],
        ],
        [
            // `mass === 0` is what makes a body static, and a mass is
            // written only for a positive one.
            "createPhysicsAggregate",
            ["options.mass === 0", "options.mass > 0"],
        ],
        [
            // The material array in the pin own field order. Which combine
            // mode applies to which channel travels across the PAL surface
            // as data, so a flip upstream has to fail here.
            "setPhysicsShapeMaterial",
            [
                "[friction, friction, restitution, combines.MINIMUM, combines.MAXIMUM]",
            ],
        ],
        [
            // The motion-type mapping the generated body factory performs.
            // Upstream does not pass its own enum to the solver either.
            "createPhysicsBody",
            [
                "hknp.MotionType.STATIC",
                "hknp.MotionType.KINEMATIC",
                "hknp.MotionType.DYNAMIC",
            ],
        ],
        [
            // `setPhysicsBodyMass` keeps the shape-derived tensor and
            // overrides only the mass scalar. The generated code performs
            // that branch, so the branch has to still be the pin one.
            "setPhysicsBodyMass",
            [
                "body._shape ? buildMassProperties(world, body)",
                "massProps[1] = mass",
            ],
        ],
    ];

    /** The calls each declaration must make, in this order. */
    private static readonly orderContracts: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        [
            // The four phases of a frame. A reordering is invisible in
            // every single expression and changes every frame.
            "_stepWorld",
            ["_syncNodeToBodyTarget", "HP_World_Step", "_syncBodyToNode"],
        ],
        [
            // Upstream comments this ordering because it is observable:
            // mass derives from the shape, so a mass written before the
            // shape is attached reads a different inertia tensor.
            "createPhysicsAggregate",
            [
                "createPhysicsBody",
                "setPhysicsBodyShape",
                "setPhysicsShapeMaterial",
                "setPhysicsBodyMass",
            ],
        ],
        [
            // Motion type, then add to world, then transform: the solver
            // resets a body transform on add, which is why the pin orders
            // it this way and the generated factory follows.
            "createPhysicsBody",
            [
                "HP_Body_Create",
                "HP_Body_SetMotionType",
                "HP_World_AddBody",
                "HP_Body_SetQTransform",
            ],
        ],
    ];

    private pinnedDeclaration(symbolName: string): ts.FunctionDeclaration {
        return this.context.functionDeclaration(havokModule, symbolName)
            .declaration;
    }

    /** Every rule the emitted template folds, checked where it is stated. */
    private assertPinnedContracts(): void {
        for (const [symbolName, fragments] of PhysicsLowerer
            .textContracts) {
            const declaration = this.pinnedDeclaration(symbolName);
            const text = declaration.getText(
                this.context.sourceFile(havokModule),
            );
            for (const fragment of fragments) {
                if (text.includes(fragment)) continue;
                this.context.contractError(
                    declaration,
                    "Expected " + symbolName + " to carry '" +
                        fragment + "'. The generated physics " +
                        "translation unit restates this rule, so a " +
                        "pinned change to it fails generation rather " +
                        "than shipping a different simulation.",
                );
            }
        }
        for (const [symbolName, callees] of PhysicsLowerer
            .orderContracts) {
            const declaration = this.pinnedDeclaration(symbolName);
            const called = this.context
                .findNodes(declaration, ts.isCallExpression)
                .map((call) => {
                    const callee = call.expression;
                    if (ts.isPropertyAccessExpression(callee)) {
                        return callee.name.text;
                    }
                    return ts.isIdentifier(callee) ? callee.text : "";
                });
            let cursor = -1;
            for (const callee of callees) {
                const at = called.indexOf(callee, cursor + 1);
                if (at <= cursor) {
                    this.context.contractError(
                        declaration,
                        "Expected " + symbolName + " to call " +
                            callees.join(" then ") + "; '" + callee +
                            "' is missing or out of that order.",
                    );
                }
                cursor = at;
            }
        }
    }

    public lowerPhysics(): LoweredSource {
        this.assertPinnedContracts();

        const maxStepMs = this.maxStepMs();
        const gravity = this.defaultGravity();
        const defaults = this.aggregateMaterialDefaults();
        const shapeTypes = this.enumMembers("PhysicsShapeType");
        const motionTypes = this.enumMembers("PhysicsMotionType");
        const prestepTypes = this.enumMembers("PhysicsPrestepType");

        const enumeratorList = (
            members: Map<string, number>,
        ): string =>
            [...members]
                .map(([name, value]) => `    ${name} = ${value},`)
                .join("\n");

        const header = `// ${this.context.provenance(
            havokModule,
            "createHavokWorld",
            "the pin's own rigid-body semantics; the HP_* back end is " +
                "the PAL's",
        )}
#pragma once

#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

#include "bblite/js_data.hpp"
#include "bblite/pal_physics.hpp"
#include "bblite/runtime.hpp"

namespace bbl::upstream {

/** ${havokModule} \`PhysicsShapeType\`. */
enum class PhysicsShapeType : std::int32_t {
${enumeratorList(shapeTypes)}
};

/** ${havokModule} \`PhysicsMotionType\`. */
enum class PhysicsMotionType : std::int32_t {
${enumeratorList(motionTypes)}
};

/**
 * \`createPhysicsBody\`'s own mapping onto the back end's motion types.
 * Upstream does not pass its enum through either -- it maps
 * \`STATIC/ANIMATED/DYNAMIC\` onto \`hknp.MotionType.STATIC/KINEMATIC/
 * DYNAMIC\` -- so the mapping is Babylon behaviour and lives here rather
 * than in whichever solver is linked.
 */
[[nodiscard]] inline pal::PhysicsMotionType pinned_motion_type(
    PhysicsMotionType motion_type) {
    switch (motion_type) {
        case PhysicsMotionType::STATIC:
            return pal::PhysicsMotionType::immovable;
        case PhysicsMotionType::ANIMATED:
            return pal::PhysicsMotionType::node_driven;
        case PhysicsMotionType::DYNAMIC:
            return pal::PhysicsMotionType::simulated;
    }
    return pal::PhysicsMotionType::immovable;
}

/** ${havokModule} \`PhysicsPrestepType\`. */
enum class PhysicsPrestepType : std::int32_t {
${enumeratorList(prestepTypes)}
};

/**
 * \`MAX_STEP_MS\` -- the pin's tunnelling ceiling, read from its own
 * declaration. A long hitch otherwise hands the solver one huge dt.
 */
inline constexpr double physics_max_step_ms = ${this.context.doubleLiteral(
            maxStepMs,
        )};

/** \`createHavokWorld\`'s own \`gravity ?? { ... }\`. */
[[nodiscard]] inline Vec3d pinned_default_gravity() {
    return Vec3d{${gravity
        .map((component) => this.context.doubleLiteral(component))
        .join(", ")}};
}

/** \`createPhysicsAggregate\`'s \`options.friction ?? ...\`. */
inline constexpr double physics_default_friction = ${this.context.doubleLiteral(
            defaults.friction,
        )};
/** \`createPhysicsAggregate\`'s \`options.restitution ?? ...\`. */
inline constexpr double physics_default_restitution = ${this.context.doubleLiteral(
            defaults.restitution,
        )};

/** ${havokModule} \`PhysicsAggregateOptions\`, reached slice. */
struct PhysicsAggregateOptions {
    double mass = 0.0;
    js::Nullable<double> friction{};
    js::Nullable<double> restitution{};
};

/**
 * ${havokModule} \`PhysicsShape\`. The pin's \`_type\` is dropped: it is read
 * only by the mesh-shape arms, which refuse at generation.
 */
struct PhysicsShape {
    pal::PhysicsShapeHandle handle{};
};

/**
 * ${havokModule} \`PhysicsBody\`, trimmed to the reached slice the way
 * \`PhysicsAggregateOptions\` above it is. The pin's \`_shape\` is held only
 * so \`setPhysicsBodyMass\` can branch on it, and that branch runs while the
 * aggregate is still building, so it is a local there rather than a field.
 */
struct PhysicsBody {
    pal::PhysicsBodyHandle handle{};
    MeshHandle node{};
    PhysicsMotionType motion_type = PhysicsMotionType::STATIC;
    PhysicsPrestepType prestep_type = PhysicsPrestepType::TELEPORT;
    bool pre_step = false;
};

/** ${havokModule} \`PhysicsAggregate\`. */
struct PhysicsAggregate {
    PhysicsShape shape{};
};

/**
 * ${havokModule} \`PhysicsWorld\`. The pin keeps \`_hknp\` beside
 * \`_hkWorld\`; here the module is the PAL and only the world handle
 * travels.
 */
struct PhysicsWorld {
    pal::PhysicsWorldHandle handle{};
    Engine* engine = nullptr;
    std::vector<PhysicsBody> bodies;
    /**
     * \`_fixedDeltaMs\`: the world's own step, independent of the scene.
     * Stays at the pin's own default because the only things that write it
     * -- \`setPhysicsTimestep\` and \`setPhysicsTimestepMs\` -- are outside
     * the reached slice, so the gate below takes its \`deltaMs\` arm exactly
     * as the pin's does. The field is the pin's state, not dead weight: it
     * is what the gate reads.
     */
    double fixed_delta_ms = 0.0;
    std::vector<std::function<void(float)>> after_step;
};

/**
 * A world is engine-owned state addressed by a typed handle, like every
 * other record here. The scene binds what \`createHavokWorld\` returned with
 * \`auto\`, so a reference would be copied at the binding and the bodies a
 * later \`createPhysicsAggregate\` appends would land on the copy while the
 * step closure kept stepping the original -- a world that simulates and
 * never moves a mesh.
 */
struct PhysicsWorldHandle {
    std::uint32_t value = 0;
};

[[nodiscard]] PhysicsWorldHandle create_havok_world(
    Scene& scene,
    Vec3d gravity);
void on_physics_after_step(
    PhysicsWorldHandle world,
    std::function<void(float)> callback);
PhysicsAggregate create_physics_aggregate(
    PhysicsWorldHandle world,
    MeshHandle mesh,
    PhysicsShapeType type,
    const PhysicsAggregateOptions& options);

}  // namespace bbl::upstream
`;

        const source = `// ${this.context.provenance(
            havokModule,
            "_stepWorld",
        )}
#include "bblite/upstream/physics.hpp"

#include <algorithm>
#include <deque>
#include <stdexcept>

namespace bbl::upstream {
namespace {

/**
 * The worlds a scene created. A \`PhysicsWorld\` is handed out by
 * reference and captured by the step closure, so the container must not
 * move its elements -- the same reason the engine's own record arenas are
 * stable.
 */
std::deque<PhysicsWorld>& physics_worlds() {
    static std::deque<PhysicsWorld> worlds;
    return worlds;
}

PhysicsWorld& physics_world_record(PhysicsWorldHandle handle) {
    return physics_worlds()[handle.value];
}

/**
 * The pin's \`mesh.boundMin\` / \`mesh.boundMax\`. \`mesh-factories.ts\`
 * fills them from \`computeAabb(positions)\` over the generated vertices,
 * which is the same box the generated factories already record on the
 * geometry -- so the physics shape is sized from the geometry the renderer
 * draws rather than from a second derivation. A mesh with no geometry has
 * no box, exactly as the pin's optional pair is absent, and each helper
 * falls back to the pin's own literal.
 */
struct MeshBounds {
    bool present = false;
    Vec3 minimum{};
    Vec3 maximum{};
};

MeshBounds mesh_bounds(const Engine& engine, const MeshRecord& mesh) {
    if (mesh.geometry >= engine.geometries.size()) {
        return MeshBounds{};
    }
    const ModelGeometry& geometry = engine.geometries[mesh.geometry];
    return MeshBounds{true, geometry.bounds_min, geometry.bounds_max};
}

/** \`_boundingCenter\`, including its \`{ x: 0, y: 0, z: 0 }\` fallback. */
Vec3d bounding_center(const MeshBounds& bounds) {
    if (!bounds.present) {
        return Vec3d{0.0, 0.0, 0.0};
    }
    return Vec3d{
        (static_cast<double>(bounds.minimum.x) +
         static_cast<double>(bounds.maximum.x)) *
            0.5,
        (static_cast<double>(bounds.minimum.y) +
         static_cast<double>(bounds.maximum.y)) *
            0.5,
        (static_cast<double>(bounds.minimum.z) +
         static_cast<double>(bounds.maximum.z)) *
            0.5,
    };
}

/** \`_boundingExtents\`, including its \`{ x: 1, y: 1, z: 1 }\` fallback. */
Vec3d bounding_extents(const MeshBounds& bounds) {
    if (!bounds.present) {
        return Vec3d{1.0, 1.0, 1.0};
    }
    return Vec3d{
        static_cast<double>(bounds.maximum.x) -
            static_cast<double>(bounds.minimum.x),
        static_cast<double>(bounds.maximum.y) -
            static_cast<double>(bounds.minimum.y),
        static_cast<double>(bounds.maximum.z) -
            static_cast<double>(bounds.minimum.z),
    };
}

/**
 * \`_boundingRadius\`: half the LARGEST extent, not half the diagonal,
 * with the pin's own \`0.5\` fallback.
 */
double bounding_radius(const MeshBounds& bounds) {
    if (!bounds.present) {
        return 0.5;
    }
    const Vec3d extents = bounding_extents(bounds);
    return std::max({extents.x, extents.y, extents.z}) * 0.5;
}

/** \`_syncBodyToNode\`: the integrated pose written back onto the node. */
void sync_body_to_node(Engine& engine, const PhysicsBody& body) {
    const pal::PhysicsTransform transform =
        pal::physics_body_get_transform(body.handle);
    MeshRecord& mesh = engine.meshes[body.node.value];
    mesh.position = Vec3{
        static_cast<float>(transform.position[0]),
        static_cast<float>(transform.position[1]),
        static_cast<float>(transform.position[2]),
    };
    mesh.rotation_quaternion = Vec4{
        static_cast<float>(transform.rotation[0]),
        static_cast<float>(transform.rotation[1]),
        static_cast<float>(transform.rotation[2]),
        static_cast<float>(transform.rotation[3]),
    };
    mesh.has_rotation_quaternion = true;
    ++mesh.transform_version;
}

/** \`_syncNodeToBody\` / \`_syncNodeToBodyTarget\`. */
void sync_node_to_body(
    const Engine& engine,
    const PhysicsBody& body,
    bool as_target) {
    const MeshRecord& mesh = engine.meshes[body.node.value];
    const pal::PhysicsTransform transform{
        {mesh.position.x, mesh.position.y, mesh.position.z},
        {mesh.rotation_quaternion.x, mesh.rotation_quaternion.y,
         mesh.rotation_quaternion.z, mesh.rotation_quaternion.w},
    };
    if (as_target) {
        pal::physics_body_set_target_transform(body.handle, transform);
    } else {
        pal::physics_body_set_transform(body.handle, transform);
    }
}

/**
 * \`_stepWorld\`. The gate, the clamp and the four phases are the pinned
 * module's; \`assertStepGate\` in the lowerer fails generation if any of
 * them moves.
 */
void step_world(PhysicsWorld& world, double delta_ms) {
    const double step_ms =
        world.fixed_delta_ms > 0.0 ? world.fixed_delta_ms : delta_ms;
    if (!std::isfinite(step_ms) || step_ms <= 0.0) {
        return;
    }
    const double dt = std::min(step_ms, physics_max_step_ms) / 1000.0;

    Engine& engine = *world.engine;
    for (const PhysicsBody& body : world.bodies) {
        if (body.prestep_type != PhysicsPrestepType::DISABLED &&
            (body.motion_type == PhysicsMotionType::ANIMATED ||
             body.pre_step)) {
            sync_node_to_body(
                engine,
                body,
                body.prestep_type == PhysicsPrestepType::ACTION);
        }
    }

    pal::physics_world_step(world.handle, dt);

    for (const PhysicsBody& body : world.bodies) {
        if (body.motion_type == PhysicsMotionType::DYNAMIC) {
            sync_body_to_node(engine, body);
        }
    }

    for (const auto& callback : world.after_step) {
        callback(static_cast<float>(dt));
    }
}

}  // namespace

PhysicsWorldHandle create_havok_world(Scene& scene, Vec3d gravity) {
    const PhysicsWorldHandle handle{
        static_cast<std::uint32_t>(physics_worlds().size())};
    PhysicsWorld& world = physics_worlds().emplace_back();
    world.handle = pal::physics_world_create();
    world.engine = scene.engine;
    pal::physics_world_set_gravity(
        world.handle, {gravity.x, gravity.y, gravity.z});

    // \`scene._beforeRender.unshift(stepCb)\`: physics integrates before
    // every other before-render callback, so a scene reading a pose in one
    // reads this frame's rather than the previous frame's.
    scene.before_render.insert(
        scene.before_render.begin(),
        [handle](float delta_ms) {
            step_world(
                physics_world_record(handle),
                static_cast<double>(delta_ms));
        });
    return handle;
}

void on_physics_after_step(
    PhysicsWorldHandle handle,
    std::function<void(float)> callback) {
    physics_world_record(handle).after_step.push_back(
        std::move(callback));
}

PhysicsAggregate create_physics_aggregate(
    PhysicsWorldHandle handle,
    MeshHandle mesh,
    PhysicsShapeType type,
    const PhysicsAggregateOptions& options) {
    PhysicsWorld& world = physics_world_record(handle);
    Engine& engine = *world.engine;
    const MeshRecord& record = engine.meshes[mesh.value];
    const MeshBounds bounds = mesh_bounds(engine, record);

    // \`_buildShapeParams\`: the reached slice names no explicit geometry,
    // so every parameter comes from the mesh's own bounds.
    PhysicsShape shape{};
    const Vec3d center = bounding_center(bounds);
    switch (type) {
        case PhysicsShapeType::SPHERE:
            shape.handle = pal::physics_shape_create_sphere(
                {center.x, center.y, center.z}, bounding_radius(bounds));
            break;
        case PhysicsShapeType::BOX: {
            const Vec3d extents = bounding_extents(bounds);
            shape.handle = pal::physics_shape_create_box(
                {center.x, center.y, center.z},
                {0.0, 0.0, 0.0, 1.0},
                {extents.x, extents.y, extents.z});
            break;
        }
        case PhysicsShapeType::CAPSULE:
            shape.handle = pal::physics_shape_create_capsule(
                {0.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
                bounding_radius(bounds));
            break;
        case PhysicsShapeType::CYLINDER:
            shape.handle = pal::physics_shape_create_cylinder(
                {0.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
                bounding_radius(bounds));
            break;
        default:
            throw std::runtime_error(
                "createPhysicsAggregate supports only primitive physics "
                "shapes.");
    }

    // \`createPhysicsBody\`: motion type, add to world, then transform --
    // in that order, because the solver resets a body's transform on add.
    PhysicsBody body{};
    body.node = mesh;
    body.motion_type = options.mass == 0.0
                           ? PhysicsMotionType::STATIC
                           : PhysicsMotionType::DYNAMIC;
    body.handle = pal::physics_body_create();
    pal::physics_body_set_motion_type(
        body.handle, pinned_motion_type(body.motion_type));
    pal::physics_world_add_body(world.handle, body.handle, false);
    sync_node_to_body(engine, body, false);

    // \`setPhysicsBodyShape\`, then the material, then the mass. The order
    // is the pin's and is observable: mass derives from the shape.
    pal::physics_body_set_shape(body.handle, shape.handle);

    // \`setPhysicsShapeMaterial\`: the pin writes one friction into both
    // channels and picks a combine mode per channel, which travels as data
    // rather than being re-decided by the linked solver.
    const double friction = options.friction ? *options.friction
                                             : physics_default_friction;
    const double restitution = options.restitution ? *options.restitution
                                      : physics_default_restitution;
    pal::physics_shape_set_material(
        shape.handle,
        pal::PhysicsShapeMaterial{
            friction,
            friction,
            restitution,
            pal::PhysicsMaterialCombine::minimum,
            pal::PhysicsMaterialCombine::maximum,
        });

    // \`setPhysicsBodyMass\`: start from the shape-derived mass properties
    // and override only the mass scalar. The branch is the pin's -- a
    // shapeless body would take its isotropic fallback instead -- and the
    // aggregate always has a shape by here, which is why only this arm is
    // emitted.
    if (options.mass > 0.0) {
        pal::PhysicsMassProperties properties =
            pal::physics_shape_build_mass_properties(
                shape.handle, options.mass);
        properties.mass = options.mass;
        pal::physics_body_set_mass_properties(body.handle, properties);
    }

    world.bodies.push_back(body);
    return PhysicsAggregate{shape};
}

}  // namespace bbl::upstream
`;

        return {
            header,
            source,
            modulePath: havokModule,
            symbolName: "createHavokWorld",
        };
    }
}
