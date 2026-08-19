import { indent } from "./shader-builtins-utility.js";

/**
 * The custom-shader `fx` uniform block, at whichever group and binding the
 * fragment stage reads it.
 *
 * Upstream binds it after the atlas and any extra textures, inside the one
 * group it declares for the family. SDL_GPU takes fragment uniforms in a
 * group of their own, so the block lands beside the layer or system block it
 * shares that group with. The struct body is the pin's, so a field it adds
 * arrives here without this module naming one.
 *
 * A body that never names `fx` still has the block declared, as upstream
 * declares it. A block a stage does not read does not reach the compiled
 * shader, and which ones survived — with the slots they took — is published
 * beside that shader by the pass that assigned them, so nothing here has to
 * decide it from the text.
 *
 * Both sprite families compose it identically — the pin shares the builder
 * between them — so they share the emitter too.
 */
export function fxBlockWgsl(
    fields: string,
    group: number,
    binding: number,
): string {
    return `struct SpriteFx {
${indent(fields, "    ")}
};
@group(${group}) @binding(${binding}) var<uniform> fx: SpriteFx;
`;
}
