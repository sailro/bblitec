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
import { handleCppType } from "../data-types.js";
import {
    pinnedOptionKind,
    pinnedOptionNames,
    type PinnedFactory,
    type PinnedOptionKind,
} from "./pinned-options.js";
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
    Value,
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
    let camera = `${handleCppType("camera")}{}`;
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
    sourceTasks: readonly Value[];
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
    if (!source.renderTargetSignature || source.renderTargetSignature.samples !== 1) {
        context.noteTemporalRecordBoundary(sourceExpression,
            "TAA post-process sampling requires a proven single-sample source texture as required by the pinned GPU state", "always");
    }

    const target = optionalRenderTarget(context, object, "targetTexture");

    const sourceTasks = (composite.sourceTasks ?? []).map((option) => {
        const expression = context.objectProperty(object, option);
        if (!expression) context.fail(object, `${intrinsic} requires '${option}'.`);
        const value = context.compileValue(expression);
        context.expectKind(value, "task", expression);
        if (!value.renderTask) {
            context.fail(expression, `${intrinsic} '${option}' requires a proven scene render task.`);
        }
        context.expectSameEngine(source, value, expression);
        return value;
    });

    const extraTextures = composite.extraTextures.map((option) =>
        compileTextureReference(context, object, option, "color"),
    );

    let camera = `${handleCppType("camera")}{}`;
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
        [...COMPOSITE_PASS_SETTINGS, ...(composite.sourceTasks ?? [])],
    );
    return {
        cpp:
            `bbl::PostProcessCompositeInputs{${context.cppString(name)}, ` +
            `${source.cpp}, {${extraTextures.join(", ")}}, ${target.cpp}, ` +
            `${camera}, {${sourceTasks.map((task) => task.cpp).join(", ")}}}`,
        sourceTasks,
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
    handledSettings: readonly string[],
): Record<string, PostProcessOptionValue> {
    const handled = new Set([
        ...handledSettings,
        ...effect.extraTextures,
        ...(effect.usesCamera ? ["camera"] : []),
    ]);
    return compileDescriptorOptions(
        context,
        object,
        { module: effect.module, factory: effect.intrinsic },
        handled,
    );
}

/**
 * Every named property of a task descriptor the caller did not read
 * itself, statically resolved: the settings a pinned factory receives
 * whole. Each is compiled as the shape the factory's config interface
 * declares for it, and a key the config does not declare is refused by
 * name — the factory would take its default for it silently. A computed
 * or spread member has no name to forward under and is refused.
 */
export function compileDescriptorOptions(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    factory: PinnedFactory,
    handled: ReadonlySet<string>,
): Record<string, PostProcessOptionValue> {
    const options: Record<string, PostProcessOptionValue> = {};
    for (const property of object.properties) {
        const named = ts.isPropertyAssignment(property)
            ? { key: context.propertyName(property.name), value: property.initializer }
            : ts.isShorthandPropertyAssignment(property)
              ? { key: context.propertyName(property.name), value: property.name }
              : undefined;
        if (!named || named.key === undefined) {
            context.fail(
                property,
                "Reached task descriptors support named properties only.",
            );
        }
        const key = named.key;
        const value = named.value;
        if (handled.has(key)) continue;
        const kind = pinnedOptionKind(factory, key);
        if (!kind) {
            context.fail(
                property,
                `${factory.factory} does not declare option '${key}'; its ` +
                    `config declares [${pinnedOptionNames(factory).join(", ")}].`,
            );
        }
        options[key] = compileOptionValue(
            context,
            value,
            `${factory.factory} option '${key}'`,
            kind,
        );
    }
    return options;
}

/**
 * One parameter slot, from the forwarded options or the pin's fallback.
 *
 * The vector is numeric whatever the pinned type is: a flag travels as 0 or
 * 1 and the effect's own lowered writer spends it through the conditional
 * the pin wrote. What the row's default settles is which type the scene may
 * write, so a number handed to a flag is refused rather than stored.
 */
