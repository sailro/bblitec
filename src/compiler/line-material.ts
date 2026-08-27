/**
 * A line material's variant, registered the way every other reached shader
 * program is.
 *
 * The program itself is not written here: `LineLowerer` folds it out of the
 * pin's own `createLineMaterial` — the two stages from its text builders, the
 * declarations and fixed-function state from the `createShaderMaterial` call
 * it makes — so this module is only the reach. What it adds is the identity
 * rule: the pin names every line material `"LineMaterial"` while composing a
 * different program per permutation, so the variant's name is the
 * permutation, and a scene reaching both the uniform-colour and the
 * vertex-colour form registers two.
 */
import type ts from "typescript";
import { LoweringContext } from "../lowering/context.js";
import {
    LineLowerer,
    variantName,
    type LineMaterialOptions,
} from "../lowering/line-lowerer.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import {
    reachedShaderProgram,
    reachFoldedShaderProgram,
    type ShaderMaterialContext,
} from "./shader-material.js";

/**
 * One lowerer per process. The pin does not change between compiles, and
 * reconstructing its sources is the expensive half.
 */
let cached: LineLowerer | undefined;

function lineLowerer(): LineLowerer {
    if (!cached) {
        cached = new LineLowerer(
            new LoweringContext(sharedUpstreamStore()),
        );
    }
    return cached;
}

/** The permutation a reached call settles, before the pin's colour default. */
export type ReachedLineMaterial = Omit<LineMaterialOptions, "color"> & {
    color?: readonly [number, number, number, number];
};

/** What a registered line variant settled, by the flags that named it. */
export interface LineMaterialPermutation {
    useVertexColor: boolean;
    useThinInstanceColors: boolean;
}

export function reachLineMaterialProgram(
    context: ShaderMaterialContext,
    node: ts.Node,
    options: ReachedLineMaterial,
): { name: string; id: number } {
    const lowerer = lineLowerer();
    // The variant's name is a pure function of the permutation, so a scene
    // reaching one twice re-registers it without walking the pin's own
    // factory a second time.
    return reachFoldedShaderProgram(
        context,
        node,
        variantName({
            ...options,
            color: options.color ?? [1, 1, 1, 1],
        }),
        "line",
        () =>
            lowerer.materialProgram({
                ...options,
                color: options.color ?? lowerer.defaultColor(),
            }),
    );
}

/**
 * What a registered line variant settled, for the checks a line *system*
 * makes against the geometry it flattened. A program with no topology is a
 * shader material the line factory did not build.
 */
export function lineMaterialPermutation(
    context: ShaderMaterialContext,
    name: string,
    node: ts.Node,
): LineMaterialPermutation | undefined {
    const program = reachedShaderProgram(context, name, node);
    if (!program.topology) {
        return undefined;
    }
    return {
        useVertexColor: program.attributes.includes("color"),
        useThinInstanceColors: program.useThinInstanceColors === true,
    };
}
