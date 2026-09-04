// The physics family: `createHavokWorld`, `createPhysicsAggregate`,
// `onPhysicsAfterStep`.
//
// The pin's own boundary is the one this port keeps. `havok.ts` takes the
// Havok WASM module as a *parameter* (`createHavokWorld(scene, hknp)`) and
// only ever calls `HP_*` entry points on it, so the module is already a
// replaceable back end rather than a dependency baked through the layer.
// Everything above that line -- the world record, the body list, the shape
// parameters derived from a mesh's bounds, the pre/post-step sync order,
// the aggregate's own ordering -- is Babylon behaviour and is generated
// from the pinned declarations. Everything below it is the PAL's.
//
// So the `hknp` a scene loads reaches nothing native: `createEngineModule`
// values are accepted and dropped, the way the material-tracking installers
// are. A native build links a solver through `pal_physics_*.cpp` and never
// sees the WASM the browser loaded.
import ts from "typescript";
import type { CompilerSymbols } from "../symbols.js";
import {
  pinnedEnumMemberName,
  validateObjectProperties,
  type ObjectValidationContext,
} from "../option-helpers.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
  requiredObjectNumber,
  type RequiredObjectNumberContext,
} from "./engine-options.js";

export interface PhysicsIntrinsicContext
  extends
    IntrinsicCallContext,
    ObjectValidationContext,
    RequiredObjectNumberContext {
  readonly symbols: CompilerSymbols;
  compileVec3(
    expression: ts.Expression,
    precision?: "float" | "double",
  ): string;
  compileBoolean(expression: ts.Expression): string;
  expectSameEngine(left: Value, right: Value, node: ts.Node): void;
  expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression;
  compileFrameCallback(expression: ts.Expression): string;
  compilePhysicsCollisionCallback(expression: ts.Expression): string;
  compilePhysicsTriggerCallback(expression: ts.Expression): string;
  allocateTemporaryCppName(label: string): string;
  emit(line: string): void;
}

/**
 * The shape types `createPrimitivePhysicsShapeHandle` answers for, by the
 * pinned `PhysicsShapeType` enumerator name. A `const enum` has no runtime
 * object to read, so the member a scene names is resolved here and the
 * pinned numeric values are asserted against the declaration by
 * `physics-lowerer.ts` rather than restated as literals in this file.
 */
const PRIMITIVE_SHAPE_TYPES = ["SPHERE", "CAPSULE", "CYLINDER", "BOX"] as const;

/**
 * The two arms `createPhysicsShape` builds from a `mesh` rather than a
 * parameter bag: the hull of its points, and the triangle soup itself.
 * `createPhysicsAggregate` accepts either name and reaches the pin's own
 * `supports only primitive physics shapes` throw, exactly as it does
 * upstream.
 */
const MESH_SHAPE_TYPES = ["CONVEX_HULL", "MESH"] as const;

const SHAPE_TYPES = [...PRIMITIVE_SHAPE_TYPES, ...MESH_SHAPE_TYPES] as const;

/**
 * The `PhysicsShapeParameters` members the reached slice lowers, as (the
 * pin's name, the generated field, how the value compiles).
 *
 * `rotation` is absent: no corpus scene passes one, so the emitted BOX arm
 * keeps the pin's own `params.rotation ?? { x: 0, y: 0, z: 0, w: 1 }`
 * default and a scene that names one refuses here.
 */
export const SHAPE_PARAMETERS = [
  ["center", "center", "vec3"],
  ["radius", "radius", "number"],
  ["pointA", "point_a", "vec3"],
  ["pointB", "point_b", "vec3"],
  ["extents", "extents", "vec3"],
] as const;

/**
 * The C++ storage one of those members takes, derived rather than restated.
 *
 * The lowerer emits `PhysicsShapeParameters` from this same table and the
 * intrinsic fills it with DESIGNATED INITIALIZERS, which C++20 requires to
 * appear in declaration order -- so the order here is load-bearing for both
 * readers, and a second copy of the table could put the emitted text out of
 * order with the struct it fills.
 */