function paramValue(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    options: Readonly<Record<string, PostProcessOptionValue>>,
    slot: PostProcessEffect["params"][number],
): number {
    if (slot.runtime) {
        return Number(slot.fallback);
    }
    const { option, component } = slotOption(slot);
    const value = options[option];
    if (value === undefined) {
        return Number(slot.fallback);
    }
    if (!component) {
        if (typeof value !== typeof slot.fallback) {
            context.fail(
                object,
                `Post-process '${option}' must be a ${typeof slot.fallback}.`,
            );
        }
        return Number(value);
    }
    if (typeof value !== "object" || !(component in value)) {
        context.fail(object, `Post-process '${option}' must be a vector.`);
    }
    return (value as { x: number; y: number })[component];
}

/**
 * One effect option, as the pin's own factory would receive it: a number, a
 * boolean, a string, the `{x, y}` pair its vector options are written as,
 * the four-field normalized viewport a composite forwards to its last pass,
 * a numeric triple, or a member of one of the pin's enums.
 *
 * Which of those the option IS comes from the pin's config interface
 * (`pinnedOptionKind`), never from the literal's shape: a viewport read as
 * the vector its first two fields spell would cover the whole target
 * instead of the half the scene asked for, with nothing said, so a literal
 * that does not spell the declared shape is refused by name.
 */
function compileOptionValue(
    context: EngineOptionContext,
    expression: ts.Expression,
    label: string,
    kind: PinnedOptionKind,
): PostProcessOptionValue {
    const unwrapped = context.unwrap(expression);
    switch (kind.kind) {
        case "triple": {
            // The contact shadows' `tint`: a numeric array forwarded whole.
            if (!ts.isArrayLiteralExpression(unwrapped)) {
                context.fail(unwrapped, `${label} is a numeric triple.`);
            }
            return unwrapped.elements.map((element) =>
                compileStaticNumber(context, element, label),
            );
        }
        case "vector":
        case "viewport": {
            const fields =
                kind.kind === "vector"
                    ? ["x", "y"]
                    : ["x", "y", "width", "height"];
            const spelled = fields.map((field) => `'${field}'`).join(", ");
            if (
                !ts.isObjectLiteralExpression(unwrapped) ||
                unwrapped.properties.length !== fields.length
            ) {
                context.fail(
                    unwrapped,
                    `${label} names a ${kind.kind}, which is exactly ${spelled}.`,
                );
            }
            const component = (field: string): number => {
                const value = context.objectProperty(unwrapped, field);
                if (!value) {
                    context.fail(unwrapped, `${label} is missing '${field}'.`);
                }
                return compileStaticNumber(context, value, label);
            };
            return kind.kind === "vector"
                ? { x: component("x"), y: component("y") }
                : {
                      x: component("x"),
                      y: component("y"),
                      width: component("width"),
                      height: component("height"),
                  };
        }
        case "boolean":
            if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
            if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
            return context.fail(unwrapped, `${label} is a boolean.`);
        case "string":
            // A composite forwards its own pass settings to the pass it ends
            // on, and `sourceSamplingMode` is a string among them. It reaches
            // the factory unread: which of its options the composed text
            // branches on is the pin's question, not this table's. The
            // evaluator resolves a bound constant and a concatenation too,
            // which is what every other string this file reads goes through.
            return context.compileStringLiteral(unwrapped);
        case "enum": {
            // `DepthOfFieldBlurLevel.High`: an enum the scene imported from
            // Babylon Lite, whose value the pinned module decides at
            // composition.
            const access = ts.isPropertyAccessExpression(unwrapped)
                ? unwrapped
                : undefined;
            const owner =
                access && ts.isIdentifier(access.expression)
                    ? access.expression
                    : undefined;
            const imported = owner
                ? context.symbols.importedName(owner)
                : undefined;
            if (!access || imported !== kind.name) {
                context.fail(
                    unwrapped,
                    `${label} is a member of the pin's ${kind.name}.`,
                );
            }
            return { pinnedEnum: imported, member: access.name.text };
        }
        case "number":
            return compileStaticNumber(context, unwrapped, label);
    }
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
