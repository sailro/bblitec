// Frame-graph option lowering: render targets, render/geometry/copy
// tasks, and the scene's default-render-task flag.
//
// Each function turns a task factory's options argument into the
// C++ options struct literal the PAL executes, and the geometry task
// also returns the manifest entry the generated shader table indexes
// by reach order. The intrinsic lowerer in engine.ts calls these
// through its context.
import ts from "typescript";
import type { CompilerSymbols } from "../symbols.js";
import type {
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    Value,
    ValueKind,
} from "../types.js";
import {
    compilePositiveInteger,
    compileStaticNumber,
    validateObjectProperties,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface EngineOptionContext
    extends PositiveIntegerContext {
    readonly symbols: CompilerSymbols;
    readonly geometryOutputTasks: readonly GeometryOutputTaskManifest[];
    unwrap(expression: ts.Expression): ts.Expression;
    propertyName(name: ts.PropertyName): string | undefined;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    cppString(value: string): string;
}

/**
 * A compiled render-target descriptor, and the one fact about it a caller
 * needs back: whether it declared a colour attachment. `rtt.ts` forks on
 * exactly that -- `if (!rt._colorTexture || !rt._colorView)` -- so the
 * texture the target hands a sampler is a colour one when it did and a
 * depth one when it did not. Reported rather than re-derived downstream.
 */
export interface CompiledRenderTargetOptions {
    cpp: string;
    hasColor: boolean;
}

export function compileRenderTargetOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): CompiledRenderTargetOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["lbl", "format", "dFormat", "samples", "size"],
        "Reached render targets support lbl, format, dFormat, samples, and size.",
    );
    const samples = context.objectProperty(object, "samples");
    const colorFormat = context.objectProperty(object, "format");
    const depthFormat = context.objectProperty(object, "dFormat");
    const size = context.objectProperty(object, "size");
    let width = "0u";
    let height = "0u";
    if (size) {
        const unwrappedSize = context.unwrap(size);
        if (ts.isObjectLiteralExpression(unwrappedSize)) {
            const widthExpression = context.objectProperty(
                unwrappedSize,
                "width",
            );
            const heightExpression = context.objectProperty(
                unwrappedSize,
                "height",
            );
            if (!widthExpression || !heightExpression) {
                context.fail(
                    unwrappedSize,
                    "Fixed render target size requires width and height.",
                );
            }
            width = compilePositiveInteger(context, widthExpression);
            height = compilePositiveInteger(context, heightExpression);
        } else {
            const surface = context.compileValue(unwrappedSize);
            context.expectKind(surface, "engine", unwrappedSize);
        }
    }
    return {
        cpp: `bbl::RenderTargetOptions{${samples ? compilePositiveInteger(context, samples) : "1u"}, ${colorFormat ? "true" : "false"}, ${depthFormat ? "true" : "false"}, false, ${width}, ${height}}`,
        hasColor: colorFormat !== undefined,
    };
}

export function compileRenderTaskOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): string {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["name", "rt", "rst", "clrColor", "clr", "cam", "cs", "autoMirror", "depth"],
        "Reached render tasks support name, rt, rst, clrColor, clr, cam, cs, autoMirror, and depth.",
    );
    const nameExpression = context.objectProperty(object, "name");
    const targetExpression = context.objectProperty(object, "rt");
    if (!targetExpression) {
        context.fail(object, "Render task requires an rt render target.");
    }
    const target = context.compileValue(targetExpression);
    context.expectKind(target, "render-target", targetExpression);
    // The single-sample target an MSAA colour attachment resolves into. The
    // pin ignores it when `rt` is single-sample rather than refusing it, so
    // this carries the handle and lets the backend apply the same rule.
    const resolve = optionalRenderTarget(context, object, "rst");
    if (resolve.value) {
        context.expectSameEngine(target, resolve.value, object);
    }
    const clearColor = context.objectProperty(object, "clrColor");
    const clear = context.objectProperty(object, "clr");
    const cameraExpression = context.objectProperty(object, "cam");
    const camera = cameraExpression
        ? context.compileValue(cameraExpression)
        : undefined;
    if (camera && cameraExpression) {
        context.expectKind(camera, "camera", cameraExpression);
        context.expectSameEngine(target, camera, object);
    }
    const canvasSize = context.objectProperty(object, "cs");
    const autoMirror = context.objectProperty(object, "autoMirror");
    // An external depth attachment: the pin binds that target's depth view
    // instead of the task target's own, and loads it because a geometry
    // task's output is eager. Which attachment a target hands a SAMPLER is
    // a separate question, answered by the format it declared -- see
    // `CompiledRenderTargetOptions`.
    const depthExpression = context.objectProperty(object, "depth");
    let depth = "bbl::RenderTextureRef{}";
    if (depthExpression) {
        // The SOURCE decides, not the aspect: a render target that declared
        // no colour format also samples as depth, but the pin's eager
        // wrapper is what this binds and loads, so only a geometry task's
        // own depth may fill it.
        depth = compileRenderTextureValue(
            context,
            depthExpression,
            context.compileValue(depthExpression),
            "Render task depth",
            { sources: ["geometry-depth"] },
        );
    }
    return `bbl::RenderTaskOptions{${context.cppString(
        nameExpression ? context.compileStringLiteral(nameExpression) : "render-task",
    )}, ${target.cpp}, ${clearColor ? context.compileColor4(clearColor) : "bbl::Color4{}"}, ${clear ? context.compileBoolean(clear) : "true"}, ${camera?.cpp ?? "bbl::CameraHandle{}"}, ${camera ? "true" : "false"}, ${canvasSize ? context.compileBoolean(canvasSize) : "false"}, ${autoMirror ? context.compileBoolean(autoMirror) : "true"}, ${depth}, ${resolve.cpp}}`;
}