export const shapeParameterStorage = (
  shape: (typeof SHAPE_PARAMETERS)[number][2],
): string => (shape === "vec3" ? "Vec3d" : "double");

/**
 * The same storage, as an emitted call site here has to spell it.
 *
 * The lowerer declares both structs inside `bbl::upstream`, where the
 * record type needs no qualifier; the calls this file emits name it from
 * the global scope. `double` is the language's own either way.
 */
const qualifiedShapeParameterStorage = (
  shape: (typeof SHAPE_PARAMETERS)[number][2],
): string => {
  const storage = shapeParameterStorage(shape);
  return storage === "double" ? storage : `bbl::${storage}`;
};

/**
 * One geometry member's compiled value.
 *
 * Both bags that declare the five members compile them the same way; only
 * the lane each is written into differs, so the compile itself is the part
 * that must not diverge between them.
 */
function compileShapeParameter(
  context: PhysicsIntrinsicContext,
  value: ts.Expression,
  shape: (typeof SHAPE_PARAMETERS)[number][2],
): string {
  return shape === "vec3"
    ? context.compileVec3(value, "double")
    : context.compileNumber(value, "double");
}

/**
 * The `PhysicsAggregateOptions` fields the reached slice lowers.
 *
 * The geometry half IS `SHAPE_PARAMETERS`: upstream declares the same five
 * members on both bags and `_buildShapeParams` resolves each one as an
 * explicit override of the bounds-derived value, through the same `??`. So
 * the aggregate reads them from that one table rather than from a second
 * list that could drift from it -- and the emitted struct is laid out from
 * the same table, in the same order, for the same reason the shape
 * parameters are. `rotation` stays absent from both, so a rotated primitive
 * still refuses rather than shipping the pin's identity quaternion.
 */
const AGGREGATE_OPTIONS = [
  "mass",
  "friction",
  "restitution",
  "shape",
  ...SHAPE_PARAMETERS.map(([pinned]) => pinned),
  "startAsleep",
] as const;

