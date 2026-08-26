import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    compilePositiveInteger,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface ShadowIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    requireEngine(value: Value, node: ts.Node): string;
    ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): string | undefined;
    fail(node: ts.Node, message: string): never;
    recordShadowGenerator(entry: {
        kind: "pcf-spot";
        lightIndex: number;
    }): number;
}

/**
 * The options `createPcfSpotlightShadowGenerator` takes.
 *
 * `mapSize`, `bias` and `darkness` size the generator's own resources, so
 * they are resolved at generation; `near` and `far` are the projection
 * volume and stay run-time expressions, because scene 18 reads them off the
 * camera it just configured. `normalBias` and `forceRefreshEveryFrame` are
 * unreached and refuse by name rather than compiling to a value the pin
 * would have used differently.
 */
const spotOptions = [
    "mapSize",
    "bias",
    "darkness",
    "near",
    "far",
] as const;

export function compileShadowIntrinsic(
    context: ShadowIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createPcfSpotlightShadowGenerator": {
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const light = context.compileValue(call.arguments[1]!);
            context.expectKind(light, "light", call.arguments[1]!);
            if (light.lightKind !== "spot") {
                context.fail(
                    call.arguments[1]!,
                    "A PCF spotlight shadow generator takes a spot light, " +
                        `received a ${light.lightKind ?? "unknown"} light.`,
                );
            }
            if (light.sceneLightIndex === undefined) {
                context.fail(
                    call.arguments[1]!,
                    "A shadow generator's light must be added to the scene " +
                        "first: the composed receiver fragment names its " +
                        "varyings and bindings by the light's scene index.",
                );
            }
            // Each option's pinned default, in the order the emitted
            // options struct takes them. `far` resolves against the light's
            // own range, which a scene-code spot leaves at MAX_VALUE.
            const resolved: Record<string, string> = {
                mapSize: "bbl::upstream::pcf_spot_default_map_size",
                bias: "bbl::upstream::pcf_spot_default_bias",
                darkness: "bbl::upstream::pcf_spot_default_darkness",
                near: "bbl::upstream::pcf_spot_default_near",
                far: "bbl::upstream::pcf_spot_unbounded_far",
            };
            if (call.arguments[2]) {
                const options = context.expectObjectLiteral(
                    call.arguments[2],
                );
                validateObjectProperties(
                    context,
                    options,
                    spotOptions,
                    "PCF spotlight shadow generator options",
                );
                for (const name of spotOptions) {
                    const expression = context.objectProperty(options, name);
                    if (!expression) continue;
                    // The map's extent decides a GPU texture, so it takes
                    // the same generation-time resolution every other
                    // fixed-size target's dimensions take; the projection
                    // scalars stay run-time expressions, because scene 18
                    // reads two of them off the camera it just configured.
                    resolved[name] = name === "mapSize"
                        ? compilePositiveInteger(context, expression)
                        : context.compileNumber(expression, "double");
                }
            }
            const index = context.recordShadowGenerator({
                kind: "pcf-spot",
                lightIndex: light.sceneLightIndex,
            });
            context.reachFeature("shadow:pcf", call);
            return {
                kind: "shadow-generator",
                cpp:
                    `bbl::create_pcf_spotlight_shadow_generator(` +
                    `${engine.cpp}, ${light.cpp}, ` +
                    `bbl::PcfSpotShadowOptions{` +
                    `${spotOptions.map((name) => resolved[name]).join(", ")}` +
                    `})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
                shadowGeneratorIndex: index,
            };
        }

        // The pin keeps the caster list as a lazy task input rather than on
        // the generator, so this is a registration and not a property write;
        // what it decides here is which materials compose a no-colour view.
        case "setShadowTaskCasterMeshes": {
            context.expectArgumentCount(call, 2, 2);
            const generator = context.compileValue(call.arguments[0]!);
            context.expectKind(
                generator,
                "shadow-generator",
                call.arguments[0]!,
            );
            if (generator.shadowGeneratorIndex === undefined) {
                context.fail(
                    call.arguments[0]!,
                    "This shadow generator was not created in this scene.",
                );
            }
            const array = context.expectStaticArrayLiteral(
                call.arguments[1]!,
            );
            const emitted: string[] = [];
            for (const element of array.elements) {
                const mesh = context.compileValue(element);
                context.expectKind(mesh, "mesh", element);
                if (mesh.sceneMeshIndex === undefined) {
                    context.fail(
                        element,
                        "A shadow caster must be a scene-code mesh: an " +
                            "imported one's material composes through its " +
                            "asset's own variant rows.",
                    );
                }
                emitted.push(mesh.cpp);
            }
            if (emitted.length === 0) {
                context.fail(
                    call.arguments[1]!,
                    "A shadow generator with no casters renders an empty " +
                        "map; no reached scene registers one.",
                );
            }
            // The caster pass draws each mesh through its material's own
            // no-colour view, which is the same composition arm scene 116
            // reaches from scene code.
            context.reachFeature("material:no-color-view", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_shadow_task_caster_meshes(` +
                    `${context.requireEngine(generator, call)}, ` +
                    `${generator.cpp}, {${emitted.join(", ")}})`,
            };
        }

        // `registerSceneWithShadowSupport` is `registerScene` plus the
        // scene-owned `ShadowTask`, unshifted ahead of the render task the
        // scene already carries. Upstream splits the two entry points so an
        // ordinary bundle retains no shadow scheduling code, and the split
        // survives here as a different generated call.
        case "registerSceneWithShadowSupport": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            context.reachFeature("shadow:task", call);
            // The pin's shadow task is a frame-graph task unshifted ahead of
            // the scene's own render task, so a scene that reaches one has a
            // frame graph -- the same thing `addTask` says by materializing
            // the default render task before adding to it.
            const defaultTask = context.ensureDefaultRenderTask(scene, call);
            const registerCall =
                `bbl::register_scene_with_shadow_support(${scene.cpp})`;
            return {
                kind: "void",
                cpp: defaultTask
                    ? `${defaultTask};
        ${registerCall}`
                    : registerCall,
            };
        }

        default:
            return undefined;
    }
}