export function compileGeometryTaskOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): {
    cpp: string;
    manifest: GeometryOutputTaskManifest;
} {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "name",
            "samples",
            "textureDescriptions",
            "targetTexture",
            "targetTextureClearColor",
        ],
        "Reached geometry renderer tasks support name, samples, textureDescriptions, targetTexture, and targetTextureClearColor.",
    );
    const nameExpression = context.objectProperty(object, "name");
    const samplesExpression = context.objectProperty(object, "samples");
    const descriptionsExpression = context.objectProperty(
        object,
        "textureDescriptions",
    );
    if (!descriptionsExpression) {
        context.fail(object, "Geometry renderer task requires textureDescriptions.");
    }
    const descriptions = context.unwrap(descriptionsExpression);
    if (!ts.isArrayLiteralExpression(descriptions)) {
        context.fail(descriptions, "Geometry textureDescriptions must be an array literal.");
    }
    if (
        descriptions.elements.length === 0 ||
        descriptions.elements.length > 8
    ) {
        context.fail(
            descriptions,
            "Geometry textureDescriptions must contain 1-8 entries.",
        );
    }
    const attachments: GeometryTextureTypeName[] = [];
    const compiledDescriptions = descriptions.elements.map((element) => {
        const description = context.expectObjectLiteral(element);
        validateObjectProperties(
            context,
            description,
            ["type", "format", "clearValue"],
            "Geometry texture descriptions support type, format, and clearValue.",
        );
        const typeExpression = context.objectProperty(description, "type");
        if (!typeExpression) {
            context.fail(description, "Geometry texture description requires type.");
        }
        const type = compileGeometryTextureType(context, typeExpression);
        if (attachments.includes(type)) {
            context.fail(typeExpression, `Duplicate geometry texture type ${type}.`);
        }
        attachments.push(type);
        const formatExpression = context.objectProperty(description, "format");
        const format = formatExpression
            ? context.compileStringLiteral(formatExpression)
            : "";
        if (format && format !== "r16float") {
            context.fail(
                formatExpression!,
                `Unsupported geometry texture format override '${format}'.`,
            );
        }
        // An attachment's clear value is the pin's own, per lane
        // (`GEOMETRY_TEXTURE_DESCRIPTIONS`), and the runtime already carries
        // that table. A descriptor may restate it -- scene 148 spells out
        // VIEW_DEPTH's zero -- but a genuine override has nowhere to go yet,
        // so it is refused rather than dropped.
        const clearExpression = context.objectProperty(
            description,
            "clearValue",
        );
        if (clearExpression) {
            const clear = context.expectObjectLiteral(clearExpression);
            const pinned = pinnedGeometryClearValue(type);
            for (const channel of ["r", "g", "b", "a"] as const) {
                const value = context.objectProperty(clear, channel);
                const written = value
                    ? compileStaticNumber(context, value, "clearValue")
                    : 0;
                if (written !== pinned) {
                    context.fail(
                        clearExpression,
                        `Geometry ${type} clears to ${pinned} in Babylon Lite; ` +
                            `this descriptor asks for ${written}, which this ` +
                            "port does not carry per attachment.",
                    );
                }
            }
        }
        return `bbl::GeometryTextureDescription{bbl::GeometryTextureType::${geometryEnumMember(type)}, ${format === "r16float" ? "bbl::GeometryTextureFormat::r16_float" : "bbl::GeometryTextureFormat::automatic"}}`;
    });
    const targetExpression = context.objectProperty(object, "targetTexture");
    const target = targetExpression
        ? context.compileValue(targetExpression)
        : undefined;
    if (target && targetExpression) {
        context.expectKind(target, "render-target", targetExpression);
    }
    const clearColorExpression = context.objectProperty(
        object,
        "targetTextureClearColor",
    );
    if (clearColorExpression && !target) {
        context.fail(
            clearColorExpression,
            "targetTextureClearColor requires targetTexture.",
        );
    }
    const manifest: GeometryOutputTaskManifest = {
        shaderIndex: context.geometryOutputTasks.length,
        attachments,
        emitColor: target !== undefined,
    };
    return {
        cpp: `bbl::GeometryTaskOptions{${context.cppString(
            nameExpression
                ? context.compileStringLiteral(nameExpression)
                : `geometry-${manifest.shaderIndex}`,
        )}, ${manifest.shaderIndex}u, ${samplesExpression ? compilePositiveInteger(context, samplesExpression) : "1u"}, {${compiledDescriptions.join(", ")}}, ${target?.cpp ?? "bbl::RenderTargetHandle{}"}, ${clearColorExpression ? "true" : "false"}, ${clearColorExpression ? context.compileColor4(clearColorExpression) : "bbl::Color4{}"}}`,
        manifest,
    };
}

