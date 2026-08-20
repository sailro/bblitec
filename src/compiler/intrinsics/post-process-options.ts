// Post-process pass option lowering.
//
// Every effect Babylon Lite ships calls one `createPostProcessTask` with the
// same settings — a source texture, an optional target, a sampling mode, an
// alpha mode, a viewport and a clear flag — plus its own `_shader` record. So
// this compiles the shared half once, reads the record half out of
// `POST_PROCESS_EFFECTS`, and forwards every remaining option to the pin's own
// factory rather than deciding which of them its text reads. A property that
// does not resolve statically is refused; one that does reaches the composer,
// so an option the pin starts branching on needs no compiler change.
import ts from "typescript";
import {
    COMPOSITE_PASS_SETTINGS,
    POST_PROCESS_PASS_SETTINGS,
    postProcessComposite,
    postProcessEffect,
    slotOption,
    type PostProcessComposite,
    type PostProcessEffect,
} from "../../post-process-effects.js";
import { doubleLiteral } from "../../cpp-literals.js";
import { compileStaticNumber } from "../option-helpers.js";
import type {
    PostProcessCompositeManifest,
    PostProcessOptionValue,
    PostProcessTaskManifest,
} from "../types.js";
import {
    compileTextureReference,
    optionalRenderTarget,
    requiredObjectNumber,
    type EngineOptionContext,
} from "./engine-options.js";

export interface CompiledPostProcessTask {
    cpp: string;
    manifest: PostProcessTaskManifest;
}

export function compilePostProcessTaskOptions(
    context: EngineOptionContext,
    intrinsic: string,
    expression: ts.Expression,
    shaderIndex: number,
): CompiledPostProcessTask {
    const effect = postProcessEffect(intrinsic);
    if (!effect) {
        context.fail(
            expression,
            `Post-process effect '${intrinsic}' has no reached descriptor.`,
        );
    }
    const object = context.expectObjectLiteral(expression);
    const nameExpression = context.objectProperty(object, "name");
    const name = nameExpression
        ? context.compileStringLiteral(nameExpression)
        : defaultTaskName(effect);

    // Every texture a pass binds — the source and each of the effect's own —
    // is a sampled `texture_2d<f32>` in the composed WGSL, depth values
    // included: the pin reads those out of a geometry task's colour output.
    const source = compileTextureReference(
        context,
        object,
        "sourceTexture",
        "color",
    );
    const target = optionalRenderTarget(context, object, "targetTexture");

    const samplingExpression = context.objectProperty(
        object,
        "sourceSamplingMode",
    );
    let sampling = "bbl::PostProcessSampling::linear";
    if (samplingExpression) {
        const mode = context.compileStringLiteral(samplingExpression);
        if (mode !== "nearest" && mode !== "linear") {
            context.fail(
                samplingExpression,
                `Post-process sourceSamplingMode must be 'nearest' or 'linear', received '${mode}'.`,
            );
        }
        sampling = `bbl::PostProcessSampling::${mode}`;
    }

    const alphaExpression = context.objectProperty(object, "alphaMode");
    const alphaMode = alphaExpression
        ? compileStaticNumber(
              context,
              alphaExpression,
              "Post-process alphaMode",
          )
        : 0;

    const viewportExpression = context.objectProperty(object, "viewport");
    let viewport = "bbl::NormalizedViewport{}";
    if (viewportExpression) {
        const viewportObject =
            context.expectObjectLiteral(viewportExpression);
        const component = (field: string): string =>
            requiredObjectNumber(context, viewportObject, field, "double");
        viewport = `bbl::NormalizedViewport{${component("x")}, ${component(
            "y",
        )}, ${component("width")}, ${component("height")}}`;
    }

    const clearExpression = context.objectProperty(object, "clear");
    const clear = clearExpression
        ? context.compileBoolean(clearExpression)
        : "true";

    const extraTextures = effect.extraTextures.map((option) =>
        compileTextureReference(context, object, option, "color"),
    );

    const cameraExpression = context.objectProperty(object, "camera");
    let camera = "bbl::CameraHandle{}";
    if (effect.usesCamera) {
        if (!cameraExpression) {
            context.fail(object, `${intrinsic} requires a camera.`);
        }
        const value = context.compileValue(cameraExpression);
        context.expectKind(value, "camera", cameraExpression);
        camera = value.cpp;
    }

    const options = compileEffectOptions(
        context,
        object,
        effect,
        intrinsic,
        POST_PROCESS_PASS_SETTINGS,
    );
    const params = effect.params.map((slot) =>
        paramValue(context, object, options, slot),
    );

    return {
        // One pass, in the list a task records: the composites put several
        // there and the caller sees the same task either way.
        cpp:
            `bbl::PostProcessTaskOptions{${context.cppString(name)}, ` +
            `{bbl::PostProcessPassOptions{${context.cppString(name)}, ` +
            `${shaderIndex}u, ${source}, ${target.cpp}, ${sampling}, ` +
            `${alphaMode}u, ${viewportExpression ? "true" : "false"}, ` +
            `${viewport}, ${clear}, {${extraTextures.join(", ")}}, ` +
            `${camera}, {${params
                .map((value) => doubleLiteral(value))
                .join(", ")}}}}}`,
        manifest: { shaderIndex, intrinsic: effect.intrinsic, options },
    };
}

export interface CompiledPostProcessComposite {
    cpp: string;
    manifest: PostProcessCompositeManifest;
}

