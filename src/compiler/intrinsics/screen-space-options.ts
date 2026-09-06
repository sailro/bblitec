// Screen-space effect task option lowering.
//
// `createScreenSpaceContactShadowsPostProcessTask` and
// `createScreenSpaceGlobalIlluminationPostProcessTask` take one config each:
// the textures and camera the task reads, a light direction for the contact
// producer, and the effect's own settings. The textures, camera and light are
// compiled here as handles; every setting is resolved statically and
// forwarded whole to the pin's own factory, which clamps them at composition
// (`pinned-screen-space.ts`) -- so a default or a range the pin changes is
// the pin's answer, not this file's.
import ts from "typescript";
import { screenSpaceFacts } from "../../pinned-screen-space.js";
import { doubleLiteral } from "../../cpp-literals.js";
import { compileStaticNumber } from "../option-helpers.js";
import type { ScreenSpaceTaskManifest } from "../types.js";
import {
    optionalRenderTarget,
    type EngineOptionContext,
} from "./engine-options.js";
import { compileDescriptorOptions } from "./post-process-options.js";

export interface CompiledScreenSpaceTask {
    /** The generated factory's arguments after the engine, in order. */
    argumentsCpp: string;
    manifest: ScreenSpaceTaskManifest;
}

/** The config members the task reads as handles rather than settings. */
const HANDLE_OPTIONS = new Set([
    "name",
    "sourceTexture",
    "depthTexture",
    "targetTexture",
    "camera",
    "lightDirection",
]);

export function compileScreenSpaceTaskOptions(
    context: EngineOptionContext,
    intrinsic: string,
    expression: ts.Expression,
    taskIndex: number,
): CompiledScreenSpaceTask {
    const { kind } = screenSpaceFacts(intrinsic);
    const object = context.expectObjectLiteral(expression);
    const nameExpression = context.objectProperty(object, "name");
    const name = nameExpression
        ? context.compileStringLiteral(nameExpression)
        : undefined;

    // The source is a render target rather than any render texture: the
    // pin reads its descriptor's sample count and depth format, sizes its
    // owned targets from it and, for GI, samples its colour at ray hits.
    const sourceExpression = context.objectProperty(object, "sourceTexture");
    if (!sourceExpression) {
        context.fail(object, `${intrinsic} requires a sourceTexture.`);
    }
    const source = context.compileValue(sourceExpression);
    context.expectKind(source, "render-target", sourceExpression);
    const depth = optionalRenderTarget(context, object, "depthTexture");
    const target = optionalRenderTarget(context, object, "targetTexture");

    const cameraExpression = context.objectProperty(object, "camera");
    if (!cameraExpression) {
        context.fail(object, `${intrinsic} requires a camera.`);
    }
    const camera = context.compileValue(cameraExpression);
    context.expectKind(camera, "camera", cameraExpression);

    const lightDirection = compileLightDirection(
        context,
        object,
        intrinsic,
        kind,
    );
    const options = compileDescriptorOptions(
        context,
        object,
        intrinsic,
        HANDLE_OPTIONS,
    );

    return {
        argumentsCpp:
            `${source.cpp}, ${depth.cpp}, ${target.cpp}, ${camera.cpp}, ` +
            lightDirection,
        manifest: {
            taskIndex,
            intrinsic,
            ...(name !== undefined ? { name } : {}),
            options,
            hasTarget: target.value !== undefined,
            hasDepthTexture: depth.value !== undefined,
        },
    };
}

/**
 * The contact producer's `lightDirection`: the pin keeps the object it was
 * handed and normalizes it every frame. A light's own `direction` is that
 * light's record, read live; a literal is kept as the value it spells.
 */
function compileLightDirection(
    context: EngineOptionContext,
    object: ts.ObjectLiteralExpression,
    intrinsic: string,
    kind: "scalar" | "color",
): string {
    const expression = context.objectProperty(object, "lightDirection");
    if (kind === "color") {
        if (expression) {
            context.fail(
                expression,
                `${intrinsic} reads no lightDirection.`,
            );
        }
        return "bbl::ScreenSpaceLightDirection{}";
    }
    if (!expression) {
        context.fail(object, `${intrinsic} requires a lightDirection.`);
    }
    const unwrapped = context.unwrap(expression);
    if (
        ts.isPropertyAccessExpression(unwrapped) &&
        unwrapped.name.text === "direction"
    ) {
        const owner = context.compileValue(unwrapped.expression);
        if (owner.kind === "light") {
            return `bbl::ScreenSpaceLightDirection{${owner.cpp}, bbl::Vec3d{}}`;
        }
    }
    if (ts.isObjectLiteralExpression(unwrapped)) {
        const component = (field: string): string => {
            const value = context.objectProperty(unwrapped, field);
            if (!value) {
                context.fail(unwrapped, `lightDirection is missing '${field}'.`);
            }
            return doubleLiteral(
                compileStaticNumber(context, value, `lightDirection.${field}`),
            );
        };
        return (
            `bbl::ScreenSpaceLightDirection{bbl::LightHandle{}, bbl::Vec3d{` +
            `${component("x")}, ${component("y")}, ${component("z")}}}`
        );
    }
    return context.fail(
        expression,
        "lightDirection must be a light's own direction or an {x, y, z} literal.",
    );
}
