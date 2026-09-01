// The fullscreen-effect family: `EffectWrapper`, its two draws, and the two
// setters that fill it.
//
// Upstream's `src/effect/effect-renderer.ts` is one shader module (the pin's
// own fullscreen-triangle vertex stage concatenated with the caller's
// fragment), one explicitly declared bind group, and two ways to draw it: an
// `EffectRenderer` that registers on the engine as its own `RenderingContext`
// and owns a swapchain target, and an `EffectRenderTask` scheduled in a
// scene's frame graph against a `RenderTarget` the caller made.
//
// Both halves are compile-time here for the same reason the sprite path is:
// the module text and the bind-group layout are settled by the descriptor, so
// generation composes and deploys them, and what stays at run time is the
// uniform bytes, the bound textures, and the pass.
import ts from "typescript";
import type { EffectBindingManifest, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    compileStaticNumber,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface EffectIntrinsicContext
    extends
        IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    requireDefaultEngine(node: ts.Node): string;
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    unwrap(expression: ts.Expression): ts.Expression;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    cppString(value: string): string;
    compileBoolean(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileStaticString(expression: ts.Expression): string;
    /**
     * Records one descriptor and returns its index in reach order, which is
     * the generated table's index order. Generation composes a module per
     * entry.
     */
    recordEffect(effect: {
        family: "effect" | "uniform-effect";
        name: string;
        fragment: string;
        bindings: EffectBindingManifest[];
    }): number;
    emit(line: string): void;
    fail(node: ts.Node, message: string): never;
}

/** The pin's own align4 on a uniform binding's declared byte length. */
function align4(value: number): number {
    return (value + 3) & ~3;
}

/** `{ r, g, b, a }` as the runtime's own colour, defaulting to opaque black. */
function clearColor(
    context: EffectIntrinsicContext,
    object: ts.ObjectLiteralExpression | undefined,
): string {
    const value = object
        ? context.objectProperty(object, "clearColor")
        : undefined;
    if (!value) return "bbl::Color4{0.0f, 0.0f, 0.0f, 1.0f}";
    const record = context.expectObjectLiteral(value);
    const channel = (name: string, fallback: string): string => {
        const component = context.objectProperty(record, name);
        return component
            ? `static_cast<float>(${context.compileNumber(component)})`
            : fallback;
    };
    return (
        `bbl::Color4{${channel("r", "0.0f")}, ${channel("g", "0.0f")}, ` +
        `${channel("b", "0.0f")}, ${channel("a", "1.0f")}}`
    );
}

/** The pin's `clear` default is true; only an explicit false turns it off. */
function clearFlag(
    context: EffectIntrinsicContext,
    object: ts.ObjectLiteralExpression | undefined,
): string {
    const value = object
        ? context.objectProperty(object, "clear")
        : undefined;
    return value ? context.compileBoolean(value) : "true";
}

/**
 * The `bindings` array, read as the pin reads it: sorted by binding number,
 * duplicates refused, and each sampler resolved to the texture it pairs with.
 */
function compileBindings(
    context: EffectIntrinsicContext,
    object: ts.ObjectLiteralExpression,
): EffectBindingManifest[] {
    const value = context.objectProperty(object, "bindings");
    if (!value) return [];
    const unwrapped = context.unwrap(value);
    if (!ts.isArrayLiteralExpression(unwrapped)) {
        context.fail(
            value,
            "createEffectWrapper 'bindings' is an array literal.",
        );
    }
    const bindings: EffectBindingManifest[] = [];
    // Only a sampler has a second pass to run, so only a sampler carries the
    // two nodes that pass needs.
    const samplers: Array<{
        entry: ts.ObjectLiteralExpression;
        reference: ts.Expression | undefined;
        manifest: EffectBindingManifest;
    }> = [];
    for (const element of unwrapped.elements) {
        const entry = context.expectObjectLiteral(element);
        validateObjectProperties(
            context,
            entry,
            ["name", "binding", "kind", "uniformByteLength", "textureBinding"],
            "Reached effect bindings declare name, binding, kind, " +
                "uniformByteLength and textureBinding; visibility, " +
                "textureSampleType, viewDimension and samplerType are not " +
                "lowered.",
        );
        const bindingExpression = context.objectProperty(entry, "binding");
        const kindExpression = context.objectProperty(entry, "kind");
        if (!bindingExpression || !kindExpression) {
            context.fail(
                entry,
                "An effect binding declares 'binding' and 'kind'.",
            );
        }
        const kind = context.compileStaticString(kindExpression);
        if (kind !== "uniform" && kind !== "texture" && kind !== "sampler") {
            context.fail(
                kindExpression,
                "An effect binding is a uniform, a texture, or a sampler.",
            );
        }
        const nameExpression = context.objectProperty(entry, "name");
        const uniformExpression = context.objectProperty(
            entry,
            "uniformByteLength",
        );
        const binding = compileStaticNumber(
            context,
            bindingExpression,
            "an effect binding number",
        );
        if (!Number.isInteger(binding) || binding < 0) {
            context.fail(
                bindingExpression,
                "An effect binding number is a non-negative integer literal.",
            );
        }
        if (bindings.some((existing) => existing.binding === binding)) {
            context.fail(
                bindingExpression,
                `createEffectWrapper: duplicate binding ${binding}.`,
            );
        }
        const manifest: EffectBindingManifest = {
            name: nameExpression
                ? context.compileStaticString(nameExpression)
                : "",
            binding,
            kind,
            // The pin aligns a uniform binding's declared length to four and
            // defaults it to sixteen; both live in `createBindingSlots`.
            uniformBytes: kind === "uniform"
                ? align4(
                    uniformExpression
                        ? compileStaticNumber(
                            context,
                            uniformExpression,
                            "an effect uniform byte length",
                        )
                        : 16,
                )
                : 0,
            texture: -1,
        };
        bindings.push(manifest);
        if (kind === "sampler") {
            samplers.push({
                entry,
                reference: context.objectProperty(entry, "textureBinding"),
                manifest,
            });
        }
    }
    bindings.sort((left, right) => left.binding - right.binding);
    const textures = bindings.filter(
        (manifest) => manifest.kind === "texture",
    );
    for (const { entry, reference, manifest } of samplers) {
        // The pin's own resolution: the texture `textureBinding` identifies
        // when the descriptor supplies one, the first texture slot otherwise.
        // `matchesBinding` accepts either the slot's name or its index
        // printed as a string, which is why a reference is read either way.
        const named = reference ? context.unwrap(reference) : undefined;
        const match = !named
            ? textures[0]
            : ts.isStringLiteral(named)
                ? textures.find(
                    (texture) =>
                        texture.name === named.text ||
                        String(texture.binding) === named.text,
                )
                : textures.find(
                    (texture) =>
                        texture.binding ===
                            compileStaticNumber(
                                context,
                                named,
                                "an effect sampler's textureBinding",
                            ),
                );
        if (!match) {
            context.fail(
                reference ?? entry,
                `Effect sampler binding ${manifest.binding} names a texture ` +
                    "binding the descriptor does not declare, and there is " +
                    "no texture slot to fall back to.",
            );
        }
        // The ORDINAL, not the binding number: a PAL holds its uploaded
        // textures in the order this list gives them, so resolving to a
        // position here is what saves both backends a rescan at draw time.
        manifest.texture = textures.indexOf(match);
    }
    return bindings;
}

export function compileEffectIntrinsic(
    context: EffectIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createUniformEffectWrapper": {
            context.expectArgumentCount(call, 2, 2);
            const engine = context.requireEngine(
                context.compileValue(call.arguments[0]!),
                call,
            );
            const object = context.expectObjectLiteral(call.arguments[1]!);
            validateObjectProperties(
                context,
                object,
                ["name", "fragmentWGSL", "uniformByteLength"],
                "A uniform effect wrapper takes a name, fragmentWGSL, and uniformByteLength; a custom vertexWGSL is not lowered.",
            );
            const fragmentExpression = context.objectProperty(
                object,
                "fragmentWGSL",
            );
            const byteLengthExpression = context.objectProperty(
                object,
                "uniformByteLength",
            );
            if (!fragmentExpression || !byteLengthExpression) {
                context.fail(
                    object,
                    "createUniformEffectWrapper requires fragmentWGSL and uniformByteLength.",
                );
            }
            const fragment = context.compileStaticString(fragmentExpression);
            if (fragment.trim().length === 0) {
                context.fail(
                    fragmentExpression,
                    "createUniformEffectWrapper requires non-empty WGSL.",
                );
            }
            const uniformBytes = align4(
                compileStaticNumber(
                    context,
                    byteLengthExpression,
                    "a uniform effect byte length",
                ),
            );
            if (uniformBytes <= 0) {
                context.fail(
                    byteLengthExpression,
                    "A uniform effect byte length must be positive.",
                );
            }
            const nameExpression = context.objectProperty(object, "name");
            const index = context.recordEffect({
                family: "uniform-effect",
                name: nameExpression
                    ? context.compileStaticString(nameExpression)
                    : "uniform-effect-wrapper",
                fragment,
                bindings: [{
                    name: "",
                    binding: 0,
                    kind: "uniform",
                    uniformBytes,
                    texture: -1,
                }],
            });
            context.reachFeature("effect:wrapper", call);
            return {
                kind: "effect-wrapper",
                cpp: `bbl::create_effect_wrapper(${engine}, ${index}u)`,
                engineCpp: engine,
            };
        }

        case "createEffectWrapper": {
            context.expectArgumentCount(call, 2, 2);
            const engine = context.requireEngine(
                context.compileValue(call.arguments[0]!),
                call,
            );
            const object = context.expectObjectLiteral(call.arguments[1]!);
            validateObjectProperties(
                context,
                object,
                ["name", "fragmentWGSL", "bindings"],
                "Reached effect wrappers take a name, a fragmentWGSL body " +
                    "and bindings; a custom vertexWGSL and a blend state are " +
                    "not lowered.",
            );
            const fragmentExpression = context.objectProperty(
                object,
                "fragmentWGSL",
            );
            if (!fragmentExpression) {
                context.fail(
                    object,
                    "createEffectWrapper requires 'fragmentWGSL'.",
                );
            }
            const fragment = context.compileStaticString(fragmentExpression);
            if (fragment.trim().length === 0) {
                context.fail(
                    fragmentExpression,
                    "createEffectWrapper: 'fragmentWGSL' must be a " +
                        "non-empty WGSL string.",
                );
            }
            const nameExpression = context.objectProperty(object, "name");
            const index = context.recordEffect({
                family: "effect",
                // The pin's own default when the descriptor names none.
                name: nameExpression
                    ? context.compileStaticString(nameExpression)
                    : "effect-wrapper",
                fragment,
                bindings: compileBindings(context, object),
            });
            context.reachFeature("effect:wrapper", call);
            return {
                kind: "effect-wrapper",
                cpp: `bbl::create_effect_wrapper(${engine}, ${index}u)`,
                engineCpp: engine,
            };
        }

        case "setUniformEffectUniforms":
        case "setEffectUniforms": {
            // The reached form is the pin's single-payload arm, which writes
            // the wrapper's first uniform slot. The record arm keys by
            // binding name or index and no reached scene writes one.
            context.expectArgumentCount(call, 2, 2);
            const wrapper = context.compileValue(call.arguments[0]!);
            context.expectKind(
                wrapper,
                "effect-wrapper",
                call.arguments[0]!,
            );
            const data = context.compileValue(call.arguments[1]!);
            if (data.kind !== "data" || data.dataType?.kind !== "f32array") {
                context.fail(
                    call.arguments[1]!,
                    "Reached effect uniforms come from a Float32Array; the " +
                        "per-binding record form is not lowered.",
                );
            }
            return {
                kind: "void",
                cpp:
                    `bbl::set_effect_uniforms(` +
                    `${context.requireEngine(wrapper, call)}, ` +
                    `${wrapper.cpp}, ${data.cpp})`,
            };
        }

        case "setEffectTexture": {
            context.expectArgumentCount(call, 3, 3);
            const wrapper = context.compileValue(call.arguments[0]!);
            context.expectKind(
                wrapper,
                "effect-wrapper",
                call.arguments[0]!,
            );
            const name = context.compileStaticString(call.arguments[1]!);
            const texture = context.compileValue(call.arguments[2]!);
            context.expectKind(texture, "texture", call.arguments[2]!);
            if (texture.textureFile) {
                context.fail(
                    call.arguments[2]!,
                    "Reached effect textures come from createSolidTexture2D.",
                );
            }
            context.expectSameEngine(wrapper, texture, call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_effect_texture(` +
                    `${context.requireEngine(wrapper, call)}, ` +
                    `${wrapper.cpp}, ${context.cppString(name)}, ` +
                    `${texture.cpp})`,
            };
        }

        case "createEffectRenderer": {
            context.expectArgumentCount(call, 2, 3);
            const surface = context.compileValue(call.arguments[0]!);
            context.expectKind(surface, "engine", call.arguments[0]!);
            const wrapper = context.compileValue(call.arguments[1]!);
            context.expectKind(
                wrapper,
                "effect-wrapper",
                call.arguments[1]!,
            );
            const object = call.arguments[2]
                ? context.expectObjectLiteral(call.arguments[2])
                : undefined;
            if (object) {
                validateObjectProperties(
                    context,
                    object,
                    ["name", "clear", "clearColor"],
                    "Reached effect renderers take a name and clear state; " +
                        "the per-frame 'update' callback is not lowered.",
                );
            }
            context.reachFeature("effect:wrapper", call);
            context.reachFeature("renderer:effect", call);
            return {
                kind: "effect-renderer",
                cpp:
                    `bbl::create_effect_renderer(${surface.cpp}, ` +
                    `${wrapper.cpp}, bbl::EffectRendererOptions{` +
                    `${clearFlag(context, object)}, ` +
                    `${clearColor(context, object)}})`,
                engineCpp: surface.engineCpp ?? surface.cpp,
            };
        }

        case "registerEffectRenderer": {
            context.expectArgumentCount(call, 1, 1);
            const renderer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                renderer,
                "effect-renderer",
                call.arguments[0]!,
            );
            context.reachFeature("renderer:effect", call);
            return {
                kind: "void",
                cpp: `bbl::register_effect_renderer(${
                    renderer.engineCpp ?? context.requireDefaultEngine(call)
                }, ${renderer.cpp})`,
            };
        }

        case "createUniformEffectRenderTask":
        case "createEffectRenderTask": {
            context.expectArgumentCount(call, 2, 3);
            const object = context.expectObjectLiteral(call.arguments[0]!);
            validateObjectProperties(
                context,
                object,
                ["name", "effect", "target", "clear", "clearColor"],
                "An effect render task takes a name, an effect, a target " +
                    "and clear state.",
            );
            const engine = context.requireEngine(
                context.compileValue(call.arguments[1]!),
                call,
            );
            const scene = call.arguments[2]
                ? context.compileValue(call.arguments[2])
                : undefined;
            if (scene) {
                context.expectKind(scene, "scene", call.arguments[2]!);
            }
            const nameExpression = context.objectProperty(object, "name");
            const effectExpression = context.objectProperty(object, "effect");
            const targetExpression = context.objectProperty(object, "target");
            if (!nameExpression || !effectExpression || !targetExpression) {
                context.fail(
                    object,
                    "An effect render task declares 'name', 'effect' and " +
                        "'target'.",
                );
            }
            const wrapper = context.compileValue(effectExpression);
            context.expectKind(wrapper, "effect-wrapper", effectExpression);
            if (scene) {
                context.expectSameEngine(wrapper, scene, call);
            }
            const target = context.compileValue(targetExpression);
            context.expectKind(target, "render-target", targetExpression);
            context.reachFeature("effect:wrapper", call);
            context.reachFeature("effect:task", call);
            context.reachFeature(
                scene ? "renderer:scene" : "renderer:frame-graph",
                call,
            );
            return {
                kind: "task",
                cpp:
                    `bbl::create_effect_render_task(${engine}, ` +
                    `bbl::EffectTaskOptions{` +
                    `${context.cppString(
                        context.compileStaticString(nameExpression),
                    )}, ${wrapper.cpp}, ${target.cpp}, ` +
                    `${clearFlag(context, object)}, ` +
                    `${clearColor(context, object)}})`,
                engineCpp: engine,
            };
        }

        default:
            return undefined;
    }
}
