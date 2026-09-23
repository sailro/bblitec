import type ts from "typescript";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
} from "./retained-options.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";

function dispatchSize(
    context: UniformBufferIntrinsicContext,
    value: Value,
    site: ts.Expression,
): string {
    const fields = retainedOptions(context, value, site),
        target = context.allocateTemporaryCppName("compute_dispatch_size");
    const x = fields.find((field) => field.name === "x");
    if (!x || x.present || x.type?.kind === "optional")
        return context.fail(
            site,
            "Compute dispatch size requires a present x dimension.",
        );
    context.emit(`bbl::ComputeDispatchSize ${target};`);
    for (const field of fields)
        emitPresentOption(context, field, (member) => {
            if (!["x", "y", "z"].includes(member.name))
                return context.fail(
                    site,
                    `Unrepresented compute dimension ${member.name}.`,
                );
            emitScalarOption(
                context,
                member,
                "number",
                `${target}.${member.name}`,
                site,
            );
        });
    return target;
}
export function compileComputeDispatchIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "createComputeDispatch",
            "setComputeDispatchSize",
            "setComputeDispatchDynamicOffset",
        ].includes(name)
    )
        return undefined;
    context.reachFeature("compute:dispatch", call);
    context.reachFeature("compute:shader", call);
    context.reachFeature("compute:bindings", call);
    if (name === "setComputeDispatchDynamicOffset") {
        context.expectArgumentCount(call, 3, 3);
        const dispatch = context.compileValue(argumentAt(call, 0)),
            binding = context.compileValue(argumentAt(call, 1)),
            offset = context.compileValue(argumentAt(call, 2));
        context.expectKind(dispatch, "compute-dispatch", call);
        context.expectKind(binding, "string", call);
        context.expectKind(offset, "number", call);
        return {
            kind: "void",
            cpp: `bbl::set_compute_dispatch_dynamic_offset(${dispatch.cpp}, ${binding.cpp}, ${offset.cpp})`,
        };
    }
    if (name === "setComputeDispatchSize") {
        context.expectArgumentCount(call, 2, 2);
        const dispatch = context.compileValue(argumentAt(call, 0));
        context.expectKind(dispatch, "compute-dispatch", call);
        const site = argumentAt(call, 1),
            size = dispatchSize(context, context.compileValue(site), site);
        return {
            kind: "void",
            cpp: `bbl::set_compute_dispatch_size(${dispatch.cpp}, ${size})`,
        };
    }
    context.expectArgumentCount(call, 3, 3);
    const shader = context.compileValue(argumentAt(call, 0)),
        bindings = context.compileValue(argumentAt(call, 1));
    context.expectKind(shader, "compute-shader", call);
    context.expectKind(bindings, "compute-binding-set", call);
    const site = argumentAt(call, 2),
        fields = retainedOptions(context, context.compileValue(site), site),
        options = context.allocateTemporaryCppName("compute_dispatch_options");
    const size = fields.find((field) => field.name === "size");
    if (!size || size.present || size.type?.kind === "optional")
        return context.fail(
            site,
            "Compute dispatch options require a present size record.",
        );
    const sizeValue: Value | undefined =
        size.value ??
        (size.type
            ? { kind: "data", cpp: size.cpp, dataType: size.type }
            : undefined);
    if (!sizeValue)
        return context.fail(
            site,
            "Compute dispatch size requires a retained record.",
        );
    const dimensions = dispatchSize(context, sizeValue, site);
    context.emit(
        `bbl::ComputeDispatchOptions ${options}; ${options}.size = ${dimensions};`,
    );
    for (const field of fields) {
        if (field.name === "size") continue;
        if (field.name !== "enabled")
            return context.fail(
                site,
                `Unrepresented compute dispatch option ${field.name}.`,
            );
        emitPresentOption(context, field, (member) =>
            emitScalarOption(
                context,
                member,
                "boolean",
                `${options}.enabled`,
                site,
            ),
        );
    }
    return {
        kind: "compute-dispatch",
        dataType: { kind: "handle", handle: "compute-dispatch" },
        ...(shader.engineCpp ? { engineCpp: shader.engineCpp } : {}),
        cpp: `bbl::create_compute_dispatch(${shader.cpp}, ${bindings.cpp}, ${options})`,
    };
}
