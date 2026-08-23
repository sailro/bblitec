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
    extends IntrinsicCallContext,
        ObjectValidationContext,
        RequiredObjectNumberContext {
    readonly symbols: CompilerSymbols;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    compileFrameCallback(expression: ts.Expression): string;
}

/**
 * The shape types `createPrimitivePhysicsShapeHandle` answers for, by the
 * pinned `PhysicsShapeType` enumerator name. A `const enum` has no runtime
 * object to read, so the member a scene names is resolved here and the
 * pinned numeric values are asserted against the declaration by
 * `physics-lowerer.ts` rather than restated as literals in this file.
 */
const PRIMITIVE_SHAPE_TYPES = [
    "SPHERE",
    "CAPSULE",
    "CYLINDER",
    "BOX",
] as const;

/** The `PhysicsAggregateOptions` fields the reached slice lowers. */
const AGGREGATE_OPTIONS = [
    "mass",
    "friction",
    "restitution",
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
            const engineModule = context.compileValue(
                call.arguments[1]!,
            );
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
                ? context.compileVec3(
                      call.arguments[2],
                      "double",
                  )
                : "bbl::upstream::pinned_default_gravity()";
            context.reachFeature("physics:world", call);
            return {
                kind: "physics-world",
                cpp:
                    `bbl::upstream::create_havok_world(` +
                    `${scene.cpp}, ${gravity})`,
            };
        }

        case "onPhysicsAfterStep": {
            context.expectArgumentCount(call, 2, 2);
            const world = context.compileValue(call.arguments[0]!);
            context.expectKind(
                world,
                "physics-world",
                call.arguments[0]!,
            );
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
            context.expectKind(
                world,
                "physics-world",
                call.arguments[0]!,
            );
            const mesh = context.compileValue(call.arguments[1]!);
            context.expectKind(mesh, "mesh", call.arguments[1]!);
            const shapeType = expectShapeType(
                context,
                call.arguments[2]!,
            );
            const options = compileAggregateOptions(
                context,
                call.arguments[3]!,
            );
            context.reachFeature("physics:aggregate", call);
            return {
                kind: "physics-aggregate",
                cpp:
                    `bbl::upstream::create_physics_aggregate(` +
                    `${world.cpp}, ${mesh.cpp}, ` +
                    `bbl::upstream::PhysicsShapeType::${shapeType}, ` +
                    `${options})`,
            };
        }

        default:
            return undefined;
    }
}

/**
 * `PhysicsShapeType.SPHERE` -- a `const enum` member access. The member is
 * read by name and mapped to the generated enumerator; the reached slice is
 * the four primitives `createPrimitivePhysicsShapeHandle` builds without a
 * mesh, so CONVEX_HULL, MESH, CONTAINER and HEIGHTFIELD refuse here rather
 * than at the pin's own `throw` inside `createPhysicsAggregate`.
 */
function expectShapeType(
    context: PhysicsIntrinsicContext,
    expression: ts.Expression,
): string {
    if (
        !ts.isPropertyAccessExpression(expression) ||
        !ts.isIdentifier(expression.expression) ||
        context.symbols.importedName(expression.expression) !==
            "PhysicsShapeType"
    ) {
        context.fail(
            expression,
            "A physics shape type must be a `PhysicsShapeType` member.",
        );
    }
    const member = expression.name.text;
    if (
        !(PRIMITIVE_SHAPE_TYPES as readonly string[]).includes(member)
    ) {
        context.fail(
            expression,
            `PhysicsShapeType.${member} is not reached by this ` +
                "prototype. Only the primitive shapes " +
                "`createPrimitivePhysicsShapeHandle` builds are " +
                `lowered (${PRIMITIVE_SHAPE_TYPES.join(", ")}); the ` +
                "mesh and container shapes need the pin's own mesh " +
                "accumulator.",
        );
    }
    return member;
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
    return (
        `bbl::upstream::PhysicsAggregateOptions{` +
        `${mass}, ` +
        `${optional("friction")}, ` +
        `${optional("restitution")}}`
    );
}
