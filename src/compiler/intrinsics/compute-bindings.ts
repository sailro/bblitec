import type ts from "typescript";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import { stringLiteral } from "../../cpp-literals.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
    type RetainedOption,
} from "./retained-options.js";
import type { UniformBufferIntrinsicContext } from "./uniform-buffer.js";

export function compileComputeBindingsIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        name !== "createComputeBindingSet" &&
        name !== "disposeComputeBindingSet"
    )
        return undefined;
    context.reachFeature("compute:bindings", call);
    if (name === "disposeComputeBindingSet") {
        context.expectArgumentCount(call, 1, 1);
        const bindings = context.compileValue(argumentAt(call, 0));
        context.expectKind(bindings, "compute-binding-set", call);
        return {
            kind: "void",
            cpp: `bbl::dispose_compute_binding_set(${bindings.cpp})`,
        };
    }
    context.expectArgumentCount(call, 2, 2);
    const shaderValue = context.compileValue(argumentAt(call, 0));
    context.expectKind(shaderValue, "compute-shader", call);
    const shader = context.bindings.pinValueToTemporary(
        shaderValue,
        "binding_shader",
        call,
    );
    const site = argumentAt(call, 1),
        fields = retainedOptions(context, context.compileValue(site), site);
    const resources = context.allocateTemporaryCppName("compute_resources");
    context.emit(`bbl::ComputeBindingResources ${resources};`);
    function assign(member: RetainedOption, destination: string): void {
        const kind =
            member.type?.kind === "handle"
                ? member.type.handle
                : member.value?.kind;
        if (kind === "uniform-buffer" || kind === "storage-buffer") {
            context.emit(
                `${destination} = bbl::ComputeBufferRange{bbl::compute_buffer_reference(${member.cpp}), {}, {}};`,
            );
            return;
        }
        if (
            kind === "compute-texture-resource" ||
            kind === "compute-sampler" ||
            kind === "compute-storage-texture"
        ) {
            context.emit(`${destination} = ${member.cpp};`);
            return;
        }
        if (member.type?.kind === "struct" || member.value?.kind === "record") {
            const value: Value = member.value ?? {
                kind: "data",
                cpp: member.cpp,
                dataType: member.type!,
            };
            const range = context.allocateTemporaryCppName("compute_range");
            context.emit(`bbl::ComputeBufferRange ${range};`);
            for (const field of retainedOptions(context, value, site))
                emitPresentOption(context, field, (part) => {
                    if (part.name === "buffer") {
                        const type =
                            part.type?.kind === "handle"
                                ? part.type.handle
                                : part.value?.kind;
                        if (
                            type === "uniform-buffer" ||
                            type === "storage-buffer"
                        )
                            context.emit(
                                `${range}.buffer = bbl::compute_buffer_reference(${part.cpp});`,
                            );
                        else if (
                            part.type?.kind === "struct" ||
                            part.value?.kind === "record"
                        )
                            context.fail(
                                site,
                                "Nested compute buffer wrappers are not supported.",
                            );
                    } else if (part.name === "offset" || part.name === "size") {
                        emitScalarOption(
                            context,
                            part,
                            "number",
                            `${range}.${part.name}`,
                            site,
                        );
                    } else
                        context.fail(
                            site,
                            `Unrepresented compute buffer range field ${part.name}.`,
                        );
                });
            context.emit(`${destination} = ${range};`);
            return;
        }
        if (
            ["void", "json-null", "number", "string", "boolean"].includes(
                member.value?.kind ?? member.type?.kind ?? "",
            )
        )
            return;
        context.fail(
            site,
            `Unrepresented compute binding resource ${member.name}.`,
        );
    }
    for (const field of fields) {
        if (field.optionalProperty)
            context.fail(
                site,
                "Compute binding resource records require known own-property presence.",
            );
        const destination = `${resources}[${stringLiteral(field.name)}]`;
        // Own-property presence is independent of the source value being undefined.
        context.emit(`${destination} = std::monostate{};`);
        emitPresentOption(context, field, (member) =>
            assign(member, destination),
        );
    }
    return {
        kind: "compute-binding-set",
        dataType: { kind: "handle", handle: "compute-binding-set" },
        cpp: `bbl::create_compute_binding_set(${shader.cpp}, ${resources})`,
        ...(shader.engineCpp ? { engineCpp: shader.engineCpp } : {}),
    };
}
