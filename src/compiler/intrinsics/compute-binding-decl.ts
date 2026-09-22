import type ts from "typescript";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import { computeBindingFactories } from "../../lowering/compute-binding-decl-lowerer.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
} from "./retained-options.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";

export function compileComputeBindingDeclIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    const factory = computeBindingFactories[name];
    if (!factory || name.startsWith("_")) return undefined;
    context.expectArgumentCount(call, 2, 2);
    context.reachFeature("compute:binding-decl", call);
    const label = context.compileValue(argumentAt(call, 0));
    context.expectKind(label, "string", call);
    const labelCpp = context.allocateTemporaryCppName("binding_name");
    context.emit(`const std::string ${labelCpp} = ${label.cpp};`);
    const optionsExpression = argumentAt(call, 1),
        value = context.compileValue(optionsExpression);
    const fields = retainedOptions(context, value, optionsExpression);
    for (const key of ["group", "binding"])
        if (
            !fields.some(
                (field) =>
                    field.name === key &&
                    field.type?.kind === "number" &&
                    !field.present,
            )
        )
            context.fail(
                optionsExpression,
                `Compute binding options require a present numeric ${key}.`,
            );
    const options = context.allocateTemporaryCppName("binding_options");
    context.emit(`bbl::ComputeBindingOptions ${options};`);
    const numeric: Record<string, string> = {
        group: "group",
        binding: "binding",
        minBindingSize: "min_binding_size",
    };
    const boolean: Record<string, string> = {
        dynamicOffset: "dynamic_offset",
        multisampled: "multisampled",
    };
    const strings: Record<string, string> = {
        access: "access",
        sampleType: "sample_type",
        type: "type",
        format: "format",
        viewDimension: "view_dimension",
    };
    for (const field of fields)
        emitPresentOption(context, field, (member) => {
            const cpp =
                numeric[member.name] ??
                boolean[member.name] ??
                strings[member.name];
            if (!cpp)
                return context.fail(
                    optionsExpression,
                    `Unrepresented compute binding option ${member.name}.`,
                );
            emitScalarOption(
                context,
                member,
                numeric[member.name]
                    ? "number"
                    : boolean[member.name]
                      ? "boolean"
                      : "string",
                `${options}.${cpp}`,
                optionsExpression,
            );
        });
    return {
        kind: "compute-binding-decl",
        dataType: { kind: "handle", handle: "compute-binding-decl" },
        cpp: `bbl::${factory.cpp}(${labelCpp}, ${options})`,
    };
}
