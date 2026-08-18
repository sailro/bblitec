import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface LightIntrinsicContext extends IntrinsicCallContext {
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireDefaultEngine(node: ts.Node): string;
}

export function compileLightIntrinsic(
    context: LightIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createHemisphericLight": {
            context.expectArgumentCount(call, 0, 2);
            const engine = context.requireDefaultEngine(call);
            const direction = call.arguments[0]
                ? context.compileVec3(call.arguments[0])
                : "bbl::Vec3{0.0f, 1.0f, 0.0f}";
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1])
                : "1.0f";
            context.reachFeature("light:hemispheric", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_hemispheric_light(` +
                    `${engine}, ${direction}, ${intensity})`,
                engineCpp: engine,
                lightKind: "hemispheric",
            };
        }

        case "createDirectionalLight": {
            context.expectArgumentCount(call, 1, 2);
            const engine = context.requireDefaultEngine(call);
            const direction =
                context.compileVec3(call.arguments[0]!);
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1])
                : "1.0f";
            context.reachFeature("light:directional", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_directional_light(` +
                    `${engine}, ${direction}, ${intensity})`,
                engineCpp: engine,
                lightKind: "directional",
            };
        }

        case "createPointLight": {
            context.expectArgumentCount(call, 1, 2);
            const engine = context.requireDefaultEngine(call);
            const position =
                context.compileVec3(call.arguments[0]!);
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1])
                : "1.0f";
            context.reachFeature("light:point", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_point_light(` +
                    `${engine}, ${position}, ${intensity})`,
                engineCpp: engine,
                lightKind: "point",
            };
        }

        case "createSpotLight": {
            context.expectArgumentCount(call, 4, 5);
            const engine = context.requireDefaultEngine(call);
            const position =
                context.compileVec3(call.arguments[0]!);
            const direction =
                context.compileVec3(call.arguments[1]!);
            const angle = context.compileNumber(call.arguments[2]!);
            const exponent =
                context.compileNumber(call.arguments[3]!);
            const intensity = call.arguments[4]
                ? context.compileNumber(call.arguments[4])
                : "1.0f";
            context.reachFeature("light:spot", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_spot_light(` +
                    `${engine}, ${position}, ${direction}, ` +
                    `${angle}, ${exponent}, ${intensity})`,
                engineCpp: engine,
                lightKind: "spot",
            };
        }

        default:
            return undefined;
    }
}
