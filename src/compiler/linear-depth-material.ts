/**
 * A linear-depth material's variant, registered the way every other reached
 * shader program is.
 *
 * The program itself is not written here: `LinearDepthLowerer` folds it out
 * of the pin's own `createLinearDepthMaterial` — the two stages from the
 * module constants it references, the declarations and fixed-function state
 * from the `createShaderMaterial` call it makes — so this module is only the
 * reach. What it adds is the identity rule: the pin names every one of these
 * materials `"linearDepth"` while giving each its own near/far pair, and
 * this port carries a uniform default on the variant, so the planes are part
 * of the variant's name.
 */
import type ts from "typescript";
import { LoweringContext } from "../lowering/context.js";
import {
    LinearDepthLowerer,
    linearDepthVariantName,
    type LinearDepthMaterialOptions,
} from "../lowering/linear-depth-lowerer.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import { lowerWgslShaderProgram } from "../shader-ir.js";
import {
    reachShaderProgram,
    type ShaderMaterialContext,
} from "./shader-material.js";

/**
 * One lowerer per process, for the reason the line family keeps one: the pin
 * does not change between compiles and reconstructing its sources is the
 * expensive half.
 */
let cached: LinearDepthLowerer | undefined;

function linearDepthLowerer(): LinearDepthLowerer {
    if (!cached) {
        cached = new LinearDepthLowerer(
            new LoweringContext(sharedUpstreamStore()),
        );
    }
    return cached;
}

/** The pin's own plane defaults, for a call that names neither. */
export function linearDepthDefaultPlanes(): {
    near: number;
    far: number;
} {
    const lowerer = linearDepthLowerer();
    return {
        near: lowerer.defaultPlane("near"),
        far: lowerer.defaultPlane("far"),
    };
}

export function reachLinearDepthMaterialProgram(
    context: ShaderMaterialContext,
    node: ts.Node,
    options: LinearDepthMaterialOptions,
): { name: string; id: number } {
    const name = linearDepthVariantName(options);
    const reached = context.reachedShaderPrograms.findIndex(
        (candidate) => candidate.name === name,
    );
    if (reached >= 0) {
        return { name, id: reached };
    }
    const program = linearDepthLowerer().materialProgram(options);
    try {
        lowerWgslShaderProgram(program);
    } catch (error: unknown) {
        context.fail(
            node,
            `The pinned linear-depth material does not lower through the shader IR: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    return reachShaderProgram(context, program);
}
