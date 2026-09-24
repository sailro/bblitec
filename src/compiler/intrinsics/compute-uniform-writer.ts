import type ts from "typescript";
import type { Value } from "../types.js";
import { isTypedArrayType } from "../data-types.js";
import { argumentAt } from "../syntax.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";

const setters: Record<string, string> = {
    setComputeUniformF32: "f32",
    setComputeUniformU32: "u32",
    setComputeUniformI32: "i32",
    setComputeUniformVector: "vector",
    setComputeUniformMatrix: "matrix",
};
export function compileComputeUniformWriterIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    const setter = setters[name];
    if (name !== "createComputeUniformWriter" && !setter) return undefined;
    context.expectArgumentCount(call, 3, 3);
    context.reachFeature("compute:task", call);
    context.reachFeature("compute:uniform-buffer", call);
    context.reachFeature("compute:uniform-arena", call);
    context.reachFeature("compute:uniform-layout", call);
    context.reachFeature("compute:uniform-writer", call);
    const owner = context.compileValue(argumentAt(call, 0));
    if (!setter) {
        context.expectKind(owner, "compute-uniform-arena", call);
        const slot = context.compileNumber(argumentAt(call, 1)),
            layout = context.compileValue(argumentAt(call, 2));
        context.expectKind(layout, "compute-uniform-layout", call);
        return {
            kind: "compute-uniform-writer",
            dataType: { kind: "handle", handle: "compute-uniform-writer" },
            cpp: `bbl::create_compute_uniform_writer(${owner.cpp}, ${slot}, ${layout.cpp})`,
        };
    }
    context.expectKind(owner, "compute-uniform-writer", call);
    const field = context.compileValue(argumentAt(call, 1));
    context.expectKind(field, "string", call);
    const input = argumentAt(call, 2);
    let cpp: string;
    if (setter === "vector" || setter === "matrix") {
        const value = context.compileValue(input),
            type = value.dataType;
        if (
            !isTypedArrayType(type) &&
            !(type?.kind === "vector" && type.element.kind === "number") &&
            type?.kind !== "tuple"
        )
            return context.fail(
                input,
                "Uniform vector and matrix setters require retained numeric arrays.",
            );
        const retained = context.bindings.pinValueToTemporary(
            value,
            "uniform_elements",
            input,
        );
        cpp = `bbl::UniformNumericView(${retained.cpp})`;
    } else cpp = context.compileNumber(input);
    return {
        kind: "void",
        cpp: `bbl::set_compute_uniform_${setter}(${owner.cpp}, ${field.cpp}, ${cpp})`,
    };
}