export function compilePhysicsIntrinsic(
  context: PhysicsIntrinsicContext,
  importedName: string,
  call: ts.CallExpression,
): Value | undefined {
  switch (importedName) {
    case "createHavokWorld": {
      // `(scene, hknp, gravity?)`. The module argument is required by
      // the pin's signature and carries nothing here, so it is
      // compiled (to reach its own diagnostics) and dropped.
      context.expectArgumentCount(call, 2, 3);
      const scene = context.compileValue(call.arguments[0]!);
      context.expectKind(scene, "scene", call.arguments[0]!);
      const engineModule = context.compileValue(call.arguments[1]!);
      if (engineModule.kind !== "physics-engine-module") {
        context.fail(
          call.arguments[1]!,
          "createHavokWorld's second argument must be the " +
            "physics engine module a scene loads " +
            "(`await HavokPhysics(...)`). A native build " +
            "reaches its solver through the PAL, so the " +
            "value is accepted and carries nothing.",
        );
      }
      // `gravity ?? { x: 0, y: -9.81, z: 0 }` is the pin's own
      // default and is resolved by the generated factory, not here.
      const gravity = call.arguments[2]
        ? context.compileVec3(call.arguments[2], "double")
        : "bbl::upstream::pinned_default_gravity()";
      context.reachFeature("physics:world", call);
      return {
        kind: "physics-world",
        cpp: `bbl::upstream::create_havok_world(` + `${scene.cpp}, ${gravity})`,
        ...(scene.engineCpp ? { engineCpp: scene.engineCpp } : {}),
      };
    }

    case "enableHavokFloatingOrigin": {
      // `(world, floatingOriginWorldRadius = 100000)`. Upstream loads the
      // floating-origin runtime with a dynamic `import()` from inside this
      // function, so the CALL is the opt-in and nothing else has to be
      // sniffed to know a world simulates in regions. The default radius
      // is the pin's own parameter initializer, read by the lowerer from
      // that declaration rather than restated here.
      context.expectArgumentCount(call, 1, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      const radius = call.arguments[1]
        ? context.compileNumber(call.arguments[1], "double")
        : "bbl::upstream::pinned_floating_origin_radius";
      context.reachFeature("physics:floating-origin", call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::enable_havok_floating_origin(` +
          `${world.cpp}, ${radius})`,
      };
    }

    case "setPhysicsTimestepMs": {
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_timestep_ms(` +
          `${world.cpp}, ${context.compileNumber(call.arguments[1]!, "double")})`,
      };
    }

    case "createPhysicsShape": {
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      const options = context.expectObjectLiteral(call.arguments[1]!);
      validateObjectProperties(
        context,
        options,
        ["type", "parameters", "mesh", "includeChildMeshes"],
        "A physics shape option outside the reached slice.",
      );
      const typeExpression = context.objectProperty(options, "type");
      if (!typeExpression) {
        context.fail(call.arguments[1]!, "createPhysicsShape requires `type`.");
      }
      const shapeType = expectShapeType(context, typeExpression);
      const parametersExpression = context.objectProperty(
        options,
        "parameters",
      );
      // Only one direction refuses. The pin reads
      // `options.parameters ?? {}` and every primitive arm defaults its own
      // members, so `createPhysicsShape(world, { type: SPHERE })` is a unit
      // sphere at the origin upstream and lowers to the same empty bag
      // here; refusing it would be narrower than the pin for nothing.
      const fromMesh = (MESH_SHAPE_TYPES as readonly string[]).includes(
        shapeType,
      );
      if (fromMesh && parametersExpression !== undefined) {
        context.fail(
          call.arguments[1]!,
          "createPhysicsShape builds either a primitive from " +
            "`parameters` or a collider from a `mesh`. " +
            `PhysicsShapeType.${shapeType} takes its geometry from ` +
            "`mesh`, and the parameters beside it would be read by " +
            "neither side.",
        );
      }
      if (parametersExpression) {
        // The mesh half of the options bag reaches nothing on this arm --
        // the pin's primitive factory never looks at it -- so a call that
        // supplies one is asking for a shape it will not get.
        for (const unread of ["mesh", "includeChildMeshes"] as const) {
          const supplied = context.objectProperty(options, unread);
          if (supplied) {
            context.fail(
              supplied,
              `A primitive physics shape takes its geometry from ` +
                "`parameters`; `" +
                unread +
                "` is read only by the mesh and convex-hull arms.",
            );
          }
        }
        // `createPrimitivePhysicsShapeHandle(hknp, options.type,
        // options.parameters ?? {})`: each member the arm reads defaults
        // inside the generated factory at the pin's own `??`, so an
        // omitted one is absent here rather than substituted.
        context.reachFeature("physics:aggregate", call);
        return {
          kind: "physics-shape",
          cpp:
            `bbl::upstream::create_physics_primitive_shape(` +
            `${world.cpp}, ` +
            `bbl::upstream::PhysicsShapeType::${shapeType}, ` +
            `${compileShapeParameters(context, parametersExpression)})`,
          ...(world.engineCpp ? { engineCpp: world.engineCpp } : {}),
        };
      }
      const meshExpression = context.objectProperty(options, "mesh");
      if (!meshExpression) {
        context.fail(
          call.arguments[1]!,
          "Physics mesh shapes require a mesh or transform hierarchy.",
        );
      }
      const mesh = context.compileValue(meshExpression);
      context.expectKind(mesh, "mesh", meshExpression);
      context.expectSameEngine(world, mesh, call);
      const includeChildren = context.objectProperty(
        options,
        "includeChildMeshes",
      );
      context.reachFeature("physics:aggregate", call);
      return {
        kind: "physics-shape",
        cpp:
          `bbl::upstream::create_physics_mesh_shape(` +
          `${world.cpp}, ` +
          `bbl::upstream::PhysicsShapeType::${shapeType}, ${mesh.cpp}, ` +
          `${includeChildren ? context.compileBoolean(includeChildren) : "false"})`,
        ...(mesh.engineCpp ? { engineCpp: mesh.engineCpp } : {}),
      };
    }

    case "setPhysicsShapeIsTrigger": {
      // `havok-trigger.ts`: the flag is what makes bodies pass through the
      // shape while their overlaps are reported, so it is the visible half
      // of the pair even when the event handler erases.
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const shape = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(shape, "physics-shape", call.arguments[1]!);
      context.expectSameEngine(world, shape, call);
      context.reachFeature("physics:trigger", call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_shape_is_trigger(` +
          `${world.cpp}, ${shape.cpp}, ` +
          `${context.compileBoolean(call.arguments[2]!)})`,
      };
    }

    case "createPhysicsBody": {
      // `(world, node, motionType, startsAsleep = false)`. The pin's node
      // is a `SceneNode`, so a mesh and a bare transform node both reach
      // it; the generated record carries which arena the handle addresses.
      context.expectArgumentCount(call, 3, 4);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      const node = context.compileValue(call.arguments[1]!);
      if (node.kind !== "mesh" && node.kind !== "transform-node") {
        context.fail(
          call.arguments[1]!,
          "createPhysicsBody binds a body to a scene node: a mesh or a " +
            `transform node, received ${node.kind}.`,
        );
      }
      context.expectSameEngine(world, node, call);
      const motion = expectMotionType(context, call.arguments[2]!);
      const startsAsleep = call.arguments[3]
        ? context.compileBoolean(call.arguments[3])
        : "false";
      context.reachFeature("physics:aggregate", call);
      return {
        kind: "physics-body",
        cpp:
          `bbl::upstream::create_physics_body(` +
          `${world.cpp}, bbl::upstream::physics_node(${node.cpp}), ` +
          `bbl::upstream::PhysicsMotionType::${motion}, ${startsAsleep})`,
        ...(node.engineCpp ? { engineCpp: node.engineCpp } : {}),
      };
    }

    case "setPhysicsBodyShape": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      const shape = context.compileValue(call.arguments[2]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectKind(shape, "physics-shape", call.arguments[2]!);
      context.expectSameEngine(world, body, call);
      context.expectSameEngine(world, shape, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_shape(` +
          `${world.cpp}, ${body.cpp}, ${shape.cpp})`,
      };
    }

    case "onPhysicsTrigger": {
      // The pin returns a disposer that splices the drain back out.
      // Nothing reached calls it, so the registration is the value.
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.reachFeature("physics:trigger", call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::on_physics_trigger(` +
          `${world.cpp}, ` +
          `${context.compilePhysicsTriggerCallback(call.arguments[1]!)})`,
      };
    }

    case "onPhysicsAfterStep": {
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::on_physics_after_step(` +
          `${world.cpp}, ` +
          `${context.compileFrameCallback(call.arguments[1]!)})`,
      };
    }

    case "createPhysicsAggregate": {
      context.expectArgumentCount(call, 4, 4);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      const mesh = context.compileValue(call.arguments[1]!);
      context.expectKind(mesh, "mesh", call.arguments[1]!);
      context.expectSameEngine(world, mesh, call);
      const shapeType = expectShapeType(context, call.arguments[2]!);
      const options = compileAggregateOptions(context, call.arguments[3]!);
      context.reachFeature("physics:aggregate", call);
      return {
        kind: "physics-aggregate",
        cpp:
          `bbl::upstream::create_physics_aggregate(` +
          `${world.cpp}, ${mesh.cpp}, ` +
          `bbl::upstream::PhysicsShapeType::${shapeType}, ` +
          `${options})`,
        ...(mesh.engineCpp ? { engineCpp: mesh.engineCpp } : {}),
      };
    }

    case "setPhysicsBodyMotionType": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      const motion = expectMotionType(context, call.arguments[2]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_motion_type(` +
          `${world.cpp}, ${body.cpp}, ` +
          `bbl::upstream::PhysicsMotionType::${motion})`,
      };
    }

    case "setPhysicsBodyMass": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_mass(` +
          `${world.cpp}, ${body.cpp}, ` +
          `${context.compileNumber(call.arguments[2]!, "double")})`,
      };
    }

    case "setPhysicsShapeFilterMembershipMask": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const shape = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(shape, "physics-shape", call.arguments[1]!);
      context.expectSameEngine(world, shape, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_shape_filter_membership_mask(` +
          `${world.cpp}, ${shape.cpp}, ` +
          `static_cast<std::uint32_t>(${context.compileNumber(call.arguments[2]!, "double")}))`,
      };
    }

    case "setPhysicsBodyPreStep": {
      // `(body, enabled)`: no world travels with the pin's call either,
      // because a pinned body carries its own `_world`.
      context.expectArgumentCount(call, 2, 2);
      const body = context.compileValue(call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[0]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_pre_step(` +
          `${body.cpp}, ${context.compileBoolean(call.arguments[1]!)})`,
      };
    }

    case "setPhysicsBodyPrestepType": {
      // `(body, type)`, and no world travels with it for the same reason
      // `setPhysicsBodyPreStep` above takes none. The pin's own body also
      // turns pre-step syncing ON for any type but DISABLED, which is why
      // this is not a plain field write and why the generated setter
      // restates that arm rather than the caller doing it here.
      context.expectArgumentCount(call, 2, 2);
      const body = context.compileValue(call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[0]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_prestep_type(` +
          `${body.cpp}, bbl::upstream::PhysicsPrestepType::` +
          `${expectPrestepType(context, call.arguments[1]!)})`,
      };
    }

    case "setPhysicsShapeFilterCollideMask": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const shape = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(shape, "physics-shape", call.arguments[1]!);
      context.expectSameEngine(world, shape, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_shape_filter_collide_mask(` +
          `${world.cpp}, ${shape.cpp}, ` +
          `static_cast<std::uint32_t>(${context.compileNumber(call.arguments[2]!, "double")}))`,
      };
    }

    case "getPhysicsBodyLinearVelocity": {
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      const velocity = context.allocateTemporaryCppName("physics_velocity");
      context.emit(
        `const bbl::Vec3d ${velocity} = ` +
          `bbl::upstream::get_physics_body_linear_velocity(${world.cpp}, ${body.cpp});`,
      );
      return vec3Record(velocity);
    }

    case "applyPhysicsBodyForce": {
      context.expectArgumentCount(call, 4, 4);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::apply_physics_body_force(` +
          `${world.cpp}, ${body.cpp}, ` +
          `${context.compileVec3(call.arguments[2]!, "double")}, ` +
          `${context.compileVec3(call.arguments[3]!, "double")})`,
      };
    }

    case "setPhysicsBodyCollisionEventsEnabled": {
      context.expectArgumentCount(call, 3, 3);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::set_physics_body_collision_events_enabled(` +
          `${world.cpp}, ${body.cpp}, ${context.compileBoolean(call.arguments[2]!)})`,
      };
    }

    case "onPhysicsCollision": {
      context.expectArgumentCount(call, 2, 2);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      return {
        kind: "void",
        cpp:
          `bbl::upstream::on_physics_collision(` +
          `${world.cpp}, ${context.compilePhysicsCollisionCallback(call.arguments[1]!)})`,
      };
    }

    case "physicsRaycast": {
      context.expectArgumentCount(call, 3, 4);
      const world = context.compileValue(call.arguments[0]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      let membership = "0xffffffffu";
      let collideWith = "0xffffffffu";
      if (call.arguments[3]) {
        const options = context.expectObjectLiteral(call.arguments[3]);
        validateObjectProperties(
          context,
          options,
          ["membership", "collideWith", "shouldHitTriggers"],
          "A physics raycast option outside the reached filter slice.",
        );
        const membershipExpression = context.objectProperty(options, "membership");
        const collideExpression = context.objectProperty(options, "collideWith");
        const triggers = context.objectProperty(options, "shouldHitTriggers");
        if (triggers && context.compileBoolean(triggers) !== "false") {
          context.fail(triggers, "Physics raycasts against trigger bodies are not reached.");
        }
        if (membershipExpression) {
          membership = `static_cast<std::uint32_t>(${context.compileNumber(membershipExpression, "double")})`;
        }
        if (collideExpression) {
          collideWith = `static_cast<std::uint32_t>(${context.compileNumber(collideExpression, "double")})`;
        }
      }
      const result = context.allocateTemporaryCppName("physics_raycast");
      context.emit(
        `const bbl::upstream::PhysicsRaycastResult ${result} = ` +
          `bbl::upstream::physics_raycast(${world.cpp}, ` +
          `${context.compileVec3(call.arguments[1]!, "double")}, ` +
          `${context.compileVec3(call.arguments[2]!, "double")}, ` +
          `${membership}, ${collideWith});`,
      );
      return {
        kind: "record",
        cpp: "",
        recordProperties: {
          hasHit: { kind: "boolean", cpp: `${result}.has_hit` },
          hitPoint: vec3Record(`${result}.hit_point`),
        },
      };
    }

    case "applyPhysicsImpulse": {
      context.expectArgumentCount(call, 3, 4);
      const world = context.compileValue(call.arguments[0]!);
      const body = context.compileValue(call.arguments[1]!);
      context.expectKind(world, "physics-world", call.arguments[0]!);
      context.expectKind(body, "physics-body", call.arguments[1]!);
      context.expectSameEngine(world, body, call);
      const impulse = context.compileVec3(call.arguments[2]!, "double");
      const point = call.arguments[3]
        ? compileImpulsePoint(context, call.arguments[3])
        : "std::optional<bbl::Vec3d>{}";
      return {
        kind: "void",
        cpp:
          `bbl::upstream::apply_physics_impulse(` +
          `${world.cpp}, ${body.cpp}, ${impulse}, ${point})`,
      };
    }

    default:
      return undefined;
  }
}

