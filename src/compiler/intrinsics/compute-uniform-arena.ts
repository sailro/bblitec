import type ts from "typescript";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import { isGpuBufferSourceType } from "./storage-buffer.js";
import {
    compileUniformBufferLabel,
    type UniformBufferIntrinsicContext,
} from "./uniform-buffer.js";

export function compileComputeUniformArenaIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "createComputeUniformArena",
            "getComputeUniformSlotOffset",
            "updateComputeUniformSlot",
        ].includes(name)
    )
        return undefined;
    if (name === "createComputeUniformArena") {
        context.expectArgumentCount(call, 3, 4);
        context.reachFeature("compute:task", call);
        context.reachFeature("compute:uniform-buffer", call);
        context.reachFeature("compute:uniform-arena", call);
        const task = context.compileValue(argumentAt(call, 0));
        context.expectKind(task, "compute-task", call);
        const length = context.compileNumber(argumentAt(call, 1)),
            count = context.compileNumber(argumentAt(call, 2));
        const label = compileUniformBufferLabel(context, call.arguments[3]);
        return {
            kind: "compute-uniform-arena",
            dataType: { kind: "handle", handle: "compute-uniform-arena" },
            cpp: `bbl::create_compute_uniform_arena(${task.cpp}, ${length}, ${count}, ${label})`,
        };
    }
    const update = name === "updateComputeUniformSlot";
    context.expectArgumentCount(call, update ? 3 : 2, update ? 4 : 2);
    const arena = context.compileValue(argumentAt(call, 0));
    context.expectKind(arena, "compute-uniform-arena", call);
    const slot = context.compileNumber(argumentAt(call, 1));
    if (!update)
        return {
            kind: "number",
            cpp: `bbl::compute_uniform_slot_offset(${arena.cpp}, ${slot})`,
        };
    const sourceExpression = argumentAt(call, 2),
        value = context.compileValue(sourceExpression),
        type = value.dataType;
    if (
        !isGpuBufferSourceType(type) ||
        type?.kind === "number" ||
        type?.kind === "union"
    )
        return context.fail(
            sourceExpression,
            "Uniform slot updates require ArrayBuffer views.",
        );
    const source = context.pinValueToTemporary(
        value,
        "uniform_slot_source",
        sourceExpression,
    );
    const offset = call.arguments[3]
        ? context.compileNumber(call.arguments[3])
        : "0.0";
    return {
        kind: "void",
        cpp: `bbl::update_compute_uniform_slot(${arena.cpp}, ${slot}, bbl::storage_buffer_source(${source.cpp}).bytes, ${offset})`,
    };
}