/**
 * A composite pass, as the inputs its generated factory takes.
 *
 * What the composite does with them — how many passes, over which
 * intermediates, at which sizes — is decided by running the pin's own factory
 * at generation, so nothing about the chain is compiled here. What is compiled
 * is only what the chain reads from the scene: the textures it samples, the
 * target it writes, and the camera its lens model reads.
 *
 * The source must be a render target rather than any render texture, because
 * the composite sizes its own intermediates from it and reads its format. The
 * pin refuses a source without one for the same reason.
 */
export function compilePostProcessCompositeOptions(
    context: EngineOptionContext,
    intrinsic: string,
    expression: ts.Expression,
    compositeIndex: number,
): CompiledPostProcessComposite {
    const composite = postProcessComposite(intrinsic);
    if (!composite) {
        context.fail(
            expression,
            `Post-process composite '${intrinsic}' has no reached descriptor.`,
        );
    }
    const object = context.expectObjectLiteral(expression);
    const nameExpression = context.objectProperty(object, "name");
    const name = nameExpression
        ? context.compileStringLiteral(nameExpression)
        : defaultTaskName(composite);

    const sourceExpression = context.objectProperty(object, "sourceTexture");
    if (!sourceExpression) {
        context.fail(object, `${intrinsic} requires a sourceTexture.`);
    }
    const source = context.compileValue(sourceExpression);
    context.expectKind(source, "render-target", sourceExpression);

    const target = optionalRenderTarget(context, object, "targetTexture");

    const extraTextures = composite.extraTextures.map((option) =>
        compileTextureReference(context, object, option, "color"),
    );

    let camera = "bbl::CameraHandle{}";
    if (composite.usesCamera) {
        const cameraExpression = context.objectProperty(object, "camera");
        if (!cameraExpression) {
            context.fail(object, `${intrinsic} requires a camera.`);
        }
        const value = context.compileValue(cameraExpression);
        context.expectKind(value, "camera", cameraExpression);
        camera = value.cpp;
    }

    // A composite reads the pass settings itself and forwards them to the
    // pass it ends on, so they are its options rather than the framework's:
    // only the name and the textures are consumed here. A `clear: false` that
    // stopped at this boundary would compose the pin's default instead.
    const options = compileEffectOptions(
        context,
        object,
        composite,
        intrinsic,
        COMPOSITE_PASS_SETTINGS,
    );
    return {
        cpp:
            `bbl::PostProcessCompositeInputs{${context.cppString(name)}, ` +
            `${source.cpp}, {${extraTextures.join(", ")}}, ${target.cpp}, ` +
            `${camera}}`,
        manifest: {
            compositeIndex,
            intrinsic,
            options,
            hasTarget: target.value !== undefined,
        },
    };
}

/** Everything on the descriptor the pass itself does not read. */
function compileEffectOptions(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    effect: PostProcessEffect | PostProcessComposite,
    intrinsic: string,
    handledSettings: readonly string[],
): Record<string, PostProcessOptionValue> {
    const handled = new Set([
        ...handledSettings,
        ...effect.extraTextures,
        ...(effect.usesCamera ? ["camera"] : []),
    ]);
    const options: Record<string, PostProcessOptionValue> = {};
    for (const property of object.properties) {
        const key =
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
                ? context.propertyName(property.name)
                : undefined;
        if (!key) {
            context.fail(
                property,
                "Reached post-process descriptors support named properties only.",
            );
        }
        if (handled.has(key)) continue;
        options[key] = compileOptionValue(
            context,
            context.objectProperty(object, key)!,
            `${intrinsic} option '${key}'`,
        );
    }
    return options;
}

/** One parameter slot, from the forwarded options or the pin's fallback. */
function paramValue(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    options: Readonly<Record<string, PostProcessOptionValue>>,
    slot: PostProcessEffect["params"][number],
): number {
    if (slot.runtime) {
        return slot.fallback;
    }
    const { option, component } = slotOption(slot);
    const value = options[option];
    if (value === undefined) {
        return slot.fallback;
    }
    if (!component) {
        if (typeof value !== "number") {
            context.fail(
                object,
                `Post-process '${option}' must be a number.`,
            );
        }
        return value;
    }
    if (typeof value !== "object" || !(component in value)) {
        context.fail(object, `Post-process '${option}' must be a vector.`);
    }
    return (value as { x: number; y: number })[component];
}

/**
 * One effect option, as the pin's own factory would receive it: a number, a
 * boolean, or the `{x, y}` pair its vector options are written as.
 */
function compileOptionValue(
    context: EngineOptionContext,
    expression: ts.Expression,
    label: string,
): PostProcessOptionValue {
    const unwrapped = context.unwrap(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
        const component = (field: string): number => {
            const value = context.objectProperty(unwrapped, field);
            if (!value) {
                context.fail(unwrapped, `${label} is missing '${field}'.`);
            }
            return compileStaticNumber(context, value, label);
        };
        return { x: component("x"), y: component("y") };
    }
    if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
    // `DepthOfFieldBlurLevel.High`: an enum the scene imported from Babylon
    // Lite, whose value the pinned module decides at composition.
    if (
        ts.isPropertyAccessExpression(unwrapped) &&
        ts.isIdentifier(unwrapped.expression)
    ) {
        const imported = context.symbols.importedName(unwrapped.expression);
        if (imported) {
            return { pinnedEnum: imported, member: unwrapped.name.text };
        }
    }
    return compileStaticNumber(context, unwrapped, label);
}

/**
 * The pin's own default name for a pass, which is the effect's own kebab-case
 * label: `config.name ?? "blur"`. Derived from the entry point rather than
 * listed, so a renamed factory renames its passes with it.
 */
function defaultTaskName(
    effect: Pick<PostProcessEffect, "intrinsic">,
): string {
    return effect.intrinsic
        .replace(/^create/, "")
        .replace(/PostProcessTask$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase();
}