/**
 * A standalone shape's own geometry bag.
 *
 * Every member is optional upstream and every primitive arm defaults its
 * own, so an omitted one stays absent here and the generated factory
 * settles it at the pin's `??` -- the same treatment the aggregate's
 * friction and restitution get.
 */
function compileShapeParameters(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): string {
  const object = context.expectObjectLiteral(expression);
  validateObjectProperties(
    context,
    object,
    SHAPE_PARAMETERS.map(([pinned]) => pinned),
    "A physics shape parameter outside this prototype's reached slice " +
      `(${SHAPE_PARAMETERS.map(([pinned]) => pinned).join(", ")}). ` +
      "`rotation` reaches no corpus scene, so a rotated primitive would " +
      "ship the pin's identity quaternion rather than the one written.",
  );
  // Designated initializers, so an omitted member is the struct's own
  // absent lane and the emitted text names the field it fills. C++20 still
  // requires them in DECLARATION order, so the order of the table above is
  // load-bearing -- which is why the lowerer emits the struct from that
  // same table rather than from a copy of it.
  const written = SHAPE_PARAMETERS.flatMap(([pinned, field, shape]) => {
    const value = context.objectProperty(object, pinned);
    if (!value) return [];
    return [`.${field} = ${compileShapeParameter(context, value, shape)}`];
  });
  return `bbl::upstream::PhysicsShapeParameters{${written.join(", ")}}`;
}