export function compileCopyTaskOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): string {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "name",
            "sourceTexture",
            "targetTexture",
            "resolveTexture",
            "viewport",
        ],
        "Reached copy tasks support name, sourceTexture, targetTexture, resolveTexture, and viewport.",
    );
    const nameExpression = context.objectProperty(object, "name");
    const sourceCpp = compileTextureReference(
        context,
        object,
        "sourceTexture",
    );
    const targetExpression = context.objectProperty(object, "targetTexture");
    const resolveExpression = context.objectProperty(object, "resolveTexture");
    const target = targetExpression
        ? context.compileValue(targetExpression)
        : undefined;
    const resolveTarget = resolveExpression
        ? context.compileValue(resolveExpression)
        : undefined;
    if (!target && !resolveTarget) {
        context.fail(object, "Copy task requires targetTexture or resolveTexture.");
    }
    if (target && targetExpression) {
        context.expectKind(target, "render-target", targetExpression);
    }
    if (resolveTarget && resolveExpression) {
        context.expectKind(resolveTarget, "render-target", resolveExpression);
    }
    const viewportExpression = context.objectProperty(object, "viewport");
    let viewport = "bbl::NormalizedViewport{}";
    if (viewportExpression) {
        const viewportObject = context.expectObjectLiteral(viewportExpression);
        viewport = `bbl::NormalizedViewport{${requiredObjectNumber(context, viewportObject, "x", "double")}, ${requiredObjectNumber(context, viewportObject, "y", "double")}, ${requiredObjectNumber(context, viewportObject, "width", "double")}, ${requiredObjectNumber(context, viewportObject, "height", "double")}}`;
    }
    return `bbl::CopyTaskOptions{${context.cppString(
        nameExpression ? context.compileStringLiteral(nameExpression) : "copy-task",
    )}, ${sourceCpp}, ${target?.cpp ?? "bbl::RenderTargetHandle{}"}, ${resolveTarget?.cpp ?? "bbl::RenderTargetHandle{}"}, ${viewportExpression ? "true" : "false"}, ${viewport}}`;
}

function compileGeometryTextureType(
    context: EngineOptionContext,
    expression: ts.Expression,
): GeometryTextureTypeName {
    const unwrapped = context.unwrap(expression);
    if (
        !ts.isPropertyAccessExpression(unwrapped) ||
        !ts.isIdentifier(unwrapped.expression) ||
        context.symbols.importedName(unwrapped.expression) !==
            "GeometryTextureType"
    ) {
        context.fail(
            unwrapped,
            "Expected a GeometryTextureType enum member.",
        );
    }
    const type = unwrapped.name.text as GeometryTextureTypeName;
    const supported = new Set<GeometryTextureTypeName>([
        "IRRADIANCE",
        "WORLD_POSITION",
        "LOCAL_POSITION",
        "REFLECTIVITY",
        "VIEW_DEPTH",
        "NORMALIZED_VIEW_DEPTH",
        "SCREENSPACE_DEPTH",
        "VIEW_NORMAL",
        "WORLD_NORMAL",
        "ALBEDO",
        "LINEAR_VELOCITY",
    ]);
    if (!supported.has(type)) {
        context.fail(unwrapped.name, `Unsupported geometry texture type '${type}'.`);
    }
    return type;
}

export function geometryEnumMember(type: GeometryTextureTypeName): string {
    return type.toLowerCase();
}

