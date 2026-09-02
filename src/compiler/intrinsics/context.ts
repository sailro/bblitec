// What every intrinsic lowerer needs from the compiler.
//
// Each family declares the surface it uses, which is the point of the
// split: a lowerer that never resolves an engine should not be handed
// one. But four members appeared in all eight declarations verbatim --
// check the argument count, compile a value, require a kind, record the
// feature -- because they are what lowering *an intrinsic* means rather
// than what any one family needs. They are declared here and extended,
// so a family's own interface says only what makes it different.
import type ts from "typescript";

import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

export interface IntrinsicCallContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    /**
     * Records the feature and its first reaching scene-source call
     * site, so the activation inventory can cite file:line. `site` is
     * the scene AST node being lowered — for an intrinsic, the call.
     */
    reachFeature(feature: Feature, site: ts.Node): void;
    /** Records a scene-code mesh creation for the per-renderable variant key. */
    /** Counts one scene-code material creation of any family. */
    recordSceneMaterialSlot(): number;
    /** Records a scene-code mesh creation and returns its creation index. */
    recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
            /** At least one stream's presence is a run-time answer. */
            runtimeStreams?: true;
        },
    ): number;
}