/** The generated info record one pinned physics event stream hands over. */
export function physicsEventInfoType(
  event: "collision" | "trigger",
): string {
  return event === "collision"
    ? "bbl::upstream::PhysicsCollisionInfo"
    : "bbl::upstream::PhysicsTriggerInfo";
}

/**
 * The value a physics event handler's own parameter binds to.
 *
 * `havok-collision.ts` hands its callback `{ type, point, normal, impulse }`
 * and `havok-trigger.ts` hands its callback `{ type }`. Both types are the
 * pin's own uppercase strings, read back through the generated name
 * function so a comparison in scene code is against the same text the
 * browser compares.
 */
export function physicsEventInfoValue(
  event: "collision" | "trigger",
  cpp: string,
): Value {
  const type = (name: string): Value => ({
    kind: "data",
    cpp: `std::string(bbl::upstream::${name}(${cpp}.type))`,
    dataType: { kind: "string" },
  });
  if (event === "trigger") {
    return {
      kind: "record",
      cpp: "",
      recordProperties: { type: type("physics_trigger_type_name") },
    };
  }
  const vec3 = (member: string): Value => vec3Record(`${cpp}.${member}`);
  return {
    kind: "record",
    cpp: "",
    recordProperties: {
      type: type("physics_collision_type_name"),
      point: vec3("point"),
      normal: vec3("normal"),
      impulse: { kind: "number", cpp: `${cpp}.impulse` },
    },
  };
}