export function requiredObjectNumber(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    name: string,
    precision: "float" | "double" = "float",
): string {
    const value = context.objectProperty(object, name);
    if (!value) {
        context.fail(object, `Object literal is missing numeric property '${name}'.`);
    }
    return context.compileNumber(value, precision);
}

/**
 * A render-target option the caller may omit, as the handle it names.
 *
 * Four task options are written this way -- a copy task's target and its
 * resolve, a render task's resolve, a post-process pass's target -- and each
 * means the same thing: a target when the scene named one, and the invalid
 * handle when it did not.
 */
export function optionalRenderTarget(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    property: string,
): { cpp: string; value?: Value } {
    const expression = context.objectProperty(object, property);
    if (!expression) {
        return { cpp: "bbl::RenderTargetHandle{}" };
    }
    const value = context.compileValue(expression);
    context.expectKind(value, "render-target", expression);
    return { cpp: value.cpp, value };
}

/**
 * A texture option, as the render-texture reference the frame graph carries.
 *
 * A render target names its own colour attachment; a render texture — a
 * geometry task's attachment, its output or its depth — already is one.
 *
 * `sampling` says how the task will read it. A pass that samples declares
 * `texture_2d<f32>`, so a geometry task's own depth attachment cannot bind
 * there — a scene wanting depth values reads them out of the colour
 * attachment the geometry task writes them to, which is what the pin does.
 * Refusing it here names the property; the backend would only fail the pipeline.
 */
export function compileTextureReference(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    property: string,
    sampling: "color" | "any" = "any",
): string {
    const expression = context.objectProperty(object, property);
    if (!expression) {
        context.fail(object, `Frame-graph task requires ${property}.`);
    }
    return compileRenderTextureValue(
        context,
        expression,
        context.compileValue(expression),
        `Frame-graph ${property}`,
        { sampling },
    );
}

/** All `compileRenderTextureValue` needs: somewhere to refuse. */
export interface RenderTextureSlotContext {
    fail(expression: ts.Node, message: string): never;
}

/**
 * The one place a slot says which render textures may fill it.
 *
 * Two axes decide, and both are compile-time constants: the ASPECT
 * (`sampling`) is what a bound view gives the shader, and the SOURCE
 * (`sources`) is who owns the texture -- a `render_target` the scene made,
 * a geometry task's MRT attachment, its packed output, or its own depth.
 * A slot naming its accepted set gets a refusal with a source location;
 * leaving it out lets a backend fail a binding at run time instead, which
 * is a PAL adjudicating what Babylon a slot accepts.
 */
export function compileRenderTextureValue(
    context: RenderTextureSlotContext,
    expression: ts.Expression,
    value: Value,
    describe: string,
    options: {
        sampling?: "color" | "any";
        sources?: readonly NonNullable<Value["renderTextureSource"]>[];
    } = {},
): string {
    const sampling = options.sampling ?? "any";
    if (value.kind === "render-target") {
        return `bbl::render_target_texture(${value.cpp})`;
    }
    if (value.kind !== "render-texture") {
        return context.fail(
            expression,
            `${describe} must be a render texture, received ${value.kind}.`,
        );
    }
    if (sampling === "color" && value.isDepthTexture) {
        context.fail(
            expression,
            `${describe} is sampled as colour, so it cannot be a depth attachment.`,
        );
    }
    if (options.sources && !options.sources.includes(
        value.renderTextureSource ?? "render-target",
    )) {
        context.fail(
            expression,
            `${describe} accepts ${options.sources.join(" or ")} textures, ` +
                `received a ${value.renderTextureSource ?? "render-target"} one.`,
        );
    }
    return value.cpp;
}

export function compileSceneDefaultRenderTask(
    context: EngineOptionContext,
    expression: ts.Expression | undefined,
): boolean {
    if (!expression) {
        return true;
    }
    const options = context.expectObjectLiteral(expression);
    const value = context.objectProperty(
        options,
        "defaultRenderTask",
    );
    if (!value) {
        return true;
    }
    const compiled = context.compileBoolean(value);
    if (compiled !== "true" && compiled !== "false") {
        context.fail(
            value,
            "defaultRenderTask must be a static boolean.",
        );
    }
    return compiled === "true";
}

/**
 * What Babylon Lite clears one geometry attachment to.
 *
 * The pin's own per-lane table: every attachment clears to zero except the
 * normalized view depth, whose zero is the near plane under reverse-Z, so it
 * clears to one. The runtime carries the same table; this is only what a
 * descriptor's `clearValue` is checked against.
 */
function pinnedGeometryClearValue(type: GeometryTextureTypeName): number {
    return type === "NORMALIZED_VIEW_DEPTH" ? 1 : 0;
}
