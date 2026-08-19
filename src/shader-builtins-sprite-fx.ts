import { indent } from "./shader-builtins-utility.js";

/**
 * Whether a stage body reads a uniform block, by the name it is bound
 * under.
 *
 * A block a stage declares but never reads does not survive to the compiled
 * shader -- Tint drops it, and the SDL_GPU slots the survivors take are
 * dense -- so a declaration nothing reads would silently shift every slot
 * after it. The bodies here are either the pin's own or the caller's WGSL,
 * so the question is asked of the text, as the billboard vertex stage
 * already asks whether its basis reads the system block.
 */
export function stageReadsBlock(
    body: string,
    name: string,
): boolean {
    return new RegExp(`(^|[^A-Za-z0-9_])${name}\\.`).test(body);
}

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
 * Both sprite families compose it identically -- the pin shares the builder
 * between them -- so they share the emitter too.
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

/**
 * A fragment stage that may declare two uniform blocks: the family's own
 * layer or system block, and a custom shader's fx block.
 */
export interface FragmentUniformBody {
    /** The stage body, which decides what it reads. */
    fragmentBody: string;
    /** Present only for a custom-shader program. */
    fxStructFields?: string | undefined;
}

/** Where each fragment uniform block binds, or -1 when the body never reads it. */
export interface FragmentUniformSlots {
    layerBlock: number;
    fxBlock: number;
}

/**
 * The binding each fragment uniform block takes, numbered densely in
 * declaration order.
 *
 * Dense is not a style choice. SDL_GPU addresses a stage's uniform buffers
 * by slot, and the slot a block lands in is its rank among the blocks the
 * compiled shader kept -- so a declaration the body never reads, which is
 * dropped on the way to HLSL, would shift every push behind it onto the
 * wrong block. Numbering what is read, and pushing exactly that, keeps the
 * two ends agreeing.
 */
export function fragmentUniformSlots(
    shader: FragmentUniformBody,
): FragmentUniformSlots {
    const layerBlock =
        stageReadsBlock(shader.fragmentBody, "L") ||
        stageReadsBlock(shader.fragmentBody, "billboards");
    const fxBlock =
        shader.fxStructFields !== undefined &&
        stageReadsBlock(shader.fragmentBody, "fx");
    return {
        layerBlock: layerBlock ? 0 : -1,
        fxBlock: fxBlock ? (layerBlock ? 1 : 0) : -1,
    };
}
