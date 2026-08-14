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
    reachFeature(feature: Feature): void;
}