function vec3Record(cpp: string): Value {
  return {
    kind: "record",
    cpp: "",
    recordProperties: {
      x: { kind: "number", cpp: `${cpp}.x` },
      y: { kind: "number", cpp: `${cpp}.y` },
      z: { kind: "number", cpp: `${cpp}.z` },
    },
  };
}

function compileImpulsePoint(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): string {
  let unwrapped = expression;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isTypeAssertionExpression(unwrapped) ||
    ts.isNonNullExpression(unwrapped)
  ) {
    unwrapped = unwrapped.expression;
  }
  if (ts.isConditionalExpression(unwrapped)) {
    let absent = unwrapped.whenFalse;
    while (ts.isParenthesizedExpression(absent)) {
      absent = absent.expression;
    }
    if (!ts.isIdentifier(absent) || absent.text !== "undefined") {
      context.fail(
        absent,
        "An optional physics impulse point must use undefined for its absent arm.",
      );
    }
    const condition = context.compileValue(unwrapped.condition);
    const present =
      condition.optionalFoundCpp ??
      (condition.kind === "data" &&
      condition.dataType?.kind === "optional"
        ? `${condition.cpp}.has_value()`
        : undefined);
    if (!present) {
      context.fail(
        unwrapped.condition,
        "An optional physics impulse point requires a nullable condition.",
      );
    }
    const value = context.compileVec3(unwrapped.whenTrue, "double");
    return (
      `(${present} ? std::optional<bbl::Vec3d>{${value}} : ` +
      "std::optional<bbl::Vec3d>{})"
    );
  }
  return (
    `std::optional<bbl::Vec3d>{` +
    `${context.compileVec3(expression, "double")}}`
  );
}

