import type {
    PinnedShaderText,
    ShaderTextBinding,
} from "./lowering/pinned-shader-text.js";
import { indent } from "./shader-builtins-utility.js";

/** The pinned module both families' custom-shader mechanics come from. */
const customShaderCoreModule = "src/sprite/custom-shader-core.ts";

/**
 * The `<name>Tex` / `<name>Samp` pairs a custom shader's extra textures bind
 * through, at this backend's own group.
 *
 * The pin emits them after the atlas inside the one group it declares for
 * the family; fragment textures live in a group of their own here, with the
 * atlas pair at 0 and 1, so the same builder is called with this group and
 * that start binding. Shared between the families for the reason
 * {@link fxBlockWgsl} is: the pin shares the builder, so they share the
 * emitter.
 */
export function extraTextureBindingsWgsl(
    shaderText: PinnedShaderText,
    names: readonly string[],
): string {
    if (names.length === 0) {
        return "";
    }
    return shaderText.evaluate(
        customShaderCoreModule,
        "makeExtraBindingsWgsl",
        new Map<string, ShaderTextBinding>([
            ["group", "2"],
            ["startBinding", 2],
            ["extras", extraTextureRecords(names)],
        ]),
    );
}

/**
 * The extra textures as the pin's own builders read them: a record per
 * texture carrying the identifier it binds under.
 */
export function extraTextureRecords(
    names: readonly string[],
): { name: string }[] {
    return names.map((name) => ({ name }));
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
