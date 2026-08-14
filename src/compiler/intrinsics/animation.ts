import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

interface CompiledAnimationClip {
    cpp: string;
    frameRate: string;
    duration: string;
}

export interface AnimationIntrinsicContext
    extends IntrinsicCallContext {
    compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): CompiledAnimationClip;
    compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string;
    compileNumber(expression: ts.Expression): string;
    requireDefaultScene(node: ts.Node): Value;
    requireEngine(value: Value, node: ts.Node): string;
}

export function compileAnimationIntrinsic(
    context: AnimationIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createAnimationManager":
            context.expectArgumentCount(call, 0, 0);
            context.reachFeature("animation:property");
            return {
                kind: "animation-manager",
                cpp: "bbl::create_animation_manager()",
            };

        case "createPropertyAnimationClip": {
            context.expectArgumentCount(call, 2, 3);
            const compiled =
                context.compilePropertyAnimationClip(
                    call.arguments[0]!,
                    call.arguments[1]!,
                    call.arguments[2],
                );
            context.reachFeature("animation:property");
            return {
                kind: "animation-clip",
                cpp: compiled.cpp,
                animationFrameRate: compiled.frameRate,
                animationDuration: compiled.duration,
            };
        }

        case "createPropertyAnimationGroup": {
            context.expectArgumentCount(call, 3, 4);
            const manager =
                context.compileValue(call.arguments[0]!);
            const target =
                context.compileValue(call.arguments[1]!);
            const clip =
                context.compileValue(call.arguments[2]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            context.expectKind(
                target,
                "mesh",
                call.arguments[1]!,
            );
            context.expectKind(
                clip,
                "animation-clip",
                call.arguments[2]!,
            );
            const options =
                context.compilePropertyAnimationGroupOptions(
                    call.arguments[3],
                    clip,
                );
            context.reachFeature("animation:property");
            return {
                kind: "animation-group",
                cpp:
                    `bbl::create_property_animation_group(` +
                    `${manager.cpp}, ${target.cpp}, ` +
                    `${clip.cpp}, ${options})`,
                engineCpp: context.requireEngine(target, call),
            };
        }

        case "startAnimationManager": {
            context.expectArgumentCount(call, 1, 1);
            const manager =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            const scene =
                context.requireDefaultScene(call);
            context.reachFeature("animation:property");
            return {
                kind: "void",
                cpp:
                    `bbl::start_animation_manager(` +
                    `${manager.cpp}, ${scene.cpp})`,
            };
        }

        case "goToFrame": {
            context.expectArgumentCount(call, 2, 2);
            const group =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                group,
                "animation-group",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::go_to_frame(${group.cpp}, ` +
                    `${context.requireEngine(group, call)}, ` +
                    `${context.compileNumber(
                        call.arguments[1]!,
                    )})`,
            };
        }

        default:
            return undefined;
    }
}
