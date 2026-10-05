// `src/texture/external-texture.ts` and the ShaderMaterial external-texture binding API.
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import type { MaterialIntrinsicContext } from "./material.js";

const feature = "material:shader-external-texture";

/** `createExternalTexture(video)`: a fresh `{ video }` record, one identity per call. */
export function compileCreateExternalTexture(
    context: MaterialIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const video = context.compileValue(argumentAt(call, 0));
    context.expectKind(video, "video", argumentAt(call, 0));
    context.reachFeature(feature, call);
    // Bound once: the record's identity is what `setShaderExternalTexture`
    // compares, so a use of the value must not create it again.
    const cpp = context.allocateTemporaryCppName("external_texture");
    context.emit({
        kind: "declaration",
        type: "const bbl::ExternalTextureHandle",
        name: cpp,
        initializer: `bbl::create_external_texture(${video.cpp})`,
    });
    return {
        kind: "external-texture",
        dataType: { kind: "handle", handle: "external-texture" },
        cpp,
    };
}

/** `isExternalTextureReady(texture)`: the video's readyState against HAVE_CURRENT_DATA. */
export function compileIsExternalTextureReady(
    context: MaterialIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const texture = context.compileValue(argumentAt(call, 0));
    context.expectKind(texture, "external-texture", argumentAt(call, 0));
    context.reachFeature(feature, call);
    return {
        kind: "boolean",
        cpp: `bbl::is_external_texture_ready(${texture.cpp})`,
    };
}

/**
 * `setShaderExternalTexture(material, name, texture | null)`.
 *
 * The slot is the pin's `_externalTextureSlots` entry, settled at
 * generation. The pin rebinds the video on every refresh; here a slot binds
 * its frame when the engine's first frame uploads the material's textures,
 * so the binding must precede that, as the reached slice's does.
 */
export function compileSetShaderExternalTexture(
    context: MaterialIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 3, 3);
    const material = context.compileValue(argumentAt(call, 0));
    context.expectKind(material, "material", argumentAt(call, 0));
    const slot = context.intrinsicOptions.resolveShaderExternalTextureSlot(
        material,
        argumentAt(call, 1),
    );
    if (
        context.engineLifecycle.engineHasStarted() ||
        context.isRuntimeResourceConstruction()
    ) {
        context.fail(
            call,
            "setShaderExternalTexture binds before the engine starts: the native renderer uploads a material's textures with its first frame.",
        );
    }
    const textureExpression = argumentAt(call, 2);
    let texture = "nullptr";
    if (textureExpression.kind !== ts.SyntaxKind.NullKeyword) {
        const value = context.compileValue(textureExpression);
        context.expectKind(value, "external-texture", textureExpression);
        texture = value.cpp;
    }
    context.reachFeature(feature, call);
    return {
        kind: "void",
        cpp:
            `bbl::set_shader_external_texture(` +
            `${context.requireEngine(material, call)}, ` +
            `${material.cpp}, ${slot}u, ${texture})`,
    };
}
