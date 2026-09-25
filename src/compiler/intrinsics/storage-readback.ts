import type ts from "typescript";
import type { Value } from "../types.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";
import { argumentAt } from "../syntax.js";

export function compileStorageReadbackIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (name !== "readStorageBuffer") return undefined;
    context.expectArgumentCount(call, 1, 3);
    context.reachFeature("compute:storage-readback", call);
    const buffer = context.bindings.pinValueToTemporary(
        context.compileValue(argumentAt(call, 0)),
        "readback_storage",
        call,
    );
    context.expectKind(buffer, "storage-buffer", call);
    const args = [buffer.cpp];
    for (const argument of call.arguments.slice(1)) {
        const value = context.compileValue(argument);
        if (value.kind === "void") args.push("std::nullopt");
        else {
            context.expectKind(value, "number", argument);
            args.push(
                context.bindings.pinValueToTemporary(
                    value,
                    "readback_range",
                    argument,
                ).cpp,
            );
        }
    }
    return {
        kind: "promise",
        cpp: `bbl::read_gpu_storage_buffer(${args.join(", ")})`,
        promiseType: "bbl::js::ArrayBuffer",
        promiseResult: {
            kind: "data",
            cpp: "",
            dataType: { kind: "arraybuffer" },
        },
    };
}
