import ts from "typescript";
import { validateObjectProperties } from "../option-helpers.js";
import type { PropertyAnimationTargetKind } from "../property-animation.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

interface CompiledAnimationClip {
    cpp: string;
    frameRate: string;
    duration: string;
    target: PropertyAnimationTargetKind;
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
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireDefaultScene(node: ts.Node): Value;
    requireEngine(value: Value, node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    propertyName(name: ts.PropertyName): string | undefined;
    /**
     * A list of glTF animation groups as one native vector expression:
     * a loaded container's own collection, or a static array of groups.
     */
    compileAnimationGroupList(
        expression: ts.Expression,
    ): { cpp: string; engineCpp: string };
}

/** The pinned group operations and the native functions lowered from them. */
const groupOperationNatives: Record<string, string> = {
    playAnimation: "play_animation",
    pauseAnimation: "pause_animation",
    stopAnimation: "stop_animation",
};

/**
 * The two group factories produce different native things — a loader
 * handle and the shared record a property clip is bound into — so each
 * operation states which one it serves rather than emitting a call whose
 * argument would not compile.
 */
export function requireGroupSource(
    context: { fail(node: ts.Node, message: string): never },
    group: Value,
    node: ts.Node,
    operation: string,
    want: "property" | "gltf",
): void {
    const source =
        group.animationGroupSource === "property"
            ? "property"
            : "gltf";
    if (source === want) return;
    context.fail(
        node,
        want === "property"
            ? `${operation} is lowered for a property animation group; a glTF animation group takes the loader's own group operations.`
            : `${operation} is lowered for a glTF animation group; a property animation group is driven by its manager.`,
    );
}

export function compileAnimationIntrinsic(
    context: AnimationIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createAnimationManager": {
            // The pin's options are engine, fixedDeltaMs and onUpdate. The
            // engine is what a manager driving a loaded file's clips needs
            // (its weighted mixers throw without one); the other two are
            // the autonomous loop's, which this runtime does not run.
            context.expectArgumentCount(call, 0, 1);
            context.reachFeature("animation:property", call);
            const optionsExpression = call.arguments[0];
            if (!optionsExpression) {
                return {
                    kind: "animation-manager",
                    cpp: "bbl::create_animation_manager()",
                };
            }
            const options = context.expectObjectLiteral(
                optionsExpression,
            );
            validateObjectProperties(
                context,
                options,
                ["engine"],
                "Reached animation manager options support engine.",
            );
            const engineExpression = context.objectProperty(
                options,
                "engine",
            );
            if (!engineExpression) {
                context.fail(
                    options,
                    "Reached animation manager options require engine.",
                );
            }
            const engine =
                context.compileValue(engineExpression);
            context.expectKind(
                engine,
                "engine",
                engineExpression,
            );
            return {
                kind: "animation-manager",
                cpp:
                    `bbl::create_animation_manager(` +
                    `${engine.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "addAnimationGroups": {
            // src/animation/animation-group-task.ts: each group is
            // attached to the manager, which then ticks it instead of the
            // scene doing so.
            context.expectArgumentCount(call, 2, 2);
            const manager =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            const groups = context.compileAnimationGroupList(
                call.arguments[1]!,
            );
            context.reachFeature(
                "animation:managed-groups",
                call,
            );
            context.reachFeature("animation:gltf-groups", call);
            return {
                kind: "void",
                cpp:
                    `bbl::add_animation_groups(${manager.cpp}, ` +
                    `${groups.engineCpp}, ${groups.cpp})`,
            };
        }

        case "updateAnimationManager": {
            context.expectArgumentCount(call, 2, 2);
            const manager =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            if (!manager.engineCpp) {
                context.fail(
                    call.arguments[0]!,
                    "updateAnimationManager needs a manager created with an engine.",
                );
            }
            context.reachFeature(
                "animation:managed-groups",
                call,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::update_animation_manager(` +
                    `${manager.cpp}, ${manager.engineCpp}, ` +
                    `${context.compileNumber(
                        call.arguments[1]!,
                    )})`,
            };
        }

