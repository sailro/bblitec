import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import { validateObjectProperties } from "../option-helpers.js";
import type { PhysicsIntrinsicContext } from "./physics.js";

interface CharacterOptionsContext extends Pick<LoweringServices,
    "expectObjectLiteral" | "objectProperty" | "compileNumber" | "fail" | "propertyName"
> {}

export interface CharacterIntrinsicContext extends CharacterOptionsContext, Pick<LoweringServices,
    "allocateTemporaryCppName" | "emit" | "expectArgumentCount" |
    "compilePhysicsCharacterCallback" | "compileVec3" | "compileBoolean"
> {}

function options(context: CharacterOptionsContext, expression: ts.Expression): string {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(context, object, ["capsuleHeight", "capsuleRadius"], "Character options must describe the capsule height and radius.");
    const field = (name: string): string => {
        const value = context.objectProperty(object, name);
        return value ? `std::optional<double>{${context.compileNumber(value, "double")}}` : "std::optional<double>{}";
    };
    return `bbl::character::options(${field("capsuleHeight")}, ${field("capsuleRadius")})`;
}

export function characterVectorValue(cpp: string): Value<"record"> {
    return { kind: "record", cpp: "", recordProperties: Object.fromEntries(["x", "y", "z"].map(axis => [axis, { kind: "number", cpp: `${cpp}->${axis}` } satisfies Value])) };
}

/** Preserve the Vec3 reference returned by the pin before another expression can rebind its controller. */
function retainCharacterVector(context: Pick<LoweringServices, "allocateTemporaryCppName" | "emit">, cpp: string): Value {
    const owner = context.allocateTemporaryCppName("character_vector");
    context.emit({ kind: "declaration", type: "const auto", name: owner, initializer: cpp, attributes: "[[maybe_unused]] " });
    return { ...characterVectorValue(owner), retainedNativeRecord: true };
}

export function compileCharacterIntrinsic(context: PhysicsIntrinsicContext, name: string, call: ts.CallExpression): Value | undefined {
    if (name === "createPhysicsCharacterController") {
        context.expectArgumentCount(call, 3, 3);
        const world = context.compileValue(argumentAt(call, 0));
        context.expectKind(world, "physics-world", argumentAt(call, 0));
        context.reachFeature("physics:character-controller", call);
        context.reachFeature("physics:world", call);
        context.reachFeature("mesh:transform-node", call);
        return { kind: "physics-character-controller", cpp: `bbl::character::create_physics_character_controller(${world.cpp}, ${context.compileVec3(argumentAt(call, 1), "double")}, ${options(context, argumentAt(call, 2))})`,
            dataType: { kind: "handle", handle: "physics-character-controller" }, ...(world.engineCpp ? { engineCpp: world.engineCpp } : {}) };
    }
    if (name === "getPhysicsCharacterControllerBody") {
        context.expectArgumentCount(call, 1, 1);
        const controller = context.compileValue(argumentAt(call, 0));
        context.expectKind(controller, "physics-character-controller", argumentAt(call, 0));
        return { kind: "physics-body", cpp: `${controller.cpp}->getBody()->value`, ...(controller.engineCpp ? { engineCpp: controller.engineCpp } : {}) };
    }
}

export function compileCharacterMethod(context: CharacterIntrinsicContext, call: ts.CallExpression, owner: Value, name: string): Value | undefined {
    if (owner.kind === "physics-character-observable") {
        if (name !== "add") context.fail(call, `Character observable method '${name}' is not represented.`);
        context.expectArgumentCount(call, 1, 1);
        return { kind: "data", cpp: `${owner.cpp}->onTriggerCollisionObservable.add(${context.compilePhysicsCharacterCallback(argumentAt(call, 0))})`, dataType: { kind: "function", parameters: [] } };
    }
    if (owner.kind !== "physics-character-controller") return;
    if (["moveWithCollisions", "setPosition", "setVelocity"].includes(name)) {
        context.expectArgumentCount(call, 1, 1);
        return { kind: "void", cpp: `${owner.cpp}->${name}(bbl::character::vector(${context.compileVec3(argumentAt(call, 0), "double")}))` };
    }
    if (["getPosition", "getVelocity"].includes(name)) {
        context.expectArgumentCount(call, 0, 0);
        return retainCharacterVector(context, `${owner.cpp}->${name}()`);
    }
    if (name === "getBody") {
        context.expectArgumentCount(call, 0, 0);
        return { kind: "physics-body", cpp: `${owner.cpp}->getBody()->value`, ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}) };
    }
    if (name === "setShapeOptions") {
        context.expectArgumentCount(call, 1, 2);
        return { kind: "void", cpp: `${owner.cpp}->setShapeOptions(${options(context, argumentAt(call, 0))}${call.arguments[1] ? `, ${context.compileBoolean(call.arguments[1])}` : ""})` };
    }
    if (name === "dispose") {
        context.expectArgumentCount(call, 0, 0);
        return { kind: "void", cpp: `${owner.cpp}->dispose()` };
    }
    context.fail(call, `Character method '${name}' has no represented scene value projection.`);
}

export function readCharacterProperty(context: PhysicsIntrinsicContext, owner: Value, name: string): Value | undefined {
    if (owner.kind !== "physics-character-controller") return;
    if (name === "onTriggerCollisionObservable") return { kind: "physics-character-observable", cpp: owner.cpp, ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}) };
    if (["keepDistance", "keepContactTolerance", "maxCastIterations", "penetrationRecoverySpeed", "staticFriction", "dynamicFriction", "maxSlopeCosine", "maxCharacterSpeedForSolver", "characterStrength", "acceleration", "maxAcceleration", "characterMass"].includes(name))
        return { kind: "number", cpp: `${owner.cpp}->${name}` };
    if (name === "up") return retainCharacterVector(context, `${owner.cpp}->up`);
}