/**
 * `PhysicsShapeType.SPHERE` -- a `const enum` member access. The member is
 * read by name and mapped to the generated enumerator; the reached slice is
 * the four primitives `createPrimitivePhysicsShapeHandle` builds without a
 * mesh plus the two `createPhysicsShape` builds from one, so CONTAINER and
 * HEIGHTFIELD refuse here rather than at the pin's own `throw` inside
 * `createPhysicsShape`.
 */
function expectShapeType(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): string {
  const member = pinnedEnumMemberName(context, expression, "PhysicsShapeType");
  if (!(SHAPE_TYPES as readonly string[]).includes(member)) {
    context.fail(
      expression,
      `PhysicsShapeType.${member} is not reached by this ` +
        "prototype. The primitive shapes " +
        "`createPrimitivePhysicsShapeHandle` builds and the two " +
        `mesh-derived ones are lowered (${SHAPE_TYPES.join(", ")}); ` +
        "CONTAINER and HEIGHTFIELD need their additional pinned paths.",
    );
  }
  return member;
}

/**
 * A pinned enum member the caller lists as reached.
 *
 * `expectShapeType` above keeps a refusal of its own, because the shape
 * family has unreached members and its message names what each would need.
 * The body families refuse identically -- the member is not one this port
 * knows -- and refusing the same way twice is what this holds in one place.
 */
