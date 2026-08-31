import ts from "typescript";
import {
    pinnedEnumMemberName,
    staticNumberValue,
    validateObjectProperties,
} from "../option-helpers.js";
import type { PropertyAnimationTargetKind } from "../property-animation.js";
import type { CompilerSymbols } from "../symbols.js";
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
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    lookup(identifier: ts.Identifier): Value;
    lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined;
    requireDefaultScene(node: ts.Node): Value;
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
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
    /**
     * The resolved import symbols, so a pinned enum member is told apart
     * from a local of the same name by what it resolves to.
     */
    readonly symbols: CompilerSymbols;
}

/**
 * Which arm of the pin's `AnimationGroupMaskMode` an argument names.
 *
 * The enum's two members are the whole of the mode, and
 * `animationGroupMaskRetainsTarget` reads it as one comparison against
 * `Include` -- so what travels from here is that boolean, and the
 * generated predicate is lowered from the pin's own expression.
 */
function maskModeInclude(
    context: AnimationIntrinsicContext,
    expression: ts.Expression,
): boolean {
    const member = pinnedEnumMemberName(
        context,
        context.resolveStaticExpression(expression),
        "AnimationGroupMaskMode",
    );
    if (member !== "Include" && member !== "Exclude") {
        context.fail(
            expression,
            `AnimationGroupMaskMode.${member} is not a pinned mask mode; ` +
                "the pin declares Include and Exclude alone.",
        );
    }
    return member === "Include";
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

/** Bind a manager to its first reached engine and reject later crossings. */
function associateManagerEngine(
    context: { fail(node: ts.Node, message: string): never },
    manager: Value,
    engineCpp: string,
    node: ts.Node,
): void {
    if (
        manager.engineCpp !== undefined &&
        manager.engineCpp !== engineCpp
    ) {
        context.fail(
            node,
            "Animation manager and group/scene belong to different engines.",
        );
    }
    manager.engineCpp ??= engineCpp;
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
            associateManagerEngine(
                context,
                manager,
                groups.engineCpp,
                call,
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
            // A manager created without options acquires its engine from
            // the first property target bound into it. The pin stores that
            // association on each manager-owned task; carrying it on the
            // lowered manager lets an explicit update use the same engine.
            context.expectSameEngine(manager, target, call);
            const engine = context.requireEngine(target, call);
            associateManagerEngine(context, manager, engine, call);
            context.reachFeature("animation:property", call);
            return {
                kind: "animation-group",
                animationGroupSource: "property",
                cpp:
                    `bbl::create_property_animation_group(` +
                    `${manager.cpp}, ${engine}, ` +
                    `bbl::PropertyAnimationTarget{` +
                    `bbl::PropertyAnimationTargetKind::` +
                    `${targetKind}, ${target.cpp}.value}, ` +
                    `${clip.cpp}, ${options})`,
                engineCpp: engine,
            };
        }

        case "crossFadeAnimationGroups": {
            // src/animation/animation-weight-fade.ts: scheduling is
            // mixer-neutral and does not enable blending. Scene 156 opts
            // into the property mixer separately, then advances this job
            // through updateAnimationManager in its measured seek arm.
            context.expectArgumentCount(call, 4, 4);
            const manager = context.compileValue(call.arguments[0]!);
            const fromGroup = context.compileValue(call.arguments[1]!);
            const toGroup = context.compileValue(call.arguments[2]!);
            context.expectKind(
                manager,
                "animation-manager",
                call.arguments[0]!,
            );
            context.expectKind(
                fromGroup,
                "animation-group",
                call.arguments[1]!,
            );
            context.expectKind(
                toGroup,
                "animation-group",
                call.arguments[2]!,
            );
            context.expectSameEngine(fromGroup, toGroup, call);
            context.expectSameEngine(manager, fromGroup, call);
            const engine = context.requireEngine(
                fromGroup,
                call.arguments[1]!,
            );
            associateManagerEngine(context, manager, engine, call);
            const options = context.expectObjectLiteral(
                call.arguments[3]!,
            );
            validateObjectProperties(
                context,
                options,
                ["durationMs", "toWeight"],
                "Cross-fade options support durationMs and toWeight.",
            );
            const duration = context.objectProperty(
                options,
                "durationMs",
            );
            if (!duration) {
                context.fail(
                    options,
                    "crossFadeAnimationGroups requires durationMs.",
                );
            }
            const toWeight = context.objectProperty(
                options,
                "toWeight",
            );
            context.reachFeature("animation:property", call);
            context.reachFeature("animation:weight-fades", call);
            if (
                fromGroup.animationGroupSource !== "property" ||
                toGroup.animationGroupSource !== "property"
            ) {
                context.reachFeature("animation:gltf-groups", call);
            }
            const fadeTarget = (group: Value): string =>
                group.animationGroupSource === "property"
                    ? `bbl::AnimationWeightFadeTarget::from_property(${group.cpp})`
                    : `bbl::AnimationWeightFadeTarget::from_gltf(${group.cpp})`;
            return {
                kind: "void",
                cpp:
                    `bbl::cross_fade_animation_groups(` +
                    `${manager.cpp}, ${engine}, ` +
                    `${fadeTarget(fromGroup)}, ` +
                    `${fadeTarget(toGroup)}, ` +
                    `${context.compileNumber(duration)}, ` +
                    `${toWeight
                        ? context.compileNumber(toWeight)
                        : "1.0f"})`,
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

        case "setAnimationAdditive": {
            // src/animation/weighted-gltf-mixer.ts: the group gains its
            // additive reference (`group._additive = { referenceTime }`)
            // and, when a manager already owns it, blending is enabled on
            // that owner — both emitted at the call site. The options
            // resolve at generation exactly where the pin resolves them:
            // the mutual exclusion and the finite/non-negative reference
            // refuse here as the pin throws, and the frame-to-time
            // conversion stays in the generated body beside the pinned
            // frame rate it divides by, the way `go_to_frame` already
            // carries it.
            context.expectArgumentCount(call, 1, 2);
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
                "setAnimationAdditive",
                "gltf",
            );
            context.reachFeature("animation:gltf-groups", call);
            context.reachFeature(
                "animation:gltf-additive",
                call,
            );
            // The pin's setter reaches the mixer module and, through the
            // owner, the manager machinery — reaching the intrinsic
            // composes both, the way `enableAnimationBlending` does.
            context.reachFeature(
                "animation:gltf-blending",
                call,
            );
            context.reachFeature(
                "animation:managed-groups",
                call,
            );
            const engine = context.requireEngine(
                group,
                call.arguments[0]!,
            );
            const optionsExpression = call.arguments[1];
            if (!optionsExpression) {
                // `(options?.referenceFrame ?? 0)`: no options means
                // frame zero.
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_animation_additive_from_frame(` +
                        `${engine}, ${group.cpp}, 0.0f)`,
                };
            }
            const options = context.expectObjectLiteral(
                optionsExpression,
            );
            validateObjectProperties(
                context,
                options,
                ["referenceFrame", "referenceTime"],
                "Additive animation options support referenceFrame and referenceTime.",
            );
            const frameExpression = context.objectProperty(
                options,
                "referenceFrame",
            );
            const timeExpression = context.objectProperty(
                options,
                "referenceTime",
            );
            if (frameExpression && timeExpression) {
                context.fail(
                    options,
                    "Additive animation reference must use either referenceFrame or referenceTime, not both — the pinned setter throws on the pair.",
                );
            }
            const selected =
                timeExpression ?? frameExpression;
            const reference = selected
                ? staticNumberValue(context, selected)
                : 0;
            if (reference === undefined) {
                context.fail(
                    selected ?? options,
                    "An additive animation reference resolves at generation: the pinned setter validates it before any frame runs.",
                );
            }
            // The pinned guard is on the reference TIME; a frame divides
            // by the positive pinned frame rate, so its sign and
            // finiteness are the time's.
            if (!Number.isFinite(reference) || reference < 0) {
                context.fail(
                    selected ?? options,
                    `Additive animation reference time must be a finite non-negative number, got ${reference}.`,
                );
            }
            if (timeExpression) {
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_animation_additive(` +
                        `${engine}, ${group.cpp}, ` +
                        `${context.compileNumber(timeExpression)})`,
                };
            }
            return {
                kind: "void",
                cpp:
                    `bbl::set_animation_additive_from_frame(` +
                    `${engine}, ${group.cpp}, ` +
                    `${
                        frameExpression
                            ? context.compileNumber(frameExpression)
                            : "0.0f"
                    })`,
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

        case "createAnimationGroupMask": {
            // src/animation/animation-group-mask.ts: the factory copies the
            // names and defaults the mode to Include. Both arguments are
            // constants in every shape this port can compile -- a module
            // array of string literals and one of the pin's two enum members
            // -- so the mask resolves here and the assignment to
            // `group.mask` is what reaches the runtime. A mask built from
            // computed names would need the pin's own lazy resolver, which
            // re-reads `names` whenever its array reference or length moves.
            context.expectArgumentCount(call, 1, 2);
            const namesExpression = context.resolveStaticExpression(
                call.arguments[0]!,
            );
            if (!ts.isArrayLiteralExpression(namesExpression)) {
                context.fail(
                    call.arguments[0]!,
                    "createAnimationGroupMask takes a static array of " +
                        "target names.",
                );
            }
            const names = namesExpression.elements.map((element) => {
                const resolved = context.resolveStaticExpression(element);
                if (!ts.isStringLiteralLike(resolved)) {
                    context.fail(
                        element,
                        "An animation group mask lists static target names.",
                    );
                }
                return resolved.text;
            });
            const modeExpression = call.arguments[1];
            return {
                kind: "animation-group-mask",
                cpp: "",
                animationGroupMask: {
                    names,
                    include:
                        modeExpression === undefined ||
                        maskModeInclude(context, modeExpression),
                },
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
            const engine = context.requireEngine(scene, call);
            associateManagerEngine(context, manager, engine, call);
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
            context.expectArgumentCount(call, 1, 1);
            const group =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                group,
                "animation-group",
                call.arguments[0]!,
            );
            // A paused property group remains manager-owned and sampled by
            // the weighted mixer; only its time advancement stops. That is
            // the final step in Scene 156's deterministic seek arm.
            if (
                importedName === "pauseAnimation" &&
                group.animationGroupSource === "property"
            ) {
                context.reachFeature("animation:property", call);
                return {
                    kind: "void",
                    cpp: `bbl::pause_animation(${group.cpp})`,
                };
            }
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
            // The pin's third argument is the EngineContext, and its only
            // effect is the guard `engine || !group._stopped ||
            // !group._gltfMixer`: with one, a stopped glTF group is still
            // posed. It is not a value the native call needs -- the engine
            // is already how a group is reached -- so what travels is that
            // the caller passed it.
            context.expectArgumentCount(call, 2, 3);
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
            const engineArgument = call.arguments[2];
            if (engineArgument !== undefined) {
                context.expectKind(
                    context.compileValue(engineArgument),
                    "engine",
                    engineArgument,
                );
            }
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
                        `${group.cpp}, ${frame}, ` +
                        `${engineArgument !== undefined ? "true" : "false"})`,
                };
            }
            if (engineArgument !== undefined) {
                context.fail(
                    engineArgument,
                    "goToFrame on a property-animation group takes no " +
                        "engine argument.",
                );
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