        case "createPropertyAnimationClip": {
            context.expectArgumentCount(call, 2, 3);
            const compiled =
                context.compilePropertyAnimationClip(
                    call.arguments[0]!,
                    call.arguments[1]!,
                    call.arguments[2],
                );
            context.reachFeature("animation:property", call);
            return {
                kind: "animation-clip",
                cpp: compiled.cpp,
                animationFrameRate: compiled.frameRate,
                animationDuration: compiled.duration,
                animationTargetKind: compiled.target,
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
                clip,
                "animation-clip",
                call.arguments[2]!,
            );
            // The clip's paths name the object kind they resolve
            // against, so the target is checked against them rather than
            // fixed: a mesh clip binds a mesh, a camera clip a camera.
            const targetKind =
                clip.animationTargetKind ?? "mesh";
            context.expectKind(
                target,
                targetKind,
                call.arguments[1]!,
            );
            const options =
                context.compilePropertyAnimationGroupOptions(
                    call.arguments[3],
                    clip,
                );
            context.reachFeature("animation:property", call);
            return {
                kind: "animation-group",
                animationGroupSource: "property",
                cpp:
                    `bbl::create_property_animation_group(` +
                    `${manager.cpp}, ` +
                    `bbl::PropertyAnimationTarget{` +
                    `bbl::PropertyAnimationTargetKind::` +
                    `${targetKind}, ${target.cpp}.value}, ` +
                    `${clip.cpp}, ${options})`,
                engineCpp: context.requireEngine(target, call),
            };
        }

        case "setAnimationWeight": {
            // src/animation/animation-weight.ts is one write behind a
            // range guard, and both travel into the emitted setter. The
            // group decides where the weight lands: a property group
            // carries its own, a glTF group's lives on the engine record
            // the skeleton mixer reads.
            context.expectArgumentCount(call, 2, 2);
            const group =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                group,
                "animation-group",
                call.arguments[0]!,
            );
            const weight = context.compileNumber(
                call.arguments[1]!,
            );
            if (group.animationGroupSource === "property") {
                context.reachFeature(
                    "animation:property-blending",
                    call,
                );
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_animation_weight(` +
                        `${group.cpp}, ${weight})`,
                };
            }
            // A glTF group's weight is engine state the weighted
            // skeleton mixer reads, so it lands on the group record
            // rather than on a manager-owned clip.
            context.reachFeature(
                "animation:gltf-groups",
                call,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::set_animation_weight(` +
                    `${context.requireEngine(
                        group,
                        call.arguments[0]!,
                    )}, ${group.cpp}, ${weight})`,
            };
        }

        case "enableAnimationBlending": {
            // The pin's opt-in for the weighted glTF skeleton mixer,
            // kept separate from the property one so a manual-only scene
            // loads neither (src/animation/weighted-gltf-mixer.ts).
            context.expectArgumentCount(call, 1, 1);
            const blended =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                blended,
                "animation-manager",
                call.arguments[0]!,
            );
            context.reachFeature(
                "animation:gltf-blending",
                call,
            );
            context.reachFeature(
                "animation:managed-groups",
                call,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::enable_animation_blending(` +
                    `${blended.cpp})`,
            };
        }

        case "enablePropertyAnimationBlending": {
            // The pin's opt-in: it registers the manager's
            // `animation-group` category handler, so the manager blends
            // the tracks its groups share instead of ticking each group
            // into the same property (src/animation/
            // weighted-pointer-mixer.ts).
            context.expectArgumentCount(call, 1, 1);
            const manager =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            context.reachFeature(
                "animation:property-blending",
                call,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::enable_property_animation_blending(` +
                    `${manager.cpp})`,
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
            context.reachFeature("animation:property", call);
            return {
                kind: "void",
                cpp:
                    `bbl::start_animation_manager(` +
                    `${manager.cpp}, ${scene.cpp})`,
            };
        }

        case "playAnimation":
        case "pauseAnimation":
        case "stopAnimation": {
            // src/animation/animation-group.ts: three writes over one group.
            // Only a glTF group is reachable — a property-animation group is
            // driven by its manager — so the kind check names which.
            context.expectArgumentCount(call, 1, 1);
            const group =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                group,
                "animation-group",
                call.arguments[0]!,
            );
            requireGroupSource(
                context,
                group,
                call.arguments[0]!,
                importedName,
                "gltf",
            );
            context.reachFeature("animation:gltf-groups", call);
            const native = groupOperationNatives[importedName]!;
            return {
                kind: "void",
                cpp:
                    `bbl::${native}(` +
                    `${context.requireEngine(group, call)}, ` +
                    `${group.cpp})`,
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
            const frame = context.compileNumber(
                call.arguments[1]!,
            );
            if (group.animationGroupSource !== "property") {
                context.reachFeature(
                    "animation:gltf-groups",
                    call,
                );
                return {
                    kind: "void",
                    cpp:
                        `bbl::go_to_frame(` +
                        `${context.requireEngine(group, call)}, ` +
                        `${group.cpp}, ${frame})`,
                };
            }
            return {
                kind: "void",
                cpp:
                    `bbl::go_to_frame(${group.cpp}, ` +
                    `${context.requireEngine(group, call)}, ` +
                    `${frame})`,
            };
        }

        default:
            return undefined;
    }
}