function expectReachedEnumMember<Member extends string>(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
  enumName: string,
  members: readonly Member[],
): Member {
  const member = pinnedEnumMemberName(context, expression, enumName);
  if (!(members as readonly string[]).includes(member)) {
    context.fail(expression, `Unknown ${enumName}.${member}.`);
  }
  return member as Member;
}

function expectMotionType(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): "STATIC" | "ANIMATED" | "DYNAMIC" {
  return expectReachedEnumMember(context, expression, "PhysicsMotionType", [
    "STATIC",
    "ANIMATED",
    "DYNAMIC",
  ] as const);
}

/**
 * The prestep type a scene names.
 *
 * All three members are reached: the emitted step already forks on
 * DISABLED and on ACTION, so refusing one here would refuse a body the
 * generated pre-step arm can already carry.
 */
function expectPrestepType(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): "DISABLED" | "TELEPORT" | "ACTION" {
  return expectReachedEnumMember(context, expression, "PhysicsPrestepType", [
    "DISABLED",
    "TELEPORT",
    "ACTION",
  ] as const);
}

/**
 * The aggregate options a scene writes. `mass` is required by the pinned
 * interface and decides the motion type (`mass === 0` is STATIC); friction
 * and restitution default inside the generated factory, at the pin's own
 * `?? 0.2`, so an omitted option is absent here rather than substituted.
 */
function compileAggregateOptions(
  context: PhysicsIntrinsicContext,
  expression: ts.Expression,
): string {
  const object = context.expectObjectLiteral(expression);
  validateObjectProperties(
    context,
    object,
    AGGREGATE_OPTIONS,
    "A physics aggregate option outside this prototype's reached " +
      `slice (${AGGREGATE_OPTIONS.join(", ")}).`,
  );
  // `mass` is not optional in the pinned interface and decides the
  // motion type, so it reads through the required helper the other
  // option families use.
  const mass = requiredObjectNumber(context, object, "mass", "double");
  const optional = (name: string): string => {
    const value = context.objectProperty(object, name);
    return value
      ? `bbl::js::Nullable<double>{${context.compileNumber(value, "double")}}`
      : "bbl::js::Nullable<double>{}";
  };
  const shapeExpression = context.objectProperty(object, "shape");
  const shape = shapeExpression
    ? context.compileValue(shapeExpression)
    : undefined;
  if (shape) {
    context.expectKind(shape, "physics-shape", shapeExpression!);
  }
  // The geometry lanes, in the table's order, because the emitted struct
  // is laid out from that same table and these fill it positionally. Each
  // one is absent unless the scene wrote it: the generated factory then
  // takes the pin's own `??` and derives from the mesh's bounds instead.
  const geometry = SHAPE_PARAMETERS.map(([pinned, , shapeKind]) => {
    const lane = `bbl::js::Nullable<${qualifiedShapeParameterStorage(shapeKind)}>`;
    const value = context.objectProperty(object, pinned);
    return value
      ? `${lane}{${compileShapeParameter(context, value, shapeKind)}}`
      : `${lane}{}`;
  });
  // `createPhysicsAggregate` forwards `options.startAsleep` straight into
  // `createPhysicsBody`'s `startsAsleep = false` default, which is the
  // third argument of the pin's own `HP_World_AddBody`. An omitted option
  // is `undefined` there, and `undefined` takes the parameter default --
  // so the absent case is `false` rather than a nullable the generated
  // factory would have to settle a second time.
  const startAsleepExpression = context.objectProperty(object, "startAsleep");
  const startAsleep = startAsleepExpression
    ? context.compileBoolean(startAsleepExpression)
    : "false";
  return (
    `bbl::upstream::PhysicsAggregateOptions{` +
    `${mass}, ` +
    `${optional("friction")}, ` +
    `${optional("restitution")}, ` +
    `${shape ? `${shape.cpp}.handle` : "bbl::pal::PhysicsShapeHandle{}"}, ` +
    `${geometry.join(", ")}, ${startAsleep}}`
  );
}
