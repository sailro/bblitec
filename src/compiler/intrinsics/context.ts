import type { LoweringServices } from "../lowering-services.js";
// What every intrinsic lowerer needs from the compiler.
//
// Each family declares the surface it uses, which is the point of the
// split: a lowerer that never resolves an engine should not be handed
// one. But four members appeared in all eight declarations verbatim --
// check the argument count, compile a value, require a kind, record the
// feature -- because they are what lowering *an intrinsic* means rather
// than what any one family needs. They are declared here and extended,
// so a family's own interface says only what makes it different.


export interface IntrinsicCallContext
    extends Pick<LoweringServices,
        | "expectArgumentCount"
        | "compileValue"
        | "expectKind"
        | "reachFeature"
        | "recordSceneMaterialSlot"
        | "isRuntimeResourceConstruction"
        | "recordSceneMesh"
    > {}
