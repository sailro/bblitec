// Environment option lowering: the .env, .dds, and .hdr loaders.
//
// Each function turns an environment loader's options argument into
// the resolved values the generated loader consumes, folding the skip
// flags and sizes to statics at compile time. The intrinsic lowerer in
// asset.ts calls these through its context.
import type ts from "typescript";
import {
    compileOptionalStaticBoolean,
    type StaticBooleanContext,
    compilePositiveInteger,
    type PositiveIntegerContext,
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";

export interface AssetOptionContext
    extends ObjectValidationContext,
        PositiveIntegerContext,
        StaticBooleanContext {
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
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
}

export function compileEnvironmentOptions(
    context: AssetOptionContext,
    expression: ts.Expression,
): {
    groundTextureUrl: string;
    skyboxUrl: string;
    skyboxSize: string;
    brdfUrl: string;
    skipSkybox: boolean;
    skipGround: boolean;
} {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "groundTextureUrl",
            "skyboxUrl",
            "skyboxSize",
            "brdfUrl",
            "skipSkybox",
            "skipGround",
        ],
        "Reached environment options support groundTextureUrl, skyboxUrl, skyboxSize, brdfUrl, skipSkybox, and skipGround.",
    );
    const groundTextureUrl = context.objectProperty(object, "groundTextureUrl");
    const skyboxUrl = context.objectProperty(object, "skyboxUrl");
    const skyboxSize = context.objectProperty(object, "skyboxSize");
    const brdfUrl = context.objectProperty(object, "brdfUrl");
    // `skipSkybox` and `skipGround` decide whether `loadEnvironment`'s
    // deferred builder pushes a background renderable at all, so they are
    // read rather than tolerated: the solid-colour skybox is what a scene
    // gets when it sets neither.
    const skipFlag = (name: "skipSkybox" | "skipGround"): boolean =>
        compileOptionalStaticBoolean(
            context,
            context.objectProperty(object, name),
            false,
            name,
        );
    return {
        groundTextureUrl: groundTextureUrl ? context.compileStringLiteral(groundTextureUrl) : "",
        skyboxUrl: skyboxUrl ? context.compileStringLiteral(skyboxUrl) : "",
        // Zero asks the loader for the pinned default rather than
        // inventing one here: `createDefaultEnvironment`'s skyboxSize is
        // 20, and the generated loader already resolves it. Passing a
        // size of our own produced a skybox large enough for the camera's
        // far plane to clip it, which shows as a straight-edged hole in
        // the background once the camera moves off the reference pose.
        skyboxSize: skyboxSize ? context.compileNumber(skyboxSize) : "0.0f",
        brdfUrl: brdfUrl ? context.compileStringLiteral(brdfUrl) : "",
        skipSkybox: skipFlag("skipSkybox"),
        skipGround: skipFlag("skipGround"),
    };
}

/**
 * `loadDdsEnvironment` takes a required `brdfUrl` plus `skipSkybox` and
 * `skipGround`, which it accepts and never acts on — it creates neither.
 * Rejecting them keeps a scene that sets one from compiling as though it
 * had been honoured.
 */
export function compileDdsEnvironmentOptions(
    context: AssetOptionContext,
    expression: ts.Expression,
): string {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["brdfUrl"],
        "Reached DDS environment options support brdfUrl.",
    );
    const brdfUrl = context.objectProperty(object, "brdfUrl");
    return brdfUrl ? context.compileStringLiteral(brdfUrl) : "";
}

export function compileHdrEnvironmentOptions(
    context: AssetOptionContext,
    expression: ts.Expression,
): {
    faceSize: number;
    useCubemapSkybox: boolean;
    skipGround: boolean;
    skyboxSize: string;
    skyboxPosition: string;
} {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "faceSize",
            "useCubemapSkybox",
            "skipGround",
            "skyboxSize",
            "skyboxPosition",
        ],
        "HDR environment options support faceSize, cubemap skybox, ground skipping, skybox size, and skybox position.",
    );
    const faceSizeExpression = context.objectProperty(object, "faceSize");
    const faceSize = faceSizeExpression
        ? Number(compilePositiveInteger(context, faceSizeExpression).slice(0, -1))
        : 256;
    if ((faceSize & (faceSize - 1)) !== 0 || faceSize > 2048) {
        context.fail(
            faceSizeExpression ?? object,
            "HDR faceSize must be a power of two no larger than 2048.",
        );
    }
    const useCubemapSkybox = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "useCubemapSkybox"),
        false,
    );
    const skipGround = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "skipGround"),
        false,
    );
    const skyboxSize = context.objectProperty(object, "skyboxSize");
    const skyboxPosition = context.objectProperty(object, "skyboxPosition");
    if (useCubemapSkybox && (!skyboxSize || !skyboxPosition)) {
        context.fail(
            object,
            "Reached HDR cubemap skyboxes require explicit skyboxSize and skyboxPosition.",
        );
    }
    return {
        faceSize,
        useCubemapSkybox,
        skipGround,
        skyboxSize: skyboxSize ? context.compileNumber(skyboxSize) : "0.0f",
        skyboxPosition: skyboxPosition
            ? context.compileVec3(skyboxPosition)
            : "bbl::Vec3{}",
    };
}
