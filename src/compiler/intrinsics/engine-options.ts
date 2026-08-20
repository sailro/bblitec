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

export function compileRenderTargetOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): string {
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
    return `bbl::RenderTargetOptions{${samples ? compilePositiveInteger(context, samples) : "1u"}, ${colorFormat ? "true" : "false"}, ${depthFormat ? "true" : "false"}, false, ${width}, ${height}}`;
}

export function compileRenderTaskOptions(
    context: EngineOptionContext,
    expression: ts.Expression,
): string {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["name", "rt", "clrColor", "clr", "cam", "cs", "autoMirror", "depth"],
        "Reached render tasks support name, rt, clrColor, clr, cam, cs, autoMirror, and depth.",
    );
    const nameExpression = context.objectProperty(object, "name");
    const targetExpression = context.objectProperty(object, "rt");
    if (!targetExpression) {
        context.fail(object, "Render task requires an rt render target.");
    }
    const target = context.compileValue(targetExpression);
    context.expectKind(target, "render-target", targetExpression);
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
    // task's output is eager.
    const depthExpression = context.objectProperty(object, "depth");
    let depth = "bbl::RenderTextureRef{}";
    if (depthExpression) {
        const value = context.compileValue(depthExpression);
        // Only a geometry task's own depth is a depth attachment; every
        // other render texture is a colour one, and the record says which by
        // its source rather than by a flag beside it.
        if (value.kind !== "render-texture" || !value.isDepthTexture) {
            context.fail(
                depthExpression,
                "Render task depth must be a geometry task's geometryDepthTexture.",
            );
        }
        depth = value.cpp;
    }
    return `bbl::RenderTaskOptions{${context.cppString(
        nameExpression ? context.compileStringLiteral(nameExpression) : "render-task",
    )}, ${target.cpp}, ${clearColor ? context.compileColor4(clearColor) : "bbl::Color4{}"}, ${clear ? context.compileBoolean(clear) : "true"}, ${camera?.cpp ?? "bbl::CameraHandle{}"}, ${camera ? "true" : "false"}, ${canvasSize ? context.compileBoolean(canvasSize) : "false"}, ${autoMirror ? context.compileBoolean(autoMirror) : "true"}, ${depth}}`;
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
    const value: Value = context.compileValue(expression);
    if (value.kind === "render-target") {
        return `bbl::render_target_texture(${value.cpp})`;
    }
    if (value.kind === "render-texture") {
        if (sampling === "color" && value.isDepthTexture) {
            context.fail(
                expression,
                `Frame-graph ${property} is sampled as colour, so it cannot be a depth attachment.`,
            );
        }
        return value.cpp;
    }
    return context.fail(
        expression,
        `Frame-graph ${property} must be a render texture, received ${value.kind}.`,
    );
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
