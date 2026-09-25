/**
 * The `defines` half of the pin's own ShaderMaterial prelude.
 *
 * WGSL has no preprocessor, so `buildShaderPrelude` turns each
 * `createShaderMaterial({ defines })` entry into a module-scope `const`
 * declaration prepended to both stages. That text is the pin's -- the type
 * word it picks for a boolean against a number, and `formatDefineValue`'s
 * rule for printing an integer as `2.0` where a fractional value prints
 * bare -- so the builder is executed and its define declarations are read
 * out of the prelude it returns.
 *
 * Only the define texts come from the pin. The rest of that prelude is
 * re-addressed by this port (SDL fixes vertex uniforms at register space 1
 * and fragment uniforms at space 3, and vertex attributes take the native
 * `GpuVertex` locations rather than declaration order), which is why the
 * builder runs over a material carrying only its defines, and only the
 * `const` declarations those defines produced are kept.
 */
import type { LoweringContext } from "./context.js";
import { PinnedShaderBuilders } from "./pinned-shader-builders.js";
import { reflectWgslModule } from "../shader-ir.js";

export const shaderPipelineModule = "src/material/shader/shader-pipeline.ts";

/** A reached `defines` entry, in the pin's own `ShaderDefine` shape. */
interface PinnedShaderDefine {
    readonly name: string;
    readonly value: boolean | number;
}

/**
 * The pin's own prelude text for a scene's reached defines, in the order
 * `createShaderMaterial` sorted them. The pin appends each define's text to
 * its prelude with no separator, so the declarations are one contiguous
 * run of the prelude, which is returned as the pin wrote it.
 */
export function pinnedShaderDefineText(
    context: LoweringContext,
    defines: readonly PinnedShaderDefine[],
): string {
    if (defines.length === 0) {
        return "";
    }
    const { declaration } = context.functionDeclaration(
        shaderPipelineModule,
        "buildShaderPrelude",
    );
    const prelude = new PinnedShaderBuilders(context).call(
        shaderPipelineModule,
        "buildShaderPrelude",
        [
            {
                samplerDecls: [],
                storageBufferDecls: [],
                defines: defines.map(({ name, value }) => ({ name, value })),
                attributes: [],
            },
            { _structBody: "" },
            null,
        ],
    );
    if (typeof prelude !== "string") {
        return context.contractError(
            declaration,
            `Pinned buildShaderPrelude returned ${typeof prelude}, not shader text.`,
        );
    }
    // The prelude's own declarations, located by its syntax: each define is
    // the `const` of its name, and the run they form is kept whole.
    const constants = reflectWgslModule(prelude).declarations.filter(
        (candidate) =>
            candidate.kind === "const" &&
            defines.some(({ name }) => name === candidate.name),
    );
    const contiguous = constants.every(
        (constant, index) =>
            index === 0 || constants[index - 1]!.end === constant.start,
    );
    if (
        constants.length !== defines.length ||
        !contiguous ||
        constants.some(
            (constant, index) =>
                constant.kind !== "const" ||
                constant.name !== defines[index]!.name,
        )
    ) {
        return context.contractError(
            declaration,
            "Pinned buildShaderPrelude no longer writes one const per define, in order, as one run.",
        );
    }
    return prelude.slice(
        constants[0]!.start,
        constants[constants.length - 1]!.end,
    );
}
