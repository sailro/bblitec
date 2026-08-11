import ts from "typescript";
import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

export interface LightIntrinsicContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    compileVec3(expression: ts.Expression): string;
    compileNumber(expression: ts.Expression): string;
    requireDefaultEngine(node: ts.Node): string;
    reachFeature(feature: Feature): void;
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
            context.reachFeature("light:hemispheric");
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
            context.reachFeature("light:directional");
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
            context.reachFeature("light:point");
            return {
                kind: "light",
                cpp:
                    `bbl::create_point_light(` +
                    `${engine}, ${position}, ${intensity})`,
                engineCpp: engine,
                lightKind: "point",
            };
        }

        default:
            return undefined;
    }
}
