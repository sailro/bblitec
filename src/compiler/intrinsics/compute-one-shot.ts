import type ts from "typescript";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import type { ComputeTaskIntrinsicContext } from "./compute-task.js";

export function compileComputeOneShotIntrinsic(
    context: ComputeTaskIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "createComputeOneShot",
            "armComputeOneShot",
            "disposeComputeOneShot",
        ].includes(name)
    )
        return undefined;
    context.expectArgumentCount(call, 1, 1);
    context.reachFeature("compute:one-shot", call);
    const value = context.compileValue(argumentAt(call, 0));
    context.expectKind(
        value,
        name === "createComputeOneShot" ? "compute-task" : "compute-one-shot",
        call,
    );
    if (name === "createComputeOneShot")
        return {
            kind: "compute-one-shot",
            dataType: { kind: "handle", handle: "compute-one-shot" },
            cpp: `bbl::create_compute_one_shot(${value.cpp})`,
            ...(value.engineCpp ? { engineCpp: value.engineCpp } : {}),
        };
    if (name === "disposeComputeOneShot")
        return {
            kind: "void",
            cpp: `bbl::dispose_compute_one_shot(${value.cpp})`,
        };
    return {
        kind: "promise",
        cpp: `bbl::arm_compute_one_shot(${value.cpp})`,
        promiseType: "bbl::js::PromiseVoid",
        promiseResult: { kind: "void", cpp: "" },
    };
}
